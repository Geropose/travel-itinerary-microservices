// Examinador de Correo (Iteración 2, ADR-009 y ADR-010):
// Decide qué buzones revisar según prioridad (nueva cuenta < 1 min > viaje próximo 5 min > resto
// 60 min), omite el polling periódico en cuentas con avisos push activos, respeta el backoff
// exponencial ante 429 y encola trabajos en `correo.buzones-a-revisar`.
import { randomUUID } from 'node:crypto';
import { enTransaccion, type Logger, type Pool } from '@trotamundos/comun';
import type { RegistroAdaptadores } from './adaptadores/registro.ts';
import type { ProveedorCorreo } from './adaptadores/tipos.ts';
import type { ClienteViajes } from './clientes.ts';
import type { ColaBuzones, OrigenRevision, TrabajoRevisionBuzon } from './cola.ts';
import * as repositorio from './repositorio.ts';

export interface IntervalosExaminador {
  /** Cada cuánto corre el ciclo del Examinador (ej. 30 s para cumplir < 1 min en nuevas). */
  cicloMs: number;
  /** Intervalo para usuarios con viaje en los próximos 7 días o en curso (por defecto 5 min). */
  viajeProximoMs: number;
  /** Intervalo para el resto de los usuarios (por defecto 60 min). */
  normalMs: number;
}

export interface ConfigBackoff429 {
  inicialMs: number;
  maxMs: number;
}

export interface OpcionesExaminador {
  pool: Pool;
  cola?: ColaBuzones;
  viajes?: ClienteViajes;
  adaptadores: RegistroAdaptadores;
  logger: Logger;
  intervalos: IntervalosExaminador;
  backoff429: ConfigBackoff429;
  ahora?: () => number;
}

export interface DecisionRevision {
  debeEncolar: boolean;
  origen?: OrigenRevision;
  prioridad?: 1 | 2 | 3;
}

/**
 * Clasifica una cuenta activa y sin backoff para saber si corresponde encolarla en este instante
 * y con qué prioridad (ADR-010).
 */
export function clasificarCuentaParaRevision(
  cuenta: repositorio.CuentaCandidataExaminador,
  usuariosConViajeProximo: ReadonlySet<string>,
  adaptadores: RegistroAdaptadores,
  intervalos: Pick<IntervalosExaminador, 'viajeProximoMs' | 'normalMs'>,
  ahoraMs: number,
): DecisionRevision {
  // 1) Prioridad máxima: cuenta recién conectada o revisión diferida tras 429 en el primer minuto.
  if (cuenta.revisionPrioritaria && cuenta.proximaRevision.getTime() <= ahoraMs) {
    return { debeEncolar: true, origen: 'cuenta-nueva', prioridad: 1 };
  }

  // 2) Buzones con suscripción push activa en proveedor con push no se consultan por intervalo.
  const adaptador = adaptadores.obtener(cuenta.proveedor);
  const soportaPush = adaptador?.soportaPush ?? false;
  if (soportaPush && cuenta.suscripcionId !== null) {
    return { debeEncolar: false };
  }

  // 3) Polling priorizado: 5 min con viaje próximo/en curso vs 60 min el resto.
  const tieneViajeProximo = usuariosConViajeProximo.has(cuenta.usuarioId);
  const intervaloMs = tieneViajeProximo ? intervalos.viajeProximoMs : intervalos.normalMs;
  const ultimoMs = cuenta.ultimoEncolado?.getTime();
  if (ultimoMs === undefined || ahoraMs - ultimoMs >= intervaloMs) {
    return {
      debeEncolar: true,
      origen: tieneViajeProximo ? 'viaje-proximo' : 'periodica',
      prioridad: tieneViajeProximo ? 2 : 3,
    };
  }

  return { debeEncolar: false };
}

export interface Examinador {
  /** Ejecuta una pasada de planificación y encola los buzones vencidos por prioridad. */
  ejecutarCiclo(): Promise<TrabajoRevisionBuzon[]>;
  /** Encola inmediatamente un buzón disparado por aviso push (o lo difiere si tiene 429 activo). */
  encolarPorPush(params: {
    cuentaId: string;
    usuarioId: string;
    proveedor: ProveedorCorreo;
    email: string;
    bloqueadoHasta: Date | null;
    push?: TrabajoRevisionBuzon['push'];
  }): Promise<{ encolado: boolean; diferidoHasta?: Date }>;
  registrarLimiteCuota(cuentaId: string, retryAfterSeg?: number): Promise<void>;
  limpiarLimiteCuota(cuentaId: string): Promise<void>;
  iniciar(): void;
  detener(): Promise<void>;
}

export function crearExaminador(opciones: OpcionesExaminador): Examinador {
  const { pool, cola, viajes, adaptadores, logger, intervalos, backoff429 } = opciones;
  const ahora = opciones.ahora ?? Date.now;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cicloActual: Promise<TrabajoRevisionBuzon[]> | undefined;

  async function ejecutarCicloInterno(): Promise<TrabajoRevisionBuzon[]> {
    if (!cola) return [];
    const ahoraMs = ahora();
    const ahoraDate = new Date(ahoraMs);
    const usuariosProximos = viajes
      ? await viajes.obtenerUsuariosConViajeProximo()
      : new Set<string>();

    const trabajos = await enTransaccion(pool, async (db) => {
      const candidatas = await repositorio.obtenerCuentasParaExaminar(db, ahoraDate);
      const seleccionadas: {
        cuenta: repositorio.CuentaCandidataExaminador;
        origen: OrigenRevision;
        prioridad: 1 | 2 | 3;
      }[] = [];

      for (const cuenta of candidatas) {
        const decision = clasificarCuentaParaRevision(
          cuenta,
          usuariosProximos,
          adaptadores,
          intervalos,
          ahoraMs,
        );
        if (decision.debeEncolar && decision.origen && decision.prioridad) {
          seleccionadas.push({
            cuenta,
            origen: decision.origen,
            prioridad: decision.prioridad,
          });
        }
      }

      if (seleccionadas.length === 0) return [];

      // Prioridad estricta: 1 (cuenta nueva) -> 2 (viaje próximo 5 min) -> 3 (normal 60 min).
      seleccionadas.sort((a, b) => {
        if (a.prioridad !== b.prioridad) return a.prioridad - b.prioridad;
        const tA = a.cuenta.ultimoEncolado?.getTime() ?? 0;
        const tB = b.cuenta.ultimoEncolado?.getTime() ?? 0;
        return tA - tB;
      });

      const encolados: TrabajoRevisionBuzon[] = seleccionadas.map(
        ({ cuenta, origen, prioridad }) => ({
          trabajoId: randomUUID(),
          cuentaId: cuenta.id,
          usuarioId: cuenta.usuarioId,
          proveedor: cuenta.proveedor,
          email: cuenta.email,
          origen,
          prioridad,
          creadoEn: ahoraDate.toISOString(),
        }),
      );

      for (const trabajo of encolados) {
        await cola.encolar(trabajo);
      }

      await repositorio.marcarCuentasEncoladas(
        db,
        seleccionadas.map((s) => s.cuenta.id),
        ahoraDate,
      );

      return encolados;
    });

    if (trabajos.length > 0) {
      logger.info({ cantidad: trabajos.length }, 'examinador encoló buzones para revisión');
    }
    return trabajos;
  }

  return {
    ejecutarCiclo() {
      if (!cicloActual) {
        cicloActual = ejecutarCicloInterno().finally(() => {
          cicloActual = undefined;
        });
      }
      return cicloActual;
    },

    async encolarPorPush(params) {
      if (!cola) throw new Error('Cola de buzones no configurada.');
      const ahoraMs = ahora();
      const ahoraDate = new Date(ahoraMs);

      if (params.bloqueadoHasta && params.bloqueadoHasta.getTime() > ahoraMs) {
        // El buzón está bajo backoff por 429: se programa prioridad máxima apenas venza el bloqueo.
        await repositorio.programarRevisionDiferida(
          pool,
          params.cuentaId,
          params.bloqueadoHasta,
          ahoraDate,
        );
        logger.warn(
          { cuentaId: params.cuentaId, hasta: params.bloqueadoHasta.toISOString() },
          'aviso push diferido por límite 429 vigente',
        );
        return { encolado: false, diferidoHasta: params.bloqueadoHasta };
      }

      const trabajo: TrabajoRevisionBuzon = {
        trabajoId: randomUUID(),
        cuentaId: params.cuentaId,
        usuarioId: params.usuarioId,
        proveedor: params.proveedor,
        email: params.email,
        origen: 'push',
        prioridad: 1,
        creadoEn: ahoraDate.toISOString(),
        ...(params.push ? { push: params.push } : {}),
      };
      await cola.encolar(trabajo);
      await repositorio.marcarCuentasEncoladas(pool, [params.cuentaId], ahoraDate);
      return { encolado: true };
    },

    async registrarLimiteCuota(cuentaId, retryAfterSeg) {
      const resultado = await enTransaccion(pool, (db) =>
        repositorio.registrarBackoff429(db, {
          cuentaId,
          baseMs: backoff429.inicialMs,
          maxMs: backoff429.maxMs,
          ...(retryAfterSeg !== undefined ? { retryAfterSeg } : {}),
          ahora: new Date(ahora()),
        }),
      );
      if (resultado) {
        logger.warn(
          {
            cuentaId,
            intentos429: resultado.intentos,
            esperaMs: resultado.esperaMs,
            bloqueadoHasta: resultado.bloqueadoHasta.toISOString(),
          },
          'límite de cuota 429 registrado con backoff exponencial',
        );
      }
    },

    async limpiarLimiteCuota(cuentaId) {
      await repositorio.limpiarBackoff429(pool, cuentaId, new Date(ahora()));
    },

    iniciar() {
      if (timer) return;
      void this.ejecutarCiclo().catch((err) =>
        logger.warn({ err }, 'falló pasada inicial del examinador'),
      );
      timer = setInterval(() => {
        void this.ejecutarCiclo().catch((err) =>
          logger.warn({ err }, 'falló pasada periódica del examinador'),
        );
      }, intervalos.cicloMs);
      timer.unref();
    },

    async detener() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (cicloActual) {
        await cicloActual.catch(() => undefined);
      }
    },
  };
}
