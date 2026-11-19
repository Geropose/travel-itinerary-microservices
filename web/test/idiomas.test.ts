import { describe, expect, it } from 'vitest';
import type { Almacen } from '../src/api/sesion.ts';
import en from '../src/idiomas/en.json';
import es from '../src/idiomas/es.json';
import {
  aInputFechaHora,
  desdeInputFechaHora,
  formatearDuracion,
  formatearFecha,
  formatearFechaSolo,
  formatearMes,
  formatearMoneda,
  formatearNumero,
  formatearPorcentaje,
} from '../src/idiomas/formatos.ts';
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

  it('fechas sin hora (YYYY-MM-DD): no se corren por huso horario', () => {
    expect(formatearFechaSolo('2025-01-01', 'es')).toBe('1/1/25');
    expect(formatearFechaSolo('2025-01-01', 'en')).toBe('1/1/25');
    expect(formatearFechaSolo('2025-12-31', 'es')).toBe('31/12/25');
    expect(formatearFechaSolo('2025-12-31', 'en')).toBe('12/31/25');
  });

  it('moneda: la del idioma por defecto, con sus separadores', () => {
    expect(formatearMoneda(1234.5, 'es').replace(/\s/g, ' ')).toBe('$ 1.234,50');
    expect(formatearMoneda(1234.5, 'en')).toBe('$1,234.50');
    expect(formatearMoneda(1234.5, 'en', 'EUR')).toBe('€1,234.50');
  });

  it('números, porcentajes, meses y duraciones según el idioma', () => {
    expect(formatearNumero(12500, 'es')).toBe('12.500');
    expect(formatearNumero(12500, 'en')).toBe('12,500');
    expect(formatearPorcentaje(0.184, 'es').replace(/\s/g, '')).toBe('18,4%');
    expect(formatearPorcentaje(0.184, 'en')).toBe('18.4%');
    expect(formatearMes(2025, 1, 'es')).toBe('enero');
    expect(formatearMes(2025, 1, 'en')).toBe('January');
    expect(formatearDuracion(450, 'es')).toBe('450 ms');
    expect(formatearDuracion(2450, 'es')).toBe('2,45 s');
    expect(formatearDuracion(2450, 'en')).toBe('2.45 s');
  });

  it('convierte fechas ISO 8601 a datetime-local y viceversa sin perder el instante', () => {
    const iso = '2026-12-10T15:30:00.000Z';
    const local = aInputFechaHora(iso);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(desdeInputFechaHora(local)).toBe(iso);
    expect(aInputFechaHora('no-es-fecha')).toBe('');
    expect(desdeInputFechaHora('')).toBe('');
  });
});
