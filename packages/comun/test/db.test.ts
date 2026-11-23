import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { crearPool, enTransaccion, migrar, type Pool } from '../src/db.ts';
import { loggerDePrueba } from '../src/pruebas/index.ts';

describe('db (pool, transacciones y migraciones)', () => {
  it('crearPool registra listener de error en el pool y loguea errores de conexión inactiva', async () => {
    const { logger, lineas } = loggerDePrueba('db-test');
    const pool = crearPool({
      url: 'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
      logger,
    });
    expect(() => {
      pool.emit('error', new Error('conexion idle cerrada'));
    }).not.toThrow();
    expect(lineas).toContainEqual(
      expect.objectContaining({
        nivel: 'error',
        mensaje: 'Error en conexión inactiva de PostgreSQL',
      }),
    );
    await pool.end();
  });

  it('enTransaccion destruye el cliente (release(true)) si falla el ROLLBACK', async () => {
    const release = vi.fn();
    const cliente = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'ROLLBACK') throw new Error('canal roto en rollback');
        throw new Error('fallo SQL de negocio');
      }),
      release,
    };
    const pool = { connect: vi.fn(async () => cliente) } as unknown as Pool;

    await expect(
      enTransaccion(pool, async () => {
        throw new Error('fallo SQL de negocio');
      }),
    ).rejects.toThrow('fallo SQL de negocio');

    expect(release).toHaveBeenCalledWith(true);
  });

  it('migrar destruye la conexión y preserva la causa si falla ROLLBACK o pg_advisory_unlock', async () => {
    const carpeta = mkdtempSync(join(tmpdir(), 'migrar-test-'));
    try {
      writeFileSync(join(carpeta, '001_falla.sql'), 'SELECT 1/0;', 'utf8');
      const release = vi.fn();
      const cliente = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM migraciones')) return { rows: [] };
          if (sql.includes('SELECT 1/0;')) throw new Error('sql invalido');
          if (sql === 'ROLLBACK') throw new Error('fallo en rollback');
          if (sql.includes('pg_advisory_unlock')) throw new Error('fallo en unlock');
          return { rows: [] };
        }),
        release,
      };
      const pool = { connect: vi.fn(async () => cliente) } as unknown as Pool;

      await expect(migrar(pool, [carpeta])).rejects.toThrow(/Falló la migración 001_falla\.sql/);
      expect(release).toHaveBeenCalledWith(true);
    } finally {
      rmSync(carpeta, { recursive: true, force: true });
    }
  });
});
