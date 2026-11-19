// Tipos de dominio de Analítica alineados a specs/schemas/ViajeActualizado.json y
// specs/schemas/ViajeAnonimizado.json (Iteración 6, ADR-016, ADR-017).
import type { Region } from '@trotamundos/comun';

export type TipoReserva = 'vuelo' | 'hotel' | 'auto';
export type EstadoReserva = 'confirmada' | 'modificada' | 'cancelada';
export type OrigenCambio = 'correo' | 'proveedor' | 'manual' | 'archivado';

/** Carga útil del evento ViajeActualizado consumido dentro de cada región. */
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

/**
 * Fila anonimizada conforme a specs/schemas/ViajeAnonimizado.json (additionalProperties: false).
 * Nunca incluye usuarioId, viajeId, reservaId, numeroReserva, nombres ni emails; inicio y fin son
 * únicamente fechas YYYY-MM-DD sin hora.
 */
export interface ViajeAnonimizado {
  codigoReserva: string;
  region: Region;
  proveedor: string;
  tipoReserva: TipoReserva;
  origen?: string;
  destino: string;
  inicio: string;
  fin: string;
  estado: EstadoReserva;
  origenCambio: OrigenCambio;
}
