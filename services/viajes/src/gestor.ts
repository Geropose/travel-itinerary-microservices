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
  buscarViajesParaAgrupar,
  calcularResumenViaje,
  MARGEN_AGRUPACION_MS_DEFECTO,
} from './agrupacion.ts';
import {
  construirDatosViajeActualizado,
  type CambioReservaDatos,
  type NuevaReservaDatos,
  type OrigenCambio,
  type Reserva,
  type ReservaActualizadaDatos,
  type ReservaDetectadaDatos,
} from './modelo.ts';
import * as repositorio from './repositorio.ts';

export type CodigoErrorViajes = 'solicitud-invalida' | 'prohibido' | 'no-encontrado' | 'conflicto';

export class ErrorNegocioViajes extends Error {
  readonly codigo: CodigoErrorViajes;

  constructor(codigo: CodigoErrorViajes, mensaje: string) {
    super(mensaje);
    this.name = 'ErrorNegocioViajes';
    this.codigo = codigo;
  }
}

function esDuplicadoPg(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

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

  /** Alta manual de reserva (UC-4): agrupa o usa viajeId y publica ViajeActualizado (manual). */
  crearReservaManual(db: ClienteDb, usuarioId: string, datos: NuevaReservaDatos): Promise<Reserva>;

  /** Modificación manual parcial (UC-4): solo el dueño; publica ViajeActualizado (manual). */
  modificarReservaManual(
    db: ClienteDb,
    usuarioId: string,
    reservaId: string,
    cambios: CambioReservaDatos,
  ): Promise<Reserva>;

  /** Baja manual (UC-4): borra la reserva (y el viaje si queda vacío) y publica cancelación. */
  eliminarReservaManual(db: ClienteDb, usuarioId: string, reservaId: string): Promise<void>;
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

  /** Resuelve el viaje activo destino para una reserva nueva, fusionando si hace puente entre varios. */
  async function resolverViajeAgrupado(
    db: ClienteDb,
    usuarioId: string,
    reservaResumen: {
      tipoReserva: Reserva['tipoReserva'];
      destino: string;
      inicio: string;
      fin: string;
      estado: Reserva['estado'];
    },
    fechaActual: Date,
  ): Promise<{ viajeId: string; requiereRecalculo: boolean }> {
    const activos = await repositorio.listarViajesActivosDeUsuario(db, usuarioId);
    const candidatos = buscarViajesParaAgrupar(
      activos,
      reservaResumen.inicio,
      reservaResumen.fin,
      margenAgrupacionMs,
    );

    if (candidatos.length === 0) {
      const resumenInicial = calcularResumenViaje([reservaResumen]);
      const viajeNuevo = await repositorio.crearViaje(db, {
        usuarioId,
        resumen: resumenInicial,
        ahora: fechaActual,
      });
      return { viajeId: viajeNuevo.viajeId, requiereRecalculo: false };
    }

    // Si la reserva nueva conecta dos o más viajes que llegaron fuera de orden, los fusionamos en el más antiguo.
    const ordenadosPorInicio = [...candidatos].sort(
      (a, b) => Date.parse(a.inicio) - Date.parse(b.inicio),
    );
    const principal = ordenadosPorInicio[0];
    if (!principal) throw new Error('Candidato principal no disponible');
    const absorbidos = ordenadosPorInicio.slice(1).map((v) => v.viajeId);
    if (absorbidos.length > 0) {
      await repositorio.fusionarViajesEnPrincipal(db, principal.viajeId, absorbidos);
    }
    return { viajeId: principal.viajeId, requiereRecalculo: true };
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

    const { viajeId, requiereRecalculo } = await resolverViajeAgrupado(
      db,
      datos.usuarioId,
      {
        tipoReserva: datos.tipoReserva,
        destino: datos.destino,
        inicio: datos.inicio,
        fin: datos.fin,
        estado: datos.estado,
      },
      fechaActual,
    );

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

    if (requiereRecalculo) {
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

  async function crearReservaManual(
    db: ClienteDb,
    usuarioId: string,
    datos: NuevaReservaDatos,
  ): Promise<Reserva> {
    const iniMs = Date.parse(datos.inicio);
    const finMs = Date.parse(datos.fin);
    if (Number.isNaN(iniMs) || Number.isNaN(finMs) || finMs < iniMs) {
      throw new ErrorNegocioViajes(
        'solicitud-invalida',
        'La fecha de fin no puede ser anterior a la fecha de inicio.',
      );
    }

    const fechaActual = new Date(ahora());
    await repositorio.bloquearUsuarioParaAgrupacion(db, usuarioId);

    const yaExiste = await repositorio.buscarReservaPorClave(
      db,
      datos.proveedor,
      datos.numeroReserva,
    );
    if (yaExiste) {
      throw new ErrorNegocioViajes(
        'conflicto',
        'Ya existe una reserva con ese proveedor y número de reserva.',
      );
    }

    let viajeId: string;
    let requiereRecalculo: boolean;

    if (datos.viajeId) {
      const viajeDestino = await repositorio.buscarViajePorId(db, datos.viajeId, {
        paraActualizar: true,
      });
      if (!viajeDestino) {
        throw new ErrorNegocioViajes('no-encontrado', 'El viaje indicado no existe.');
      }
      if (viajeDestino.usuarioId !== usuarioId) {
        throw new ErrorNegocioViajes('prohibido', 'No podés agregar reservas a un viaje ajeno.');
      }
      if (viajeDestino.estado === 'archivado') {
        throw new ErrorNegocioViajes(
          'conflicto',
          'No se puede agregar una reserva a un viaje archivado.',
        );
      }
      viajeId = viajeDestino.viajeId;
      requiereRecalculo = true;
    } else {
      const agrupado = await resolverViajeAgrupado(
        db,
        usuarioId,
        {
          tipoReserva: datos.tipoReserva,
          destino: datos.destino,
          inicio: datos.inicio,
          fin: datos.fin,
          estado: 'confirmada',
        },
        fechaActual,
      );
      viajeId = agrupado.viajeId;
      requiereRecalculo = agrupado.requiereRecalculo;
    }

    let creada: Reserva;
    try {
      creada = await repositorio.insertarReserva(db, {
        viajeId,
        usuarioId,
        proveedor: datos.proveedor,
        tipoReserva: datos.tipoReserva,
        numeroReserva: datos.numeroReserva,
        inicio: datos.inicio,
        fin: datos.fin,
        ...(datos.origen !== undefined ? { origen: datos.origen } : {}),
        destino: datos.destino,
        detalle: datos.detalle ?? {},
        estado: 'confirmada',
        origenCambio: 'manual',
        ahora: fechaActual,
      });
    } catch (err) {
      if (esDuplicadoPg(err)) {
        throw new ErrorNegocioViajes(
          'conflicto',
          'Ya existe una reserva con ese proveedor y número de reserva.',
        );
      }
      throw err;
    }

    if (requiereRecalculo) {
      await recalcularViaje(db, viajeId, fechaActual);
    }

    await publicarViajeActualizado(db, creada, 'manual');
    return creada;
  }

  async function modificarReservaManual(
    db: ClienteDb,
    usuarioId: string,
    reservaId: string,
    cambios: CambioReservaDatos,
  ): Promise<Reserva> {
    const preliminar = await repositorio.buscarReservaPorId(db, reservaId);
    if (!preliminar) {
      throw new ErrorNegocioViajes('no-encontrado', 'La reserva no existe.');
    }
    if (preliminar.usuarioId !== usuarioId) {
      throw new ErrorNegocioViajes('prohibido', 'Solo el dueño puede modificar esta reserva.');
    }

    await repositorio.bloquearUsuarioParaAgrupacion(db, usuarioId);

    const actual = await repositorio.buscarReservaPorId(db, reservaId, { paraActualizar: true });
    if (!actual) {
      throw new ErrorNegocioViajes('no-encontrado', 'La reserva no existe.');
    }
    if (actual.usuarioId !== usuarioId) {
      throw new ErrorNegocioViajes('prohibido', 'Solo el dueño puede modificar esta reserva.');
    }

    const viajeOrigen = await repositorio.buscarViajePorId(db, actual.viajeId, {
      paraActualizar: true,
    });
    if (viajeOrigen?.estado === 'archivado') {
      throw new ErrorNegocioViajes(
        'conflicto',
        'No se puede modificar una reserva de un viaje archivado.',
      );
    }

    let viajeDestinoId = actual.viajeId;
    if (cambios.viajeId && cambios.viajeId !== actual.viajeId) {
      const viajeDestino = await repositorio.buscarViajePorId(db, cambios.viajeId, {
        paraActualizar: true,
      });
      if (!viajeDestino) {
        throw new ErrorNegocioViajes('no-encontrado', 'El viaje destino no existe.');
      }
      if (viajeDestino.usuarioId !== usuarioId) {
        throw new ErrorNegocioViajes('prohibido', 'No podés mover una reserva a un viaje ajeno.');
      }
      if (viajeDestino.estado === 'archivado') {
        throw new ErrorNegocioViajes(
          'conflicto',
          'No se puede mover una reserva a un viaje archivado.',
        );
      }
      viajeDestinoId = viajeDestino.viajeId;
    }

    const nuevoInicio = cambios.inicio ?? actual.inicio;
    const nuevoFin = cambios.fin ?? actual.fin;
    const iniMs = Date.parse(nuevoInicio);
    const finMs = Date.parse(nuevoFin);
    if (Number.isNaN(iniMs) || Number.isNaN(finMs) || finMs < iniMs) {
      throw new ErrorNegocioViajes(
        'conflicto',
        'La fecha de fin no puede quedar anterior a la fecha de inicio.',
      );
    }

    const nuevoOrigen = cambios.origen ?? actual.origen;
    const fechaActual = new Date(ahora());
    const actualizada = await repositorio.actualizarReserva(db, actual.reservaId, {
      viajeId: viajeDestinoId,
      inicio: nuevoInicio,
      fin: nuevoFin,
      ...(nuevoOrigen !== undefined ? { origen: nuevoOrigen } : {}),
      destino: cambios.destino ?? actual.destino,
      detalle: cambios.detalle ?? actual.detalle,
      estado: cambios.estado ?? actual.estado,
      origenCambio: 'manual',
      ahora: fechaActual,
    });

    await recalcularViaje(db, viajeDestinoId, fechaActual);
    if (viajeDestinoId !== actual.viajeId) {
      const restantesOrigen = await repositorio.listarReservasDeViaje(db, actual.viajeId);
      if (restantesOrigen.length === 0) {
        await repositorio.eliminarViajePorId(db, actual.viajeId);
      } else {
        await repositorio.actualizarResumenViaje(
          db,
          actual.viajeId,
          calcularResumenViaje(restantesOrigen),
          fechaActual,
        );
      }
    }

    await publicarViajeActualizado(db, actualizada, 'manual');
    return actualizada;
  }

  async function eliminarReservaManual(
    db: ClienteDb,
    usuarioId: string,
    reservaId: string,
  ): Promise<void> {
    const preliminar = await repositorio.buscarReservaPorId(db, reservaId);
    if (!preliminar) {
      throw new ErrorNegocioViajes('no-encontrado', 'La reserva no existe.');
    }
    if (preliminar.usuarioId !== usuarioId) {
      throw new ErrorNegocioViajes('prohibido', 'Solo el dueño puede eliminar esta reserva.');
    }

    await repositorio.bloquearUsuarioParaAgrupacion(db, usuarioId);

    const actual = await repositorio.buscarReservaPorId(db, reservaId, { paraActualizar: true });
    if (!actual) {
      throw new ErrorNegocioViajes('no-encontrado', 'La reserva no existe.');
    }
    if (actual.usuarioId !== usuarioId) {
      throw new ErrorNegocioViajes('prohibido', 'Solo el dueño puede eliminar esta reserva.');
    }

    const viaje = await repositorio.buscarViajePorId(db, actual.viajeId, { paraActualizar: true });
    if (viaje?.estado === 'archivado') {
      throw new ErrorNegocioViajes(
        'conflicto',
        'No se puede eliminar una reserva de un viaje archivado.',
      );
    }

    await repositorio.eliminarReservaPorId(db, actual.reservaId);

    const fechaActual = new Date(ahora());
    const restantes = await repositorio.listarReservasDeViaje(db, actual.viajeId);
    if (restantes.length === 0) {
      await repositorio.eliminarViajePorId(db, actual.viajeId);
    } else {
      await repositorio.actualizarResumenViaje(
        db,
        actual.viajeId,
        calcularResumenViaje(restantes),
        fechaActual,
      );
    }

    // ViajeActualizado no tiene estado "eliminada": se publica como cancelada (viajes.yaml).
    await publicarViajeActualizado(db, { ...actual, estado: 'cancelada' }, 'manual');
  }

  return {
    publicarViajeActualizado,
    procesarReservaDetectada,
    procesarReservaActualizada,
    crearReservaManual,
    modificarReservaManual,
    eliminarReservaManual,
  };
}
