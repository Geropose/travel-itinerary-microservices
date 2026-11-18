// Procesadores de correo y Filtro de remitentes (Iteración 2, Iteración 5 y ADR-009):
// - Consumen buzones de `correo.buzones-a-revisar` con N workers en paralelo sin duplicar trabajo.
// - Mantienen la whitelist al día consumiendo `FiltrosActualizados` de Usuarios (idempotente).
// - Aplican el filtro de remitentes, extraen reservas (JSON-LD o reglas de texto), publican
//   `ReservaDetectada` por outbox y registran los viajes no interpretables en `no_procesados`.
import {
  crearEvento,
  enTransaccion,
  validadorEventos,
  type Broker,
  type Logger,
  type Pool,
  type Region,
  type ValidadorEventos,
} from '@trotamundos/comun';
import { ErrorProveedorCorreo, type MensajeCorreo } from './adaptadores/tipos.ts';
import type { ColaBuzones, TrabajoRevisionBuzon } from './cola.ts';
import { extraerReservaDeCorreo, TABLA_PROVEEDORES_DEFECTO } from './extractor.ts';
import * as repositorio from './repositorio.ts';
import { ErrorCuentaNoEncontrada, ErrorCuentaSinPermiso, type GestorTokens } from './tokens.ts';

export interface FiltrosActualizadosDatos {
  usuarioId: string;
  remitentesPermitidos: string[];
  filtrosActivos: boolean;
}

export interface OpcionesProcesadorCorreo {
  pool: Pool;
  region: Region;
  gestorTokens: GestorTokens;
  cola?: ColaBuzones;
  broker?: Broker;
  logger: Logger;
  cantidadProcesadores: number;
  concurrenciaLectura?: number;
  tablaProveedores?: Readonly<Record<string, string>>;
  validador?: ValidadorEventos;
  ahora?: () => number;
}

/**
 * Evalúa si un remitente pasa el Filtro de remitentes del usuario (Iteración 5, UC-2).
 * Soporta direcciones completas (`reservas@aerolinea.com`) o dominios (`@aerolinea.com`).
 */
export function cumpleFiltroRemitente(
  remitente: string,
  filtro: repositorio.FiltroRemitentesUsuario | null,
): boolean {
  if (!filtro || !filtro.filtrosActivos) return true;
  const email = remitente.trim().toLowerCase();
  if (!email) return false;

  for (const reglaRaw of filtro.remitentesPermitidos) {
    const regla = reglaRaw.trim().toLowerCase();
    if (!regla) continue;
    if (regla.startsWith('@')) {
      if (email.endsWith(regla)) return true;
    } else if (email === regla) {
      return true;
    }
  }
  return false;
}

export interface ProcesadorCorreo {
  procesarTrabajo(trabajo: TrabajoRevisionBuzon): Promise<void>;
  iniciar(): Promise<void>;
  detener(): Promise<void>;
}

const TAMANO_LOTE_GUARDADO = 50;

async function mapearConConcurrencia<T, R>(
  items: readonly T[],
  concurrencia: number,
  tarea: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const resultados = new Array<R>(items.length);
  let siguiente = 0;
  const cantWorkers = Math.min(Math.max(1, concurrencia), items.length);

  await Promise.all(
    Array.from({ length: cantWorkers }, async () => {
      while (siguiente < items.length) {
        const indice = siguiente++;
        const item = items[indice];
        if (item !== undefined) {
          resultados[indice] = await tarea(item);
        }
      }
    }),
  );
  return resultados;
}

export function crearProcesadorCorreo(opciones: OpcionesProcesadorCorreo): ProcesadorCorreo {
  const {
    pool,
    region,
    gestorTokens,
    cola,
    broker,
    logger,
    cantidadProcesadores,
    concurrenciaLectura = 5,
    tablaProveedores = TABLA_PROVEEDORES_DEFECTO,
  } = opciones;
  const validador = opciones.validador ?? validadorEventos();
  const ahora = opciones.ahora ?? Date.now;

  // Evita que dos workers de la misma instancia avancen el cursor del mismo buzón fuera de orden.
  const enColaPorCuenta = new Map<string, Promise<void>>();
  let iniciado = false;
  let deteniendo = false;

  function encadenarPorCuenta(cuentaId: string, tarea: () => Promise<void>): Promise<void> {
    const previa = enColaPorCuenta.get(cuentaId) ?? Promise.resolve();
    const siguiente = previa.then(tarea, tarea).finally(() => {
      if (enColaPorCuenta.get(cuentaId) === siguiente) {
        enColaPorCuenta.delete(cuentaId);
      }
    });
    enColaPorCuenta.set(cuentaId, siguiente);
    return siguiente;
  }

  function prepararResultadoCorreo(
    cuenta: repositorio.CuentaParaProcesar,
    filtro: repositorio.FiltroRemitentesUsuario | null,
    correo: MensajeCorreo,
    fechaActual: Date,
  ): repositorio.ResultadoCorreoProcesado {
    const base: repositorio.ResultadoCorreoProcesado = {
      cuentaId: cuenta.id,
      usuarioId: cuenta.usuarioId,
      proveedorCorreo: cuenta.proveedor,
      correoId: correo.id,
      remitente: correo.remitente,
      asunto: correo.asunto,
      recibidoEn: correo.recibidoEn,
      ahora: fechaActual,
    };

    if (!cumpleFiltroRemitente(correo.remitente, filtro)) return base;

    const extraccion = extraerReservaDeCorreo(correo, cuenta.usuarioId, tablaProveedores);
    if (extraccion.tipo === 'reserva') {
      const sobre = crearEvento('ReservaDetectada', extraccion.datos, region);
      // Validación estricta contra specs/schemas/ReservaDetectada.json antes del outbox.
      validador.validar(sobre);
      return { ...base, evento: sobre, validador };
    }
    if (extraccion.tipo === 'no-procesado') {
      return { ...base, noProcesado: { motivo: extraccion.motivo, detalle: extraccion.detalle } };
    }
    // Correos que no son de viaje: solo se marca el ID para no releerlos ni guardar contenido.
    return base;
  }

  async function procesarCuenta(trabajo: TrabajoRevisionBuzon): Promise<void> {
    if (deteniendo) return;
    const cuenta = await repositorio.obtenerCuentaParaProcesar(pool, trabajo.cuentaId);
    if (!cuenta || cuenta.estado !== 'conectada') return;

    const filtro = await repositorio.obtenerFiltroRemitentes(pool, cuenta.usuarioId);

    try {
      let idsCandidatos: string[];
      let nuevoCursor: string | undefined;
      let cursorExpirado = false;

      if (trabajo.push?.mensajeIds && trabajo.push.mensajeIds.length > 0) {
        idsCandidatos = [...new Set(trabajo.push.mensajeIds)];
      } else {
        const lista = await gestorTokens.listarNuevosCuenta(cuenta.id, {
          cursor: cuenta.ultimoCursor,
          ...(cuenta.ultimaRevision ? { fechaDesde: cuenta.ultimaRevision } : {}),
        });
        idsCandidatos = lista.mensajes.map((m) => m.id);
        nuevoCursor = lista.nuevoCursor;
        cursorExpirado = Boolean(lista.cursorExpirado);
      }

      const pendientes = [
        ...new Set(await repositorio.filtrarCorreosPendientes(pool, cuenta.id, idsCandidatos)),
      ];
      const tamanoBloque = Math.max(concurrenciaLectura, TAMANO_LOTE_GUARDADO);

      // Leemos y persistimos en lotes acotados: reduce contención de bloqueos y commits sin perder progreso ante 429.
      for (let i = 0; i < pendientes.length; i += tamanoBloque) {
        if (deteniendo) break;
        const bloqueIds = pendientes.slice(i, i + tamanoBloque);
        const correos = await gestorTokens.ejecutarConToken(cuenta.id, (adaptador, accessToken) =>
          mapearConConcurrencia(bloqueIds, concurrenciaLectura, (msgId) =>
            adaptador.leerMensaje(accessToken, msgId),
          ),
        );
        if (deteniendo) break;

        const fechaActual = new Date(ahora());
        const resultados = correos.map((correo) => {
          if (!nuevoCursor && correo.cursor) {
            nuevoCursor = correo.cursor;
          }
          return prepararResultadoCorreo(cuenta, filtro, correo, fechaActual);
        });

        const reclamados = await enTransaccion(pool, (db) =>
          repositorio.guardarResultadosCorreosProcesados(db, resultados),
        );
        const reclamadosSet = new Set(reclamados);
        for (const resultado of resultados) {
          if (resultado.evento && reclamadosSet.has(resultado.correoId)) {
            logger.info(
              {
                cuentaId: cuenta.id,
                correoId: resultado.correoId,
                proveedor: resultado.evento.datos.proveedor,
                tipoReserva: resultado.evento.datos.tipoReserva,
              },
              'reserva detectada y guardada en outbox',
            );
          }
        }
      }

      await enTransaccion(pool, (db) =>
        repositorio.actualizarCursorRevision(db, {
          cuentaId: cuenta.id,
          ...(nuevoCursor ? { nuevoCursor } : {}),
          cursorExpirado,
          ahora: new Date(ahora()),
        }),
      );
    } catch (err) {
      if (err instanceof ErrorCuentaSinPermiso || err instanceof ErrorCuentaNoEncontrada) {
        logger.warn(
          { cuentaId: cuenta.id },
          'procesamiento omitido por cuenta inactiva o removida',
        );
        return;
      }
      if (err instanceof ErrorProveedorCorreo && err.codigo === 'limite-cuota') {
        const fecha = new Date(ahora());
        // Marca prioridad para reanudar ni bien venza el bloqueo_hasta registrado por 429.
        await repositorio.programarRevisionDiferida(pool, cuenta.id, fecha, fecha);
        logger.warn({ cuentaId: cuenta.id }, 'revisión pospuesta tras 429 del proveedor');
        return;
      }
      throw err;
    }
  }

  return {
    procesarTrabajo(trabajo) {
      return encadenarPorCuenta(trabajo.cuentaId, () => procesarCuenta(trabajo));
    },

    async iniciar() {
      if (iniciado) return;
      iniciado = true;

      if (broker) {
        await broker.consumir<FiltrosActualizadosDatos>({
          tipo: 'FiltrosActualizados',
          pool,
          manejar: async (evento, cliente) => {
            await repositorio.guardarFiltroRemitentes(cliente, {
              usuarioId: evento.datos.usuarioId,
              remitentesPermitidos: evento.datos.remitentesPermitidos,
              filtrosActivos: evento.datos.filtrosActivos,
              actualizadoEn: new Date(evento.ocurridoEn),
            });
          },
        });
      }

      if (cola) {
        for (let i = 0; i < cantidadProcesadores; i++) {
          await cola.consumir({
            prefetch: 1,
            manejar: (trabajo) => this.procesarTrabajo(trabajo),
          });
        }
      }

      logger.info({ cantidadProcesadores }, 'procesadores de correo iniciados');
    },

    async detener() {
      deteniendo = true;
      await Promise.allSettled([...enColaPorCuenta.values()]);
    },
  };
}
