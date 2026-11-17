import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { crearEvento, DIR_SCHEMAS, ErrorEventoInvalido, validadorEventos } from '../src/eventos.ts';

const ejemplo = (nombre: string): unknown =>
  JSON.parse(readFileSync(`${DIR_SCHEMAS}ejemplos/${nombre}.json`, 'utf8'));

describe('validación de eventos', () => {
  const validador = validadorEventos();

  it('acepta los ejemplos válidos de specs/schemas', () => {
    for (const tipo of ['ReservaDetectada', 'AccesoRechazado', 'ViajeActualizado']) {
      expect(validador.validar(ejemplo(`${tipo}.valido`)).tipo).toBe(tipo);
    }
  });

  it('rechaza los ejemplos inválidos con el detalle del error', () => {
    expect(() => validador.validar(ejemplo('AccesoRechazado.invalido'))).toThrow(
      ErrorEventoInvalido,
    );
    expect(() => validador.validar(ejemplo('AccesoRechazado.invalido'))).toThrow(/\/datos\/status/);
  });

  it('rechaza un tipo desconocido', () => {
    expect(() => validador.validar({ tipo: 'Otro' })).toThrow(/tipo desconocido/);
  });

  it('crearEvento arma un sobre válido', () => {
    const sobre = crearEvento(
      'FiltrosActualizados',
      {
        usuarioId: '6c1e8a2f-4b3d-4e5f-9a0b-1c2d3e4f5a6b',
        remitentesPermitidos: ['@aerolinea.com'],
        filtrosActivos: true,
      },
      'region-1',
    );
    expect(validador.validar(sobre)).toBe(sobre);
    expect(sobre).toMatchObject({ version: 1, region: 'region-1', tipo: 'FiltrosActualizados' });
  });
});
