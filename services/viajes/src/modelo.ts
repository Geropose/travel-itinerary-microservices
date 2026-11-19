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

export interface ListaViajesPublica {
  viajes: ViajePublico[];
}

export interface ListaReservasPublica {
  reservas: ReservaPublica[];
}

export interface UsuariosConViajeProximoRespuesta {
  dias: number;
  calculadoEn: string;
  usuarioIds: string[];
}

export interface ResultadoArchivado {
  viajesArchivados: number;
  reservasArchivadas: number;
  ejecutadoEn: string;
}

/** Reserva sin datos sensibles para publicar en una red social (specs/openapi/integraciones.yaml). */
export interface ReservaItinerarioRed {
  tipoReserva: TipoReserva;
  descripcion: string;
  inicio: string;
  fin?: string;
  origen?: string;
  destino?: string;
}

/** Itinerario sin números de reserva ni datos personales para POST /interna/redes/publicar. */
export interface ItinerarioRed {
  viajeId: string;
  destino: string;
  inicio: string;
  fin: string;
  reservas: ReservaItinerarioRed[];
}

export interface SolicitudPublicacionRed {
  red: string;
  itinerario: ItinerarioRed;
}

export interface PublicacionRed {
  red: string;
  url: string;
  publicadaEn: string;
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

function escaparRegExp(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function limpiarTextoSensible(texto: string, codigosSensibles: readonly string[]): string {
  let limpio = texto;
  for (const codigo of codigosSensibles) {
    if (!codigo) continue;
    limpio = limpio.replace(new RegExp(escaparRegExp(codigo), 'gi'), '').trim();
  }
  return limpio.replace(/\s{2,}/g, ' ').trim();
}

function primerTextoDetalle(
  detalle: Record<string, unknown>,
  claves: readonly string[],
): string | undefined {
  for (const clave of claves) {
    const valor = detalle[clave];
    if (typeof valor === 'string' && valor.trim().length > 0) {
      return valor.trim();
    }
  }
  return undefined;
}

function formatearNombreProveedor(proveedor: string): string {
  return proveedor
    .split(/[-_]+/)
    .filter((parte) => parte.length > 0)
    .map((parte) => parte.charAt(0).toUpperCase() + parte.slice(1))
    .join(' ');
}

function describirReservaParaRed(reserva: Reserva, codigosSensibles: readonly string[]): string {
  let base: string;
  if (reserva.tipoReserva === 'vuelo') {
    const numeroVuelo = primerTextoDetalle(reserva.detalle, ['numeroVuelo', 'vuelo']);
    base = numeroVuelo ? `Vuelo ${numeroVuelo}` : `Vuelo a ${reserva.destino}`;
  } else if (reserva.tipoReserva === 'hotel') {
    const nombreHotel = primerTextoDetalle(reserva.detalle, [
      'nombreHotel',
      'hotel',
      'alojamiento',
      'nombre',
    ]);
    base = nombreHotel ?? formatearNombreProveedor(reserva.proveedor);
  } else {
    const modelo = primerTextoDetalle(reserva.detalle, ['modelo', 'categoria', 'vehiculo']);
    base = modelo ? `Auto ${modelo}` : `Alquiler de auto en ${reserva.destino}`;
  }

  const limpio = limpiarTextoSensible(base, codigosSensibles);
  const texto = limpio.length > 0 ? limpio : `Reserva de ${reserva.tipoReserva}`;
  return texto.slice(0, 200);
}

/**
 * Arma el itinerario publicable en redes sociales sin números de reserva ni datos personales
 * (Iteración 3, specs/openapi/integraciones.yaml#/components/schemas/Itinerario).
 */
export function armarItinerarioParaRed(viaje: ViajeConReservas): ItinerarioRed {
  const codigosSensibles = viaje.reservas
    .map((r) => r.numeroReserva.trim())
    .filter((c) => c.length > 0);

  const activas = viaje.reservas.filter((r) => r.estado !== 'cancelada');
  const seleccionadas = activas.length > 0 ? activas : viaje.reservas;

  const destinoLimpio = limpiarTextoSensible(viaje.destino, codigosSensibles);

  return {
    viajeId: viaje.viajeId,
    destino: destinoLimpio.length > 0 ? destinoLimpio : 'Viaje',
    inicio: viaje.inicio,
    fin: viaje.fin,
    reservas: seleccionadas.map((reserva): ReservaItinerarioRed => {
      const descripcion = describirReservaParaRed(reserva, codigosSensibles);
      if (reserva.tipoReserva === 'vuelo') {
        const origenLimpio = reserva.origen
          ? limpiarTextoSensible(reserva.origen, codigosSensibles)
          : '';
        const destinoReservaLimpio = limpiarTextoSensible(reserva.destino, codigosSensibles);
        return {
          tipoReserva: 'vuelo',
          descripcion,
          inicio: reserva.inicio,
          fin: reserva.fin,
          ...(origenLimpio.length > 0 ? { origen: origenLimpio } : {}),
          ...(destinoReservaLimpio.length > 0 ? { destino: destinoReservaLimpio } : {}),
        };
      }
      return {
        tipoReserva: reserva.tipoReserva,
        descripcion,
        inicio: reserva.inicio,
        fin: reserva.fin,
      };
    }),
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
