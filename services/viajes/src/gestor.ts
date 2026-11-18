// Gestor de viajes (Iteración 2, Iteración 6, ADR-002, ADR-016): incorpora y actualiza reservas,
// las agrupa por viaje y publica ViajeActualizado en el outbox dentro de la misma transacción.
import {
  contextoActual,
  crearEvento,
  guardarEnOutbox,
  validadorEventos,
  type ClienteDb,
  type Logger,
  type Region,
  type ValidadorEventos,
} from '@trotamundos/comun';
import {
  buscarViajeParaAgrupar,
  calcularResumenViaje,
  MARGEN_AGRUPACION_MS_DEFECTO,
} from './agrupacion.ts';
import {
  construirDatosViajeActualizado,
  type OrigenCambio,
  type Reserva,
  type ReservaActualizadaDatos,
  type ReservaDetectadaDatos,
} from './modelo.ts';
import * as repositorio from './repositorio.ts';

export interface OpcionesGestorViajes {
  region: Region;
  logger: Logger;
  validador?: ValidadorEventos;
  margenAgrupacionMs?: number;
  ahora?: () => number;
}

export type ResultadoReservaDetectada =
  | { accion: 'creada' | 'actualizada'; reserva: Reserva; viajeId: string; usuarioId: string }
  | { accion: 'conflicto-usuario'; reservaId: string; viajeId: string };

export type ResultadoReservaActualizada =
  | { accion: 'actualizada'; reserva: Reserva; viajeId: string; usuarioId: string }
  | { accion: 'ignorada' };

export interface GestorViajes {
  /** Guarda `ViajeActualizado` en el outbox dentro de la misma transacción del cambio. */
  publicarViajeActualizado(
    db: ClienteDb,
    reserva: Reserva,
    origenCambio: OrigenCambio,
  ): Promise<void>;

  /** Aplica `ReservaDetectada` (upsert por proveedor + numeroReserva y agrupación por fechas). */
  procesarReservaDetectada(
    db: ClienteDb,
    datos: ReservaDetectadaDatos,
  ): Promise<ResultadoReservaDetectada>;

  /** Aplica `ReservaActualizada` por proveedor + numeroReserva; ignora con log si no existe. */
  procesarReservaActualizada(
    db: ClienteDb,
    datos: ReservaActualizadaDatos,
  ): Promise<ResultadoReservaActualizada>;
}

function validarRangoFechas(inicio: string, fin: string): void {
  const iniMs = Date.parse(inicio);
  const finMs = Date.parse(fin);
  if (Number.isNaN(iniMs) || Number.isNaN(finMs) || finMs < iniMs) {
    throw new Error(`Rango de fechas inválido en reserva: inicio=${inicio}, fin=${fin}.`);
  }
}

export function crearGestorViajes(opciones: OpcionesGestorViajes): GestorViajes {
  const { region, logger } = opciones;
  const validador = opciones.validador ?? validadorEventos();
  const margenAgrupacionMs = opciones.margenAgrupacionMs ?? MARGEN_AGRUPACION_MS_DEFECTO;
  const ahora = opciones.ahora ?? Date.now;

  async function publicarViajeActualizado(
    db: ClienteDb,
    reserva: Reserva,
    origenCambio: OrigenCambio,
  ): Promise<void> {
    const sobre = crearEvento(
      'ViajeActualizado',
      construirDatosViajeActualizado(reserva, origenCambio),
      region,
    );
    await guardarEnOutbox(db, sobre, validador);
  }

  async function recalcularViaje(db: ClienteDb, viajeId: string, fechaActual: Date): Promise<void> {
    const reservas = await repositorio.listarReservasDeViaje(db, viajeId);
    if (reservas.length === 0) return;
    const resumen = calcularResumenViaje(reservas);
    await repositorio.actualizarResumenViaje(db, viajeId, resumen, fechaActual);
  }

  async function procesarReservaDetectada(
    db: ClienteDb,
    datos: ReservaDetectadaDatos,
  ): Promise<ResultadoReservaDetectada> {
    validarRangoFechas(datos.inicio, datos.fin);
    const fechaActual = new Date(ahora());

    // Serializamos operaciones del mismo usuario para evitar viajes duplicados al agrupar en paralelo.
    await repositorio.bloquearUsuarioParaAgrupacion(db, datos.usuarioId);

    const existente = await repositorio.buscarReservaPorClave(
      db,
      datos.proveedor,
      datos.numeroReserva,
      { paraActualizar: true },
    );

    if (existente) {
      if (existente.usuarioId !== datos.usuarioId) {
        logger.warn(
          {
            proveedor: datos.proveedor,
            numeroReserva: datos.numeroReserva,
            viajeId: existente.viajeId,
          },
          'ReservaDetectada omitida: la reserva pertenece a otro usuario',
        );
        return {
          accion: 'conflicto-usuario',
          reservaId: existente.reservaId,
          viajeId: existente.viajeId,
        };
      }

      const actualizada = await repositorio.actualizarReserva(db, existente.reservaId, {
        inicio: datos.inicio,
        fin: datos.fin,
        ...(datos.origen !== undefined ? { origen: datos.origen } : {}),
        destino: datos.destino,
        detalle: datos.detalle,
        estado: datos.estado,
        origenCambio: 'correo',
        correoId: datos.correoId,
        ahora: fechaActual,
      });
      await recalcularViaje(db, actualizada.viajeId, fechaActual);
      await publicarViajeActualizado(db, actualizada, 'correo');
      return {
        accion: 'actualizada',
        reserva: actualizada,
        viajeId: actualizada.viajeId,
        usuarioId: actualizada.usuarioId,
      };
    }

    const activos = await repositorio.listarViajesActivosDeUsuario(db, datos.usuarioId);
    const candidato = buscarViajeParaAgrupar(activos, datos.inicio, datos.fin, margenAgrupacionMs);

    let viajeId: string;
    if (candidato) {
      viajeId = candidato.viajeId;
    } else {
      const resumenInicial = calcularResumenViaje([
        {
          tipoReserva: datos.tipoReserva,
          destino: datos.destino,
          inicio: datos.inicio,
          fin: datos.fin,
          estado: datos.estado,
        },
      ]);
      const viajeNuevo = await repositorio.crearViaje(db, {
        usuarioId: datos.usuarioId,
        resumen: resumenInicial,
        ahora: fechaActual,
      });
      viajeId = viajeNuevo.viajeId;
    }

    const creada = await repositorio.insertarReserva(db, {
      viajeId,
      usuarioId: datos.usuarioId,
      proveedor: datos.proveedor,
      tipoReserva: datos.tipoReserva,
      numeroReserva: datos.numeroReserva,
      inicio: datos.inicio,
      fin: datos.fin,
      ...(datos.origen !== undefined ? { origen: datos.origen } : {}),
      destino: datos.destino,
      detalle: datos.detalle,
      estado: datos.estado,
      origenCambio: 'correo',
      correoId: datos.correoId,
      ahora: fechaActual,
    });

    if (candidato) {
      await recalcularViaje(db, viajeId, fechaActual);
    }

    await publicarViajeActualizado(db, creada, 'correo');
    return {
      accion: 'creada',
      reserva: creada,
      viajeId,
      usuarioId: creada.usuarioId,
    };
  }

  async function procesarReservaActualizada(
    db: ClienteDb,
    datos: ReservaActualizadaDatos,
  ): Promise<ResultadoReservaActualizada> {
    const preliminar = await repositorio.buscarReservaPorClave(
      db,
      datos.proveedor,
      datos.numeroReserva,
    );

    if (!preliminar) {
      // Contrato vigente (specs/asyncapi/eventos.yaml y docs/CONVENCIONES.md 4.5): si la reserva
      // no existe en esta región, se ignora, se registra con requestId y se confirma (ACK) sin DLQ.
      logger.info(
        {
          proveedor: datos.proveedor,
          numeroReserva: datos.numeroReserva,
          estado: datos.estado,
          requestId: contextoActual()?.requestId,
        },
        'ReservaActualizada ignorada: reserva no encontrada',
      );
      return { accion: 'ignorada' };
    }

    // Mismo orden de bloqueo que procesarReservaDetectada para prevenir deadlocks bajo concurrencia.
    await repositorio.bloquearUsuarioParaAgrupacion(db, preliminar.usuarioId);

    const actual = await repositorio.buscarReservaPorClave(
      db,
      datos.proveedor,
      datos.numeroReserva,
      { paraActualizar: true },
    );
    if (!actual) {
      logger.info(
        {
          proveedor: datos.proveedor,
          numeroReserva: datos.numeroReserva,
          requestId: contextoActual()?.requestId,
        },
        'ReservaActualizada ignorada: reserva eliminada antes de actualizar',
      );
      return { accion: 'ignorada' };
    }

    const nuevoInicio = datos.cambios.inicio ?? actual.inicio;
    let nuevoFin = datos.cambios.fin ?? actual.fin;
    if (datos.cambios.inicio && !datos.cambios.fin) {
      const iniMs = Date.parse(nuevoInicio);
      const finMs = Date.parse(nuevoFin);
      if (finMs < iniMs) {
        const duracionOriginal = Math.max(0, Date.parse(actual.fin) - Date.parse(actual.inicio));
        nuevoFin = new Date(iniMs + duracionOriginal).toISOString();
      }
    }
    validarRangoFechas(nuevoInicio, nuevoFin);

    const nuevoOrigen = datos.cambios.origen ?? actual.origen;
    const nuevoDestino = datos.cambios.destino ?? actual.destino;
    const nuevoDetalle = datos.cambios.detalle
      ? { ...actual.detalle, ...datos.cambios.detalle }
      : actual.detalle;
    const fechaActual = new Date(ahora());

    const actualizada = await repositorio.actualizarReserva(db, actual.reservaId, {
      inicio: nuevoInicio,
      fin: nuevoFin,
      ...(nuevoOrigen !== undefined ? { origen: nuevoOrigen } : {}),
      destino: nuevoDestino,
      detalle: nuevoDetalle,
      estado: datos.estado,
      origenCambio: 'proveedor',
      ahora: fechaActual,
    });
    await recalcularViaje(db, actualizada.viajeId, fechaActual);
    await publicarViajeActualizado(db, actualizada, 'proveedor');

    return {
      accion: 'actualizada',
      reserva: actualizada,
      viajeId: actualizada.viajeId,
      usuarioId: actualizada.usuarioId,
    };
  }

  return {
    publicarViajeActualizado,
    procesarReservaDetectada,
    procesarReservaActualizada,
  };
}
