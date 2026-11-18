// Formatos de fecha y moneda según el idioma del usuario (QA-11). El locale y la moneda por defecto
// de cada idioma están en su archivo de idioma, no en el código.
import type { Idioma } from '../api/sesion.ts';
import en from './en.json';
import es from './es.json';

const FORMATOS: Record<Idioma, { locale: string; moneda: string }> = {
  es: es.formato,
  en: en.formato,
};

export const localeDe = (idioma: Idioma) => FORMATOS[idioma].locale;

/** Fecha en el formato del idioma: 20/11/2026 en español, 11/20/2026 en inglés. */
export function formatearFecha(
  fecha: Date | string,
  idioma: Idioma,
  opciones: Intl.DateTimeFormatOptions = { dateStyle: 'short' },
): string {
  const valor = typeof fecha === 'string' ? new Date(fecha) : fecha;
  return new Intl.DateTimeFormat(localeDe(idioma), opciones).format(valor);
}

/** Monto en la moneda dada (por defecto, la del idioma), con los separadores del idioma. */
export function formatearMoneda(monto: number, idioma: Idioma, moneda?: string): string {
  return new Intl.NumberFormat(localeDe(idioma), {
    style: 'currency',
    currency: moneda ?? FORMATOS[idioma].moneda,
  }).format(monto);
}
