// Formatos de fecha, números, porcentajes y moneda según el idioma del usuario (QA-11). El locale
// y la moneda por defecto de cada idioma están en su archivo de idioma, no en el código.
import type { Idioma } from '../api/sesion.ts';
import en from './en.json';
import es from './es.json';

const FORMATOS: Record<Idioma, { locale: string; moneda: string }> = {
  es: es.formato,
  en: en.formato,
};

export const localeDe = (idioma: Idioma) => FORMATOS[idioma].locale;

/** Fecha en el formato del idioma: 20/11/26 en español, 11/20/26 en inglés. */
export function formatearFecha(
  fecha: Date | string,
  idioma: Idioma,
  opciones: Intl.DateTimeFormatOptions = { dateStyle: 'short' },
): string {
  const valor = typeof fecha === 'string' ? new Date(fecha) : fecha;
  return new Intl.DateTimeFormat(localeDe(idioma), opciones).format(valor);
}

/** Fecha sin hora (YYYY-MM-DD) sin corrimiento por huso horario local. */
export function formatearFechaSolo(
  fechaIso: string,
  idioma: Idioma,
  opciones: Intl.DateTimeFormatOptions = { dateStyle: 'short' },
): string {
  const valor = /^\d{4}-\d{2}-\d{2}$/.test(fechaIso)
    ? new Date(`${fechaIso}T12:00:00Z`)
    : new Date(fechaIso);
  return new Intl.DateTimeFormat(localeDe(idioma), {
    ...opciones,
    timeZone: 'UTC',
  }).format(valor);
}

/** Monto en la moneda dada (por defecto, la del idioma), con los separadores del idioma. */
export function formatearMoneda(monto: number, idioma: Idioma, moneda?: string): string {
  return new Intl.NumberFormat(localeDe(idioma), {
    style: 'currency',
    currency: moneda ?? FORMATOS[idioma].moneda,
  }).format(monto);
}

/** Número con separadores de miles y decimales del idioma. */
export function formatearNumero(
  valor: number,
  idioma: Idioma,
  opciones?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(localeDe(idioma), opciones).format(valor);
}

/** Proporción (0..1) expresada como porcentaje según el idioma. */
export function formatearPorcentaje(proporcion: number, idioma: Idioma): string {
  return new Intl.NumberFormat(localeDe(idioma), {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(proporcion);
}

/** Nombre localizado del mes (1..12) para el año indicado. */
export function formatearMes(anio: number, mes: number, idioma: Idioma): string {
  const fecha = new Date(Date.UTC(anio, mes - 1, 15));
  return new Intl.DateTimeFormat(localeDe(idioma), {
    month: 'long',
    timeZone: 'UTC',
  }).format(fecha);
}

/** Duración en milisegundos o segundos, legible según el idioma. */
export function formatearDuracion(ms: number, idioma: Idioma): string {
  if (ms < 1000) {
    return `${formatearNumero(Math.round(ms), idioma)} ms`;
  }
  return `${formatearNumero(ms / 1000, idioma, { maximumFractionDigits: 2 })} s`;
}

/** Convierte una fecha ISO 8601 a valor YYYY-MM-DDTHH:mm (hora local) para input datetime-local. */
export function aInputFechaHora(iso: string): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${fecha.getFullYear()}-${pad(fecha.getMonth() + 1)}-${pad(fecha.getDate())}T${pad(fecha.getHours())}:${pad(fecha.getMinutes())}`;
}

/** Convierte el valor de un input datetime-local a fecha ISO 8601 (UTC) válida para el contrato. */
export function desdeInputFechaHora(valor: string): string {
  if (!valor) return '';
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? '' : fecha.toISOString();
}
