import { describe, expect, it } from 'vitest';
import { leerArgumentosFailover, pasosPromoverReplicaViajes } from './failover-viajes.ts';

describe('failover de Viajes (P3.5, ADR-012)', () => {
  it('interpreta argumentos por defecto, --solo y --restaurar', () => {
    expect(leerArgumentosFailover([])).toEqual({ proyecto: 'r1', restaurar: false });
    expect(leerArgumentosFailover(['--solo', 'r2'])).toEqual({ proyecto: 'r2', restaurar: false });
    expect(leerArgumentosFailover(['--solo', 'r2', '--restaurar'])).toEqual({
      proyecto: 'r2',
      restaurar: true,
    });
    expect(() => leerArgumentosFailover(['--solo', 'r3'])).toThrow(/r1 o r2/);
    expect(() => leerArgumentosFailover(['--desconocido'])).toThrow(/desconocido/i);
  });

  it('arma los pasos de promoción con pg_promote, reasignación DNS y reinicio de Viajes', () => {
    const pasos = pasosPromoverReplicaViajes('r1', ['r1-viajes-1', 'r1-viajes-2']);
    expect(pasos.map((p) => p.args)).toEqual([
      ['stop', 'r1-postgres-viajes-1'],
      ['network', 'disconnect', '-f', 'r1_region', 'r1-postgres-viajes-1'],
      [
        'exec',
        'r1-postgres-viajes-replica-1',
        'psql',
        '-U',
        'admin',
        '-d',
        'postgres',
        '-tAc',
        'SELECT pg_promote(true, 30)',
      ],
      ['network', 'disconnect', 'r1_region', 'r1-postgres-viajes-replica-1'],
      [
        'network',
        'connect',
        '--alias',
        'postgres-viajes',
        '--alias',
        'postgres-viajes-replica',
        'r1_region',
        'r1-postgres-viajes-replica-1',
      ],
      ['restart', 'r1-viajes-1', 'r1-viajes-2'],
    ]);
  });
});
