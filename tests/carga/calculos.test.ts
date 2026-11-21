import { describe, expect, it } from 'vitest';
import {
  contarEn,
  duracion,
  percentil,
  porcentaje,
  reservasEsperadas,
  resumir,
} from './calculos.ts';

describe('percentil y resumen', () => {
  it('usa el rango más cercano', () => {
    const valores = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10];
    expect(percentil(valores, 50)).toBe(5);
    expect(percentil(valores, 95)).toBe(10);
    expect(percentil(valores, 0)).toBe(1);
    expect(percentil([], 50)).toBeNaN();
  });

  it('resume mínimo, mediana, p95 y máximo', () => {
    expect(resumir([300, 100, 200])).toEqual({ n: 3, min: 100, p50: 200, p95: 300, max: 300 });
  });
});

describe('porcentaje', () => {
  it('redondea a dos decimales y no divide por cero', () => {
    expect(porcentaje(994, 1000)).toBe(99.4);
    expect(porcentaje(2, 3)).toBe(66.67);
    expect(porcentaje(0, 0)).toBe(0);
  });
});

describe('reservas esperadas de un lote', () => {
  const correos = [
    { id: '1', tipo: 'vuelo', reserva: { numeroReserva: 'AN-1' } },
    { id: '2', tipo: 'hotel-sin-marcado', reserva: { numeroReserva: 'HC-2' } },
    { id: '3', tipo: 'no-viaje' },
    { id: '4', tipo: 'remitente-no-permitido', reserva: { numeroReserva: 'VB-4' } },
  ];

  it('separa las de viaje de las de un remitente fuera de la whitelist', () => {
    const { esperadas, bloqueadas } = reservasEsperadas(correos);
    expect([...esperadas]).toEqual(['AN-1', 'HC-2']);
    expect([...bloqueadas]).toEqual(['VB-4']);
  });

  it('cuenta cuántas están en el panel', () => {
    const { esperadas } = reservasEsperadas(correos);
    expect(contarEn(new Set(['AN-1', 'OTRA']), esperadas)).toBe(1);
  });
});

describe('duracion', () => {
  it('muestra milisegundos, segundos o minutos', () => {
    expect(duracion(850)).toBe('850 ms');
    expect(duracion(12_440)).toBe('12,4 s');
    expect(duracion(125_000)).toBe('2 min 05 s');
    expect(duracion(Infinity)).toBe('-');
  });
});
