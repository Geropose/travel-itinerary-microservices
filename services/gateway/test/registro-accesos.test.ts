import type {
  AccesoRechazado,
  Broker,
  ClienteDb,
  OpcionesConsumidor,
  Pool,
  Sobre,
} from '@trotamundos/comun';
import { loggerDePrueba } from '@trotamundos/comun/pruebas';
import { describe, expect, it } from 'vitest';
import { consumirAccesosRechazados } from '../src/registro-accesos.ts';

const rechazo: AccesoRechazado = {
  servicio: 'viajes',
  metodo: 'GET',
  ruta: '/viajes/{viajeId}',
  status: 403,
  motivo: 'sin-permiso',
  usuarioId: '6c1e8a2f-4b3d-4e5f-9a0b-1c2d3e4f5a6b',
  ip: '10.0.0.7',
  requestId: 'req-1',
};

describe('registro de accesos del gateway (consumirAccesoRechazado)', () => {
  it('consume AccesoRechazado y guarda el rechazo con la fecha en que ocurrió', async () => {
    let suscripcion: OpcionesConsumidor<AccesoRechazado> | undefined;
    const broker: Pick<Broker, 'consumir'> = {
      consumir: async <D>(opciones: OpcionesConsumidor<D>) => {
        suscripcion = opciones as unknown as OpcionesConsumidor<AccesoRechazado>;
      },
    };
    const pool = {} as Pool;

    await consumirAccesosRechazados({ broker, pool, logger: loggerDePrueba('gateway').logger });

    // Cola por defecto gateway.AccesoRechazado (x-cola del contrato), sobre la base del gateway.
    expect(suscripcion?.tipo).toBe('AccesoRechazado');
    expect(suscripcion?.pool).toBe(pool);
    expect(suscripcion?.cola).toBeUndefined();

    const consultas: { sql: string; valores: unknown[] }[] = [];
    const cliente = {
      query: async (sql: string, valores: unknown[]) => {
        consultas.push({ sql, valores });
        return { rows: [], rowCount: 1 };
      },
    } as unknown as ClienteDb;
    const evento: Sobre<AccesoRechazado> = {
      eventId: '0b6f1a52-3c1d-4e8a-9f2b-7d4c5e6a1b2c',
      tipo: 'AccesoRechazado',
      version: 1,
      ocurridoEn: '2026-11-21T12:00:00.000Z',
      region: 'region-1',
      datos: rechazo,
    };
    await suscripcion?.manejar(evento as unknown as Sobre<AccesoRechazado>, cliente);

    expect(consultas).toHaveLength(1);
    expect(consultas[0]?.sql).toContain('INSERT INTO accesos_rechazados');
    expect(consultas[0]?.valores).toEqual([
      new Date('2026-11-21T12:00:00.000Z'),
      'viajes',
      'GET',
      '/viajes/{viajeId}',
      403,
      'sin-permiso',
      rechazo.usuarioId,
      '10.0.0.7',
      'req-1',
    ]);
  });
});
