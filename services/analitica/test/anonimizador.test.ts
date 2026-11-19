// Pruebas unitarias del Anonimizador (P2.C4, Iteración 6, ADR-016, ADR-017, CONST-6).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crearEvento, DIR_SCHEMAS } from '@trotamundos/comun';
import { describe, expect, it } from 'vitest';
import {
  aFechaSinHora,
  anonimizarViajeActualizado,
  calcularCodigoReserva,
  ErrorFilaAnonimizadaInvalida,
  validarViajeAnonimizado,
} from '../src/anonimizador.ts';
import type { ViajeActualizadoDatos } from '../src/modelo.ts';

const SECRETO_R1 = 'secreto-analitica-region-1-super-seguro';
const SECRETO_R2 = 'secreto-analitica-region-2-super-seguro';

describe('Anonimizador de Analítica (ViajeActualizado -> ViajeAnonimizado)', () => {
  it('calcula codigoReserva determinístico con HMAC-SHA256 en hex minúscula y dependiente del secreto regional', () => {
    const c1 = calcularCodigoReserva('XKQ7PL', SECRETO_R1);
    const c2 = calcularCodigoReserva('XKQ7PL', SECRETO_R1);
    const cOtraRegion = calcularCodigoReserva('XKQ7PL', SECRETO_R2);

    expect(c1).toMatch(/^[0-9a-f]{64}$/);
    expect(c1).toBe(c2);
    expect(c1).not.toBe(cOtraRegion);
    expect(c1).not.toContain('XKQ7PL');
  });

  it('recorta inicio y fin a fecha pura YYYY-MM-DD sin hora', () => {
    expect(aFechaSinHora('2026-12-10T08:30:00Z')).toBe('2026-12-10');
    expect(aFechaSinHora('2026-12-10T23:30:00-03:00')).toBe('2026-12-11');
    expect(aFechaSinHora('2026-12-14')).toBe('2026-12-14');
    expect(() => aFechaSinHora('no-es-fecha')).toThrow(ErrorFilaAnonimizadaInvalida);
  });

  it('anonimiza ViajeActualizado quitando numeroReserva, hora y cualquier campo extra o personal', () => {
    const datosConExtras = {
      numeroReserva: 'XKQ7PL',
      proveedor: 'aerolinea-andina',
      tipoReserva: 'vuelo',
      origen: 'Buenos Aires (EZE)',
      destino: 'Santiago (SCL)',
      inicio: '2026-12-10T08:30:00Z',
      fin: '2026-12-10T10:45:00Z',
      estado: 'confirmada',
      origenCambio: 'correo',
      // Campos personales simulados que nunca deben sobrevivir a la anonimización:
      usuarioId: '3b6f0c2e-5d1a-4c8e-9f7b-1a2b3c4d5e6f',
      reservaId: '4c2e8f1a-7b3d-4a5e-9c6f-0d1e2f3a4b5c',
      email: 'ana@trotamundos.example',
      nombre: 'Ana García',
    } as unknown as ViajeActualizadoDatos;

    const sobre = crearEvento('ViajeActualizado', datosConExtras, 'region-1');
    const fila = anonimizarViajeActualizado(sobre, SECRETO_R1, 'region-1');

    expect(fila).toEqual({
      codigoReserva: calcularCodigoReserva('XKQ7PL', SECRETO_R1),
      region: 'region-1',
      proveedor: 'aerolinea-andina',
      tipoReserva: 'vuelo',
      origen: 'Buenos Aires (EZE)',
      destino: 'Santiago (SCL)',
      inicio: '2026-12-10',
      fin: '2026-12-10',
      estado: 'confirmada',
      origenCambio: 'correo',
    });

    const serializado = JSON.stringify(fila);
    expect(serializado).not.toContain('XKQ7PL');
    expect(serializado).not.toContain('usuarioId');
    expect(serializado).not.toContain('reservaId');
    expect(serializado).not.toContain('ana@trotamundos.example');
    expect(serializado).not.toContain('Ana García');
  });

  it('rechaza eventos que no pertenecen a la región del anonimizador (CONST-6)', () => {
    const sobre = crearEvento<ViajeActualizadoDatos>(
      'ViajeActualizado',
      {
        numeroReserva: 'HC-48213',
        proveedor: 'hotel-cordillera',
        tipoReserva: 'hotel',
        destino: 'Santiago',
        inicio: '2026-12-10T15:00:00Z',
        fin: '2026-12-14T11:00:00Z',
        estado: 'confirmada',
        origenCambio: 'manual',
      },
      'region-2',
    );
    expect(() => anonimizarViajeActualizado(sobre, SECRETO_R1, 'region-1')).toThrow(
      ErrorFilaAnonimizadaInvalida,
    );
  });

  it('valida estrictamente contra specs/schemas/ViajeAnonimizado.json y rechaza cualquier campo de más', () => {
    const valido = JSON.parse(
      readFileSync(join(DIR_SCHEMAS, 'ejemplos', 'ViajeAnonimizado.valido.json'), 'utf8'),
    ) as Record<string, unknown>;
    const invalido = JSON.parse(
      readFileSync(join(DIR_SCHEMAS, 'ejemplos', 'ViajeAnonimizado.invalido.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(validarViajeAnonimizado(valido)).toEqual(valido);
    expect(() => validarViajeAnonimizado(invalido)).toThrow(ErrorFilaAnonimizadaInvalida);
    expect(() => validarViajeAnonimizado({ ...valido, email: 'ana@example.com' })).toThrow(
      ErrorFilaAnonimizadaInvalida,
    );
    expect(() => validarViajeAnonimizado({ ...valido, numeroReserva: 'XKQ7PL' })).toThrow(
      ErrorFilaAnonimizadaInvalida,
    );
    expect(() => validarViajeAnonimizado({ ...valido, inicio: '2026-12-10T08:30:00Z' })).toThrow(
      ErrorFilaAnonimizadaInvalida,
    );
    expect(() =>
      validarViajeAnonimizado({ ...valido, inicio: '2026-12-15', fin: '2026-12-10' }),
    ).toThrow(ErrorFilaAnonimizadaInvalida);
  });
});
