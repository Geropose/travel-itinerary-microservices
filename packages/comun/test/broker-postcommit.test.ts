import { describe, expect, it, vi } from 'vitest';
import type { ConsumeMessage } from 'amqplib';
import {
  crearEvento,
  crearLogger,
  procesarMensajeConsumidor,
  validadorEventos,
  type Pool,
} from '../src/index.ts';

function mensajeParaEvento(sobre: unknown): ConsumeMessage {
  return { content: Buffer.from(JSON.stringify(sobre), 'utf8') } as ConsumeMessage;
}

function crearFakePool(opciones?: { repetido?: boolean; fallosCommit?: number }) {
  const pasos: string[] = [];
  let commitsRestantesPorFallar = opciones?.fallosCommit ?? 0;

  const cliente = {
    query: vi.fn(async (sql: string) => {
      if (sql === 'BEGIN') {
        pasos.push('BEGIN');
        return { rowCount: 0, rows: [] };
      }
      if (sql === 'COMMIT') {
        if (commitsRestantesPorFallar > 0) {
          commitsRestantesPorFallar--;
          pasos.push('COMMIT:error');
          throw new Error('fallo transitorio en COMMIT');
        }
        pasos.push('COMMIT');
        return { rowCount: 0, rows: [] };
      }
      if (sql === 'ROLLBACK') {
        pasos.push('ROLLBACK');
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('INSERT INTO eventos_procesados')) {
        pasos.push('marca-evento');
        return { rowCount: opciones?.repetido ? 0 : 1, rows: [] };
      }
      pasos.push(`sql:${sql}`);
      return { rowCount: 1, rows: [] };
    }),
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn(async () => cliente),
  } as unknown as Pool;

  return { pool, pasos };
}

describe('procesarMensajeConsumidor — efecto posterior al commit', () => {
  const validador = validadorEventos();
  const logger = crearLogger({ servicio: 'test', region: 'region-1', nivel: 'silent' });
  const sobre = crearEvento(
    'FiltrosActualizados',
    {
      usuarioId: '6c1e8a2f-4b3d-4e5f-9a0b-1c2d3e4f5a6b',
      remitentesPermitidos: ['@aerolinea.com'],
      filtrosActivos: true,
    },
    'region-1',
  );

  it('ejecuta efectos registrados con alConfirmar recién después del COMMIT y antes del ack', async () => {
    const { pool, pasos } = crearFakePool();
    const canal = {
      ack: vi.fn(() => {
        pasos.push('ack');
      }),
      nack: vi.fn(),
    };

    await procesarMensajeConsumidor<{ usuarioId: string }>(
      canal,
      'test.FiltrosActualizados',
      mensajeParaEvento(sobre),
      {
        tipo: 'FiltrosActualizados',
        pool,
        manejar: async (ev, _cliente, alConfirmar) => {
          pasos.push('manejar');
          alConfirmar?.(async () => {
            pasos.push(`post:${ev.datos.usuarioId}`);
          });
        },
      },
      validador,
      logger,
    );

    expect(pasos).toEqual([
      'BEGIN',
      'marca-evento',
      'manejar',
      'COMMIT',
      'post:6c1e8a2f-4b3d-4e5f-9a0b-1c2d3e4f5a6b',
      'ack',
    ]);
    expect(canal.ack).toHaveBeenCalledTimes(1);
    expect(canal.nack).not.toHaveBeenCalled();
  });

  it('no ejecuta manejar ni efectos ante evento duplicado', async () => {
    const { pool, pasos } = crearFakePool({ repetido: true });
    const canal = { ack: vi.fn(), nack: vi.fn() };
    const manejar = vi.fn();

    await procesarMensajeConsumidor(
      canal,
      'test.FiltrosActualizados',
      mensajeParaEvento(sobre),
      {
        tipo: 'FiltrosActualizados',
        pool,
        manejar,
      },
      validador,
      logger,
    );

    expect(manejar).not.toHaveBeenCalled();
    expect(pasos).toEqual(['BEGIN', 'marca-evento', 'COMMIT']);
    expect(canal.ack).toHaveBeenCalledTimes(1);
  });

  it('si falla el COMMIT descarta el efecto de ese intento y lo corre solo tras el COMMIT exitoso', async () => {
    const { pool, pasos } = crearFakePool({ fallosCommit: 1 });
    const canal = {
      ack: vi.fn(() => {
        pasos.push('ack');
      }),
      nack: vi.fn(),
    };
    const efecto = vi.fn(async () => {
      pasos.push('post');
    });

    await procesarMensajeConsumidor(
      canal,
      'test.FiltrosActualizados',
      mensajeParaEvento(sobre),
      {
        tipo: 'FiltrosActualizados',
        pool,
        esperasReintentoMs: [0],
        manejar: async (_ev, _cliente, alConfirmar) => {
          pasos.push('manejar');
          alConfirmar?.(efecto);
        },
      },
      validador,
      logger,
    );

    expect(efecto).toHaveBeenCalledTimes(1);
    expect(pasos).toEqual([
      'BEGIN',
      'marca-evento',
      'manejar',
      'COMMIT:error',
      'ROLLBACK',
      'BEGIN',
      'marca-evento',
      'manejar',
      'COMMIT',
      'post',
      'ack',
    ]);
    expect(canal.ack).toHaveBeenCalledTimes(1);
    expect(canal.nack).not.toHaveBeenCalled();
  });

  it('si un efecto post-commit falla tras el COMMIT igual confirma con ack y no reintenta', async () => {
    const { pool } = crearFakePool();
    const canal = { ack: vi.fn(), nack: vi.fn() };
    const manejar = vi.fn(async (_ev, _cliente, alConfirmar) => {
      alConfirmar?.(async () => {
        throw new Error('redis no disponible');
      });
    });

    await procesarMensajeConsumidor(
      canal,
      'test.FiltrosActualizados',
      mensajeParaEvento(sobre),
      {
        tipo: 'FiltrosActualizados',
        pool,
        esperasReintentoMs: [0],
        manejar,
      },
      validador,
      logger,
    );

    expect(manejar).toHaveBeenCalledTimes(1);
    expect(canal.ack).toHaveBeenCalledTimes(1);
    expect(canal.nack).not.toHaveBeenCalled();
  });
});
