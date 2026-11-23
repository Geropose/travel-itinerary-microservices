import type { Region } from '@trotamundos/comun';
import type { ServicioDependencia } from '../clientes.ts';
import type { IdiomaAsistente, IntencionDetectada, ReglasIdioma } from '../reglas.ts';

export type ResultadoMensaje =
  | 'respondido'
  | 'repregunta'
  | 'consultando'
  | 'opciones'
  | 'reprogramado'
  | 'opcionRechazada'
  | 'derivado'
  | 'noDisponible';

export interface ReservaResumen {
  proveedor: string;
  numeroReserva: string;
  tipoReserva: 'vuelo' | 'hotel' | 'auto';
  estado: 'confirmada' | 'modificada' | 'cancelada';
  inicio: string;
  fin: string;
  origen?: string;
  destino: string;
}

export interface OpcionReprogramacion {
  opcionId: string;
  proveedor: string;
  numeroReserva: string;
  tipoReserva: 'vuelo' | 'hotel' | 'auto';
  inicio: string;
  fin: string;
  origen?: string;
  destino: string;
  descripcion?: string;
}

export interface CasoDerivado {
  agencia: string;
  numeroCaso: string;
}

export interface FuncionNoDisponible {
  funcion: 'estado' | 'reprogramar' | 'derivar';
  servicio: ServicioDependencia;
}

export interface MensajeHistorial {
  mensajeId: string;
  secuencia: number;
  autor: 'usuario' | 'asistente';
  texto: string;
  enviadoEn: string;
  intencion?: IntencionDetectada;
  resultado?: ResultadoMensaje;
  confirmacion?: { opcionId: string };
  reservas?: ReservaResumen[];
  opciones?: OpcionReprogramacion[];
  caso?: CasoDerivado;
  noDisponible?: FuncionNoDisponible;
  ofreceDerivar?: boolean;
}

export interface ContextoPlugin {
  conversacionId: string;
  usuarioId: string;
  region: Region;
  idioma: IdiomaAsistente;
  /** JWT del usuario autenticado; los plug-ins lo propagan a los demás servicios (QA-9). */
  token: string;
  reglas: ReglasIdioma;
  historial: MensajeHistorial[];
  /** Zona horaria IANA del dispositivo del usuario, para mostrar las horas como en el panel. */
  zonaHoraria?: string;
  /** Motivo explícito cuando el núcleo deriva automáticamente (ej. 2 intentos fallidos). */
  motivoDerivacion?: string;
}

export interface RespuestaPlugin {
  texto: string;
  resultado: ResultadoMensaje;
  reservas?: ReservaResumen[];
  opciones?: OpcionReprogramacion[];
  caso?: CasoDerivado;
  noDisponible?: FuncionNoDisponible;
  ofreceDerivar?: boolean;
}

/**
 * Interfaz común de los plug-ins del Asistente Virtual (Iteración 7, ADR-018).
 * Sumar un tipo de consulta nuevo consiste en implementar esta interfaz y registrarla en el núcleo,
 * sin modificar el núcleo ni los demás plug-ins.
 */
export interface PluginConsulta {
  readonly intencion: string;
  atender(contexto: ContextoPlugin, mensaje: string): Promise<RespuestaPlugin>;
  /** Opcional: para plug-ins de dos pasos con confirmación explícita (ej. reprogramar). */
  confirmar?(contexto: ContextoPlugin, opcion: OpcionReprogramacion): Promise<RespuestaPlugin>;
}

const PATRON_CODIGO_RESERVA = /\b([A-Z]{2,3}-\d{4,6}|[A-Z0-9]{6})\b/g;

/** Extrae un posible código de reserva (ej. `XKQ7PL`, `HC-48213`, `RS-77120`) del mensaje. */
export function extraerCodigoReserva(mensaje: string): string | undefined {
  const mayus = mensaje.toUpperCase();
  const coincidencias = [...mayus.matchAll(PATRON_CODIGO_RESERVA)].map((m) => m[1] ?? '');
  // Priorizamos códigos con al menos un dígito o guión para evitar confundir palabras comunes de 6 letras.
  const conDigito = coincidencias.find((c) => /\d/.test(c));
  return conDigito;
}

/** Indica si el texto es una zona horaria IANA válida (por ejemplo, `America/Argentina/Buenos_Aires`). */
export function esZonaHorariaValida(zona: string | undefined): zona is string {
  if (!zona) return false;
  try {
    new Intl.DateTimeFormat('es-AR', { timeZone: zona });
    return true;
  } catch {
    return false;
  }
}

/**
 * Formatea una fecha ISO de manera legible según el idioma de la conversación. Las reservas se
 * guardan en UTC: la hora se muestra en la zona horaria del usuario (la misma que ve en el panel)
 * y, si el cliente no la informó o no es válida, en UTC.
 */
export function formatearFechaHora(
  iso: string,
  idioma: IdiomaAsistente,
  zonaHoraria?: string,
): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return iso;
  return new Intl.DateTimeFormat(idioma === 'en' ? 'en-US' : 'es-AR', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: esZonaHorariaValida(zonaHoraria) ? zonaHoraria : 'UTC',
  }).format(fecha);
}

export function etiquetaTipoReserva(
  tipo: 'vuelo' | 'hotel' | 'auto',
  idioma: IdiomaAsistente,
): string {
  if (idioma === 'en') {
    return tipo === 'vuelo' ? 'flight' : tipo === 'hotel' ? 'hotel' : 'car rental';
  }
  return tipo === 'vuelo' ? 'vuelo' : tipo === 'hotel' ? 'hotel' : 'auto';
}

export function etiquetaEstadoReserva(
  estado: 'confirmada' | 'modificada' | 'cancelada',
  idioma: IdiomaAsistente,
): string {
  if (idioma === 'en') {
    return estado === 'confirmada'
      ? 'confirmed'
      : estado === 'modificada'
        ? 'modified'
        : 'cancelled';
  }
  return estado;
}
