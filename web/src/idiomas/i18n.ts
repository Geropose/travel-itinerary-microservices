// Archivos de idioma (Iteración 4, QA-11): los textos y formatos de cada idioma están en
// es.json y en.json, separados del código. Para sumar un idioma se agrega su archivo acá.
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { Almacen, Idioma } from '../api/sesion.ts';
import en from './en.json';
import es from './es.json';

export const IDIOMAS: readonly Idioma[] = ['es', 'en'];
export const RECURSOS = { es: { traduccion: es }, en: { traduccion: en } } as const;

const CLAVE_IDIOMA = 'trotamundos.idioma';

export const esIdioma = (valor: unknown): valor is Idioma =>
  typeof valor === 'string' && (IDIOMAS as readonly string[]).includes(valor);

/** Idioma guardado; si no hay, el del navegador (inglés si empieza con "en", si no español). */
export function idiomaInicial(almacen: Almacen, navegador: string | undefined): Idioma {
  const guardado = almacen.getItem(CLAVE_IDIOMA);
  if (esIdioma(guardado)) return guardado;
  return navegador?.toLowerCase().startsWith('en') ? 'en' : 'es';
}

export function iniciarIdiomas(idioma: Idioma) {
  void i18next.use(initReactI18next).init({
    resources: RECURSOS,
    lng: idioma,
    fallbackLng: 'es',
    defaultNS: 'traduccion',
    interpolation: { escapeValue: false },
  });
  document.documentElement.lang = idioma;
  return i18next;
}

/** Cambia el idioma de la interfaz y lo recuerda en este dispositivo. */
export function cambiarIdioma(idioma: Idioma, almacen: Almacen): void {
  almacen.setItem(CLAVE_IDIOMA, idioma);
  document.documentElement.lang = idioma;
  void i18next.changeLanguage(idioma);
}
