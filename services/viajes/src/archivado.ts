// Tarea programada de archivado nocturno del Servicio de Viajes (Iteración 2, UC-5, P2.C3):
// - Cron configurable de 5 campos en UTC (por defecto '0 3 * * *', 03:00 UTC).
// - Lock distribuido en PostgreSQL (pg_try_advisory_lock) para correr de forma segura en
//   múltiples instancias sin repetir el archivado y responder 409 si ya está corriendo.
// - Archiva viajes cuya última reserva ya terminó, publica ViajeActualizado (origenCambio
//   'archivado') por cada reserva en la misma transacción e invalida la cache del panel.
import {
  crearEvento,
  guardarEnOutbox,
  validadorEventos,
  type Logger,
  type Pool,
  type Region,
  type ValidadorEventos,
} from '@trotamundos/comun';
import type { CachePanel } from './cache.ts';
import { construirDatosViajeActualizado, type ResultadoArchivado } from './modelo.ts';
import * as repositorio from './repositorio.ts';

/** Clave numérica del advisory lock de PostgreSQL para la tarea de archivado. */
export const LOCK_ARCHIVADO = 7_412_002;

export class ErrorArchivadoEnEjecucion extends Error {
  constructor() {
    super('La tarea de archivado ya está corriendo en otra ejecución.');
    this.name = 'ErrorArchivadoEnEjecucion';
  }
}

export interface CronAnalizado {
  minutos: ReadonlySet<number>;
  horas: ReadonlySet<number>;
  diasMes: ReadonlySet<number>;
  meses: ReadonlySet<number>;
  diasSemana: ReadonlySet<number>;
}

function parsearCampoCron(
  campo: string,
  minimo: number,
  maximo: number,
  normalizar?: (valor: number) => number,
): Set<number> {
  const resultado = new Set<number>();
  const partes = campo.split(',');
  for (const parte of partes) {
    const [rangoTexto, pasoTexto, extra] = parte.split('/');
    if (!rangoTexto || extra !== undefined) {
      throw new Error(`Segmento cron inválido: ${parte}`);
    }
    const paso = pasoTexto === undefined ? 1 : Number(pasoTexto);
    if (!Number.isInteger(paso) || paso <= 0) {
      throw new Error(`Paso cron inválido: ${parte}`);
    }

    let inicio: number;
    let fin: number;
    if (rangoTexto === '*') {
      inicio = minimo;
      fin = maximo;
    } else if (rangoTexto.includes('-')) {
      const [aTexto, bTexto, extraRango] = rangoTexto.split('-');
      if (!aTexto || !bTexto || extraRango !== undefined) {
        throw new Error(`Rango cron inválido: ${parte}`);
      }
      inicio = Number(aTexto);
      fin = Number(bTexto);
      if (!Number.isInteger(inicio) || !Number.isInteger(fin) || inicio > fin) {
        throw new Error(`Rango cron inválido: ${parte}`);
      }
    } else {
      inicio = Number(rangoTexto);
      if (!Number.isInteger(inicio)) {
        throw new Error(`Valor cron inválido: ${parte}`);
      }
      fin = pasoTexto === undefined ? inicio : maximo;
    }

    if (inicio < minimo || fin > maximo) {
      throw new Error(`Valor cron fuera de rango [${minimo}, ${maximo}]: ${parte}`);
    }

    for (let v = inicio; v <= fin; v += paso) {
      resultado.add(normalizar ? normalizar(v) : v);
    }
  }
  if (resultado.size === 0) {
    throw new Error(`Campo cron vacío: ${campo}`);
  }
  return resultado;
}

/** Analiza una expresión cron estándar de 5 campos (minuto hora día-mes mes día-semana, en UTC). */
export function parsearCron(expresion: string): CronAnalizado {
  const campos = expresion.trim().split(/\s+/);
  if (campos.length !== 5) {
    throw new Error('La expresión cron debe tener exactamente 5 campos.');
  }
  const [min, hora, diaMes, mes, diaSemana] = campos;
  if (!min || !hora || !diaMes || !mes || !diaSemana) {
    throw new Error('La expresión cron tiene campos vacíos.');
  }
  return {
    minutos: parsearCampoCron(min, 0, 59),
    horas: parsearCampoCron(hora, 0, 23),
    diasMes: parsearCampoCron(diaMes, 1, 31),
    meses: parsearCampoCron(mes, 1, 12),
    // En cron, domingo puede escribirse como 0 o 7.
    diasSemana: parsearCampoCron(diaSemana, 0, 7, (v) => (v === 7 ? 0 : v)),
  };
}

export function esCronValido(expresion: string): boolean {
  try {
    parsearCron(expresion);
    return true;
  } catch {
    return false;
  }
}

/** Comprueba si una fecha (UTC) coincide con la expresión cron analizada. */
export function coincideCron(cron: CronAnalizado, fecha: Date): boolean {
  return (
    cron.minutos.has(fecha.getUTCMinutes()) &&
    cron.horas.has(fecha.getUTCHours()) &&
    cron.diasMes.has(fecha.getUTCDate()) &&
    cron.meses.has(fecha.getUTCMonth() + 1) &&
    cron.diasSemana.has(fecha.getUTCDay())
  );
}

function claveMinutoUtc(fecha: Date): string {
  return `${fecha.getUTCFullYear()}-${fecha.getUTCMonth() + 1}-${fecha.getUTCDate()}T${fecha.getUTCHours()}:${fecha.getUTCMinutes()}`;
}

export interface OpcionesTareaArchivado {
  pool: Pool;
  cache: CachePanel;
  region: Region;
  logger: Logger;
  /** Expresión cron en UTC (por defecto '0 3 * * *': todos los días a las 03:00 UTC). */
  cron?: string;
  validador?: ValidadorEventos;
  ahora?: () => number;
  /** Frecuencia con la que se evalúa si llegó el minuto del cron (por defecto 30 s). */
  intervaloRevisionMs?: number;
  /** Gancho opcional solo para pruebas de concurrencia mientras el lock está adquirido. */
  ganchoDuranteLock?: () => Promise<void>;
}

export interface TareaArchivado {
  /**
   * Ejecuta una corrida de archivado bajo lock distribuido en PostgreSQL.
   * Si el lock ya está tomado por otra instancia/ejecución:
   * - con `lanzarSiOcupado: true` lanza `ErrorArchivadoEnEjecucion` (para HTTP 409);
   * - con `lanzarSiOcupado: false` (default) omite la corrida y devuelve `null`.
   */
  ejecutar(opciones?: { lanzarSiOcupado?: boolean }): Promise<ResultadoArchivado | null>;
  /** Evalúa el reloj actual contra el cron y ejecuta si corresponde (sin repetir en el mismo minuto). */
  evaluarProgramacion(): Promise<ResultadoArchivado | null>;
  iniciar(): void;
  detener(): Promise<void>;
}

export function crearTareaArchivado(opciones: OpcionesTareaArchivado): TareaArchivado {
  const { pool, cache, region, logger } = opciones;
  const validador = opciones.validador ?? validadorEventos();
  const ahora = opciones.ahora ?? Date.now;
  const cronTexto = opciones.cron ?? '0 3 * * *';
  const cron = parsearCron(cronTexto);
  const intervaloRevisionMs = opciones.intervaloRevisionMs ?? 30_000;

  let timer: ReturnType<typeof setInterval> | undefined;
  let ultimoMinutoEjecutado: string | undefined;
  let enCurso = new Set<Promise<unknown>>();

  async function ejecutarInterno(lanzarSiOcupado: boolean): Promise<ResultadoArchivado | null> {
    const cliente = await pool.connect();
    let lockAdquirido = false;

    try {
      const resLock = await cliente.query<{ adquirido: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS adquirido',
        [LOCK_ARCHIVADO],
      );
      lockAdquirido = resLock.rows[0]?.adquirido === true;
      if (!lockAdquirido) {
        if (lanzarSiOcupado) {
          throw new ErrorArchivadoEnEjecucion();
        }
        logger.info('tarea de archivado ya en ejecución en otra instancia; se omite');
        return null;
      }

      if (opciones.ganchoDuranteLock) {
        await opciones.ganchoDuranteLock();
      }

      const ahoraDate = new Date(ahora());
      let viajesArchivados = 0;
      let reservasArchivadas = 0;
      const usuariosAfectados = new Set<string>();

      await cliente.query('BEGIN');
      try {
        const candidatos = await repositorio.listarViajesTerminadosParaArchivar(cliente, ahoraDate);
        const porUsuario = new Map<string, string[]>();
        for (const viaje of candidatos) {
          const lista = porUsuario.get(viaje.usuarioId) ?? [];
          lista.push(viaje.viajeId);
          porUsuario.set(viaje.usuarioId, lista);
        }

        // Bloqueamos por usuario en orden lexicográfico estable para serializar con escrituras
        // concurrentes sin riesgo de deadlock.
        const usuariosOrdenados = [...porUsuario.keys()].sort();
        for (const usuarioId of usuariosOrdenados) {
          await repositorio.bloquearUsuarioParaAgrupacion(cliente, usuarioId);
          const viajeIds = porUsuario.get(usuarioId) ?? [];
          for (const viajeId of viajeIds) {
            const archivado = await repositorio.archivarViajeYReservas(cliente, viajeId, ahoraDate);
            if (!archivado) continue;

            viajesArchivados += 1;
            usuariosAfectados.add(usuarioId);
            for (const reserva of archivado.reservas) {
              reservasArchivadas += 1;
              await guardarEnOutbox(
                cliente,
                crearEvento(
                  'ViajeActualizado',
                  construirDatosViajeActualizado(reserva, 'archivado'),
                  region,
                ),
                validador,
              );
            }
          }
        }

        await cliente.query('COMMIT');
      } catch (err) {
        await cliente.query('ROLLBACK').catch(() => undefined);
        throw err;
      }

      // Invalidamos la cache del panel de cada usuario afectado tras el COMMIT.
      for (const usuarioId of usuariosAfectados) {
        await cache.invalidar(usuarioId);
      }

      const resultado: ResultadoArchivado = {
        viajesArchivados,
        reservasArchivadas,
        ejecutadoEn: ahoraDate.toISOString(),
      };
      logger.info(
        {
          viajesArchivados: resultado.viajesArchivados,
          reservasArchivadas: resultado.reservasArchivadas,
          usuariosAfectados: usuariosAfectados.size,
        },
        'tarea de archivado completada',
      );
      return resultado;
    } finally {
      if (lockAdquirido) {
        await cliente
          .query('SELECT pg_advisory_unlock($1)', [LOCK_ARCHIVADO])
          .catch((err: unknown) => {
            logger.warn({ err }, 'no se pudo liberar el advisory lock de archivado');
          });
      }
      cliente.release();
    }
  }

  function rastrear<T>(promesa: Promise<T>): Promise<T> {
    enCurso.add(promesa);
    return promesa.finally(() => {
      enCurso.delete(promesa);
    });
  }

  return {
    ejecutar(opts = {}) {
      return rastrear(ejecutarInterno(opts.lanzarSiOcupado ?? false));
    },

    async evaluarProgramacion() {
      const fecha = new Date(ahora());
      if (!coincideCron(cron, fecha)) return null;
      const minuto = claveMinutoUtc(fecha);
      if (ultimoMinutoEjecutado === minuto) return null;
      ultimoMinutoEjecutado = minuto;
      return await this.ejecutar({ lanzarSiOcupado: false });
    },

    iniciar() {
      if (timer) return;
      logger.info({ cron: cronTexto }, 'programador de tarea de archivado iniciado');
      timer = setInterval(() => {
        void this.evaluarProgramacion().catch((err: unknown) => {
          logger.warn({ err }, 'error al ejecutar la tarea programada de archivado');
        });
      }, intervaloRevisionMs);
      timer.unref();
    },

    async detener() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (enCurso.size > 0) {
        await Promise.allSettled([...enCurso]);
      }
      enCurso = new Set();
    },
  };
}
