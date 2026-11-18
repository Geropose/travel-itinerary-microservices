// Tipos de dominio y eventos del Servicio de Viajes (specs/openapi/viajes.yaml y specs/schemas/).

export type TipoReserva = 'vuelo' | 'hotel' | 'auto';
export type EstadoViaje = 'activo' | 'archivado';
export type EstadoReserva = 'confirmada' | 'modificada' | 'cancelada';
export type OrigenCambio = 'correo' | 'proveedor' | 'manual' | 'archivado';

export interface Viaje {
  viajeId: string;
  usuarioId: string;
  nombre: string;
  destino: string;
  inicio: string;
  fin: string;
  estado: EstadoViaje;
}

export interface Reserva {
  reservaId: string;
  viajeId: string;
  usuarioId: string;
  proveedor: string;
  tipoReserva: TipoReserva;
  numeroReserva: string;
  inicio: string;
  fin: string;
  origen?: string;
  destino: string;
  estado: EstadoReserva;
  detalle: Record<string, unknown>;
  origenCambio: OrigenCambio;
  correoId?: string;
  actualizadoEn: string;
}

export interface ViajeConReservas extends Viaje {
  reservas: Reserva[];
}

/** Datos del evento ReservaDetectada (specs/schemas/ReservaDetectada.json). */
export interface ReservaDetectadaDatos {
  usuarioId: string;
  proveedor: string;
  tipoReserva: TipoReserva;
  numeroReserva: string;
  inicio: string;
  fin: string;
  origen?: string;
  destino: string;
  estado: EstadoReserva;
  detalle: Record<string, unknown>;
  correoId: string;
}

/** Datos del evento ReservaActualizada (specs/schemas/ReservaActualizada.json). */
export interface ReservaActualizadaDatos {
  proveedor: string;
  numeroReserva: string;
  estado: EstadoReserva;
  cambios: {
    inicio?: string;
    fin?: string;
    origen?: string;
    destino?: string;
    detalle?: Record<string, unknown>;
  };
  origenCambio: 'proveedor';
}

/** Datos del evento ViajeActualizado (specs/schemas/ViajeActualizado.json). */
export interface ViajeActualizadoDatos {
  numeroReserva: string;
  proveedor: string;
  tipoReserva: TipoReserva;
  origen?: string;
  destino: string;
  inicio: string;
  fin: string;
  estado: EstadoReserva;
  origenCambio: OrigenCambio;
}

/** Arma la carga útil de ViajeActualizado sin datos de usuario ni viaje (ADR-016). */
export function construirDatosViajeActualizado(
  reserva: Pick<
    Reserva,
    | 'numeroReserva'
    | 'proveedor'
    | 'tipoReserva'
    | 'origen'
    | 'destino'
    | 'inicio'
    | 'fin'
    | 'estado'
  >,
  origenCambio: OrigenCambio,
): ViajeActualizadoDatos {
  return {
    numeroReserva: reserva.numeroReserva,
    proveedor: reserva.proveedor,
    tipoReserva: reserva.tipoReserva,
    ...(reserva.origen ? { origen: reserva.origen } : {}),
    destino: reserva.destino,
    inicio: reserva.inicio,
    fin: reserva.fin,
    estado: reserva.estado,
    origenCambio,
  };
}
