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

/** Reserva tal como la expone specs/openapi/viajes.yaml (sin usuarioId ni correoId). */
export interface ReservaPublica {
  reservaId: string;
  viajeId: string;
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
  actualizadoEn: string;
}

/** Viaje tal como lo expone specs/openapi/viajes.yaml (sin campo interno nombre). */
export interface ViajePublico {
  viajeId: string;
  usuarioId: string;
  destino: string;
  inicio: string;
  fin: string;
  estado: EstadoViaje;
  reservas: ReservaPublica[];
}

export interface PanelPublico {
  viajes: ViajePublico[];
}

/** Alta manual de una reserva (POST /reservas, UC-4). */
export interface NuevaReservaDatos {
  viajeId?: string;
  proveedor: string;
  tipoReserva: TipoReserva;
  numeroReserva: string;
  inicio: string;
  fin: string;
  origen?: string;
  destino: string;
  detalle?: Record<string, unknown>;
}

/** Cambio manual parcial de una reserva (PATCH /reservas/{reservaId}, UC-4). */
export interface CambioReservaDatos {
  viajeId?: string;
  inicio?: string;
  fin?: string;
  origen?: string;
  destino?: string;
  estado?: EstadoReserva;
  detalle?: Record<string, unknown>;
}

export function aReservaPublica(reserva: Reserva): ReservaPublica {
  return {
    reservaId: reserva.reservaId,
    viajeId: reserva.viajeId,
    proveedor: reserva.proveedor,
    tipoReserva: reserva.tipoReserva,
    numeroReserva: reserva.numeroReserva,
    inicio: reserva.inicio,
    fin: reserva.fin,
    ...(reserva.origen !== undefined ? { origen: reserva.origen } : {}),
    destino: reserva.destino,
    estado: reserva.estado,
    detalle: reserva.detalle,
    origenCambio: reserva.origenCambio,
    actualizadoEn: reserva.actualizadoEn,
  };
}

export function aViajePublico(viaje: ViajeConReservas): ViajePublico {
  return {
    viajeId: viaje.viajeId,
    usuarioId: viaje.usuarioId,
    destino: viaje.destino,
    inicio: viaje.inicio,
    fin: viaje.fin,
    estado: viaje.estado,
    reservas: viaje.reservas.map(aReservaPublica),
  };
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
