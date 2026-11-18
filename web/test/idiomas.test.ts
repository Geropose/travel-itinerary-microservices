import { describe, expect, it } from 'vitest';
import type { Almacen } from '../src/api/sesion.ts';
import en from '../src/idiomas/en.json';
import es from '../src/idiomas/es.json';
import { formatearFecha, formatearMoneda } from '../src/idiomas/formatos.ts';
import { idiomaInicial } from '../src/idiomas/i18n.ts';

/** Todas las claves de un archivo de idioma, como "login.titulo". */
function claves(objeto: object, prefijo = ''): string[] {
  return Object.entries(objeto).flatMap(([clave, valor]) =>
    typeof valor === 'object' && valor !== null
      ? claves(valor as object, `${prefijo}${clave}.`)
      : [`${prefijo}${clave}`],
  );
}

const almacen = (datos: Record<string, string> = {}): Almacen => ({
  getItem: (c) => datos[c] ?? null,
  setItem: () => undefined,
  removeItem: () => undefined,
});

describe('archivos de idioma (QA-11)', () => {
  it('es.json y en.json tienen las mismas claves, sin textos vacíos', () => {
    expect(claves(en).sort()).toEqual(claves(es).sort());
    for (const archivo of [es, en]) {
      const valores = JSON.stringify(archivo).match(/:""/g);
      expect(valores).toBeNull();
    }
  });

  it('el idioma guardado gana; si no, el del navegador', () => {
    expect(idiomaInicial(almacen({ 'trotamundos.idioma': 'en' }), 'es-AR')).toBe('en');
    expect(idiomaInicial(almacen(), 'en-GB')).toBe('en');
    expect(idiomaInicial(almacen(), 'pt-BR')).toBe('es');
    expect(idiomaInicial(almacen({ 'trotamundos.idioma': 'fr' }), undefined)).toBe('es');
  });
});

describe('formatos con Intl según el idioma', () => {
  const fecha = '2026-11-20T13:45:00Z';

  it('fechas: día/mes en español y mes/día en inglés', () => {
    expect(formatearFecha(fecha, 'es', { dateStyle: 'short', timeZone: 'UTC' })).toBe('20/11/26');
    expect(formatearFecha(fecha, 'en', { dateStyle: 'short', timeZone: 'UTC' })).toBe('11/20/26');
    expect(formatearFecha(fecha, 'en', { dateStyle: 'long', timeZone: 'UTC' })).toBe(
      'November 20, 2026',
    );
  });

  it('moneda: la del idioma por defecto, con sus separadores', () => {
    expect(formatearMoneda(1234.5, 'es').replace(/\s/g, ' ')).toBe('$ 1.234,50');
    expect(formatearMoneda(1234.5, 'en')).toBe('$1,234.50');
    expect(formatearMoneda(1234.5, 'en', 'EUR')).toBe('€1,234.50');
  });
});
