// Tipos de dominio de Analítica alineados a specs/schemas/ViajeActualizado.json,
// specs/schemas/ViajeAnonimizado.json y specs/openapi/analitica.yaml (Iteración 6, ADR-016, ADR-017).
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

// --- Consultas analíticas y ejecuciones Map-Reduce (specs/openapi/analitica.yaml) ---

export type TipoConsulta = 'destinos' | 'cancelaciones' | 'tendencias';
export type AgrupacionCancelaciones = 'proveedor' | 'destino';
export type AgrupacionTendencias = 'mes';
export type EstadoEjecucion = 'pendiente' | 'enCurso' | 'terminada' | 'fallida';

export interface ParametrosDestinos {
  desde: string;
  hasta: string;
  limite?: number;
  procesadores?: number;
}

export interface ParametrosCancelaciones {
  desde: string;
  hasta: string;
  agruparPor: AgrupacionCancelaciones;
  procesadores?: number;
}

export interface ParametrosTendencias {
  anio: number;
  agruparPor?: AgrupacionTendencias;
  procesadores?: number;
}

export type ParametrosConsulta =
  ParametrosDestinos | ParametrosCancelaciones | ParametrosTendencias;

export interface DestinoReservado {
  destino: string;
  reservas: number;
  proporcion: number;
}

export interface ResultadoDestinos {
  desde: string;
  hasta: string;
  totalReservas: number;
  destinos: DestinoReservado[];
  generadoEn: string;
}

export interface TasaCancelacion {
  reservas: number;
  canceladas: number;
  tasaCancelacion: number;
}

export interface GrupoCancelaciones extends TasaCancelacion {
  clave: string;
}

export interface ResultadoCancelaciones {
  desde: string;
  hasta: string;
  agruparPor: AgrupacionCancelaciones;
  total: TasaCancelacion;
  grupos: GrupoCancelaciones[];
  generadoEn: string;
}

export interface ReservasPorTipo {
  vuelo: number;
  hotel: number;
  auto: number;
}

export interface TendenciaMes {
  mes: number;
  reservas: number;
  canceladas: number;
  porTipoReserva: ReservasPorTipo;
}

export interface ResultadoTendencias {
  anio: number;
  agruparPor: AgrupacionTendencias;
  periodos: TendenciaMes[];
  generadoEn: string;
}

export type ResultadoConsulta = ResultadoDestinos | ResultadoCancelaciones | ResultadoTendencias;

export interface ConsultaLanzada {
  consultaId: string;
  tipo: TipoConsulta;
  estado: EstadoEjecucion;
  creadaEn: string;
}

export interface EjecucionPublica {
  consultaId: string;
  tipo: TipoConsulta;
  parametros: ParametrosConsulta;
  estado: EstadoEjecucion;
  procesadores: number;
  progreso: number;
  creadaEn: string;
  iniciadaEn?: string;
  terminadaEn?: string;
  duracionMs?: number;
  resultado?: ResultadoConsulta;
  error?: string;
}
