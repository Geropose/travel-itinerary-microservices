import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Broker, ClienteDb, Pool, Sobre } from '@trotamundos/comun';
import { loggerDePrueba } from '@trotamundos/comun/pruebas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registrarConsumidorAnonimizador } from '../src/consumidor.ts';
import { ejecutarMapReduce } from '../src/mapreduce.ts';
import type { ViajeActualizadoDatos } from '../src/modelo.ts';
import { crearEjecucion, guardarFilaAnonimizadaEnCliente } from '../src/repositorio.ts';
import { crearNegocioAnalitica } from '../src/rutas.ts';

function crearWorkerTemporal(dirsTemp: string[], nombre: string, codigo: string): URL {
  const dir = mkdtempSync(join(tmpdir(), 'mr-auditoria-'));
  dirsTemp.push(dir);
  const ruta = join(dir, nombre);
  writeFileSync(ruta, codigo, 'utf8');
  return pathToFileURL(ruta);
}

describe('Auditoría de Analítica (sin Docker)', () => {
  const { logger } = loggerDePrueba('analitica-auditoria');
  const dirsTemp: string[] = [];

  afterEach(() => {
    while (dirsTemp.length > 0) {
      const dir = dirsTemp.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C1: crearEjecucion expira huérfanas antes de insertar y reintenta tras carrera 23505', async () => {
    const consultaId = randomUUID();
    const ahora = new Date('2026-11-22T12:00:00.000Z');
    const consultas: Array<{ sql: string; params?: unknown[] }> = [];
    let intentoInsert = 0;

    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        consultas.push({ sql, params });
        if (sql.includes('UPDATE ejecuciones_consultas') && sql.includes('actualizado_en < $1')) {
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('INSERT INTO ejecuciones_consultas')) {
          intentoInsert++;
          if (intentoInsert === 1) {
            const err = new Error('duplicate key') as Error & { code?: string };
            err.code = '23505';
            throw err;
          }
          return {
            rows: [
              {
                consulta_id: consultaId,
                tipo: 'destinos',
                parametros: { desde: '2025-01-01', hasta: '2025-12-31', limite: 10 },
                estado: 'pendiente',
                procesadores: 0,
                progreso: 0,
                creada_en: ahora,
                iniciada_en: null,
                terminada_en: null,
                duracion_ms: null,
                resultado: null,
                error: null,
              },
            ],
          };
        }
        if (sql.includes('SELECT consulta_id') && sql.includes('clave_dedup = $1')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    } as unknown as Pool;

    const alta = await crearEjecucion(db, {
      consultaId,
      tipo: 'destinos',
      parametros: { desde: '2025-01-01', hasta: '2025-12-31', limite: 10 },
      claveDedup: 'destinos:2025-01-01:2025-12-31:10',
      creadaEn: ahora,
      ttlHuerfanaMs: 60_000,
    });

    expect(alta.creada).toBe(true);
    expect(intentoInsert).toBe(2);
    expect(consultas[0]?.sql).toContain('actualizado_en < $1');
    const umbral = consultas[0]?.params?.[0] as Date;
    expect(umbral.toISOString()).toBe('2026-11-22T11:59:00.000Z');
  });

  it('C1 y C4: actualiza heartbeat en ejecución activa y reintenta marcarEjecucionFallida ante fallos transitorios', async () => {
    const consultaId = randomUUID();
    let heartbeats = 0;
    let intentosFallo = 0;

    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('UPDATE ejecuciones_consultas') && sql.includes('actualizado_en < $1')) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('INSERT INTO ejecuciones_consultas')) {
          return {
            rows: [
              {
                consulta_id: consultaId,
                tipo: 'tendencias',
                parametros: { anio: 2025, agruparPor: 'mes' },
                estado: 'pendiente',
                procesadores: 0,
                progreso: 0,
                creada_en: new Date('2026-11-22T12:00:00Z'),
                iniciada_en: null,
                terminada_en: null,
                duracion_ms: null,
                resultado: null,
                error: null,
              },
            ],
          };
        }
        if (sql.includes('SET actualizado_en = $2') && !sql.includes("estado = 'fallida'")) {
          heartbeats++;
          return { rows: [] };
        }
        if (sql.includes("SET estado = 'fallida'")) {
          intentosFallo++;
          if (intentosFallo < 3) {
            throw new Error('Error transitorio de conexión');
          }
          return { rows: [] };
        }
        return { rows: [] };
      }),
    } as unknown as Pool;

    const negocio = crearNegocioAnalitica({
      poolAnalitica: pool,
      urlBaseAnalitica: 'postgres://unused',
      logger,
      intervaloHeartbeatMs: 50,
      reintentosFalloMs: [10, 10],
      ejecutarMr: async () => {
        await new Promise((r) => setTimeout(r, 140));
        throw new Error('Fallo simulado de Map-Reduce');
      },
    });

    await negocio.lanzarEjecucion('tendencias', { anio: 2025 });
    await negocio.detener();

    expect(heartbeats).toBeGreaterThanOrEqual(1);
    expect(intentosFallo).toBe(3);
  });

  it('C2 y C3: Map-Reduce falla por timeout de arranque y por salida prematura con código 0, y permite cierre ordenado', async () => {
    const workerColgado = crearWorkerTemporal(
      dirsTemp,
      'colgado.mjs',
      `setInterval(() => {}, 1000);`,
    );
    await expect(
      ejecutarMapReduce({
        urlBaseAnalitica: 'postgres://unused',
        consulta: {
          tipo: 'destinos',
          parametros: { desde: '2025-01-01', hasta: '2025-01-31', limite: 10 },
        },
        procesadores: 1,
        timeoutArranqueMs: 120,
        rutaTrabajador: workerColgado,
      }),
    ).rejects.toThrow(/Tiempo agotado esperando inicio/);

    const workerPrematuro = crearWorkerTemporal(
      dirsTemp,
      'prematuro.mjs',
      `import { parentPort } from 'node:worker_threads';
parentPort?.on('message', (msg) => {
  if (msg?.tipo === 'bloque') process.exit(0);
});
parentPort?.postMessage({ tipo: 'listo' });`,
    );
    await expect(
      ejecutarMapReduce({
        urlBaseAnalitica: 'postgres://unused',
        consulta: {
          tipo: 'destinos',
          parametros: { desde: '2025-01-01', hasta: '2025-01-31', limite: 10 },
        },
        procesadores: 1,
        rutaTrabajador: workerPrematuro,
      }),
    ).rejects.toThrow(/finalizó inesperadamente con código 0/);

    const workerOrdenado = crearWorkerTemporal(
      dirsTemp,
      'ordenado.mjs',
      `import { parentPort } from 'node:worker_threads';
parentPort?.on('message', (msg) => {
  if (msg?.tipo === 'fin') {
    parentPort?.close();
    process.exit(0);
    return;
  }
  if (msg?.tipo === 'bloque') {
    const demora = msg.bloque.id === 4 ? 40 : 5;
    setTimeout(() => {
      parentPort?.postMessage({
        tipo: 'resultado',
        bloqueId: msg.bloque.id,
        parcial: { tipo: 'destinos', totalReservas: 2, porDestino: { SCL: 2 } },
      });
    }, demora);
  }
});
parentPort?.postMessage({ tipo: 'listo' });`,
    );
    const res = await ejecutarMapReduce({
      urlBaseAnalitica: 'postgres://unused',
      consulta: {
        tipo: 'destinos',
        parametros: { desde: '2025-01-01', hasta: '2025-05-31', limite: 10 },
      },
      procesadores: 4,
      graciaApagadoMs: 500,
      rutaTrabajador: workerOrdenado,
    });
    expect(res.resultado).toMatchObject({ totalReservas: 10 });
  });

  it('C10: omite eventos desordenados más antiguos y reutiliza cliente si poolAnalitica === poolRegional', async () => {
    const codigo = 'a'.repeat(64);
    const filaBase = {
      codigoReserva: codigo,
      region: 'region-1' as const,
      proveedor: 'aerolinea-andina',
      tipoReserva: 'vuelo' as const,
      origen: 'EZE',
      destino: 'SCL',
      inicio: '2026-12-10',
      fin: '2026-12-10',
      estado: 'confirmada' as const,
      origenCambio: 'correo' as const,
    };

    const consultasVieja: string[] = [];
    const clientVieja = {
      query: vi.fn(async (sql: string) => {
        consultasVieja.push(sql);
        if (sql.includes('FROM reservas_anonimizadas')) {
          return {
            rows: [
              {
                codigo_reserva: codigo,
                region: 'region-1',
                proveedor: 'aerolinea-andina',
                tipo_reserva: 'vuelo',
                origen: 'EZE',
                destino: 'SCL',
                inicio: '2026-12-10',
                fin: '2026-12-10',
                estado: 'modificada',
                origen_cambio: 'proveedor',
                actualizado_en: new Date('2026-11-22T12:00:00Z'),
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as ClienteDb;

    const rVieja = await guardarFilaAnonimizadaEnCliente(
      clientVieja,
      filaBase,
      new Date('2026-11-22T11:59:00Z'),
    );
    expect(rVieja.accion).toBe('omitida');
    expect(consultasVieja.some((s) => s.includes('UPDATE reservas_anonimizadas'))).toBe(false);

    const clientIgual = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM reservas_anonimizadas')) {
          return {
            rows: [
              {
                codigo_reserva: codigo,
                region: 'region-1',
                proveedor: 'aerolinea-andina',
                tipo_reserva: 'vuelo',
                origen: 'EZE',
                destino: 'SCL',
                inicio: '2026-12-10',
                fin: '2026-12-10',
                estado: 'confirmada',
                origen_cambio: 'correo',
                actualizado_en: new Date('2026-11-22T12:00:00Z'),
              },
            ],
          };
        }
        if (sql.includes('UPDATE reservas_anonimizadas')) {
          return {
            rows: [
              {
                codigo_reserva: codigo,
                region: 'region-1',
                proveedor: 'aerolinea-andina',
                tipo_reserva: 'vuelo',
                origen: 'EZE',
                destino: 'SCL',
                inicio: '2026-12-10',
                fin: '2026-12-10',
                estado: 'modificada',
                origen_cambio: 'manual',
                actualizado_en: new Date('2026-11-22T12:00:00Z'),
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as ClienteDb;

    const rIgual = await guardarFilaAnonimizadaEnCliente(
      clientIgual,
      { ...filaBase, estado: 'modificada', origenCambio: 'manual' },
      new Date('2026-11-22T12:00:00Z'),
    );
    expect(rIgual.accion).toBe('actualizada');

    const manejadores: Array<
      (sobre: Sobre<ViajeActualizadoDatos>, db: ClienteDb) => Promise<void>
    > = [];
    const broker = {
      consumir: vi.fn(async (cfg) => {
        manejadores.push(cfg.manejar);
      }),
    } as unknown as Broker;
    const mismoPool = {
      connect: vi.fn(),
      query: vi.fn(),
    } as unknown as Pool;

    await registrarConsumidorAnonimizador({
      broker,
      poolRegional: mismoPool,
      poolAnalitica: mismoPool,
      region: 'region-1',
      secretoAnalitica: 'secreto-analitica-auditoria-min-16',
      logger,
      cantidadConsumidores: 1,
    });

    const clienteTx = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM reservas_anonimizadas')) return { rows: [] };
        if (sql.includes('INSERT INTO reservas_anonimizadas')) {
          return {
            rows: [
              {
                codigo_reserva: codigo,
                region: 'region-1',
                proveedor: 'aerolinea-andina',
                tipo_reserva: 'vuelo',
                origen: 'EZE',
                destino: 'SCL',
                inicio: '2026-12-10',
                fin: '2026-12-10',
                estado: 'confirmada',
                origen_cambio: 'correo',
                actualizado_en: new Date('2026-11-22T13:00:00Z'),
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as ClienteDb;

    const manejador = manejadores[0];
    expect(manejador).toBeDefined();
    await manejador?.(
      {
        eventId: randomUUID(),
        tipo: 'ViajeActualizado',
        version: 1,
        ocurridoEn: '2026-11-22T13:00:00.000Z',
        region: 'region-1',
        datos: {
          proveedor: 'aerolinea-andina',
          tipoReserva: 'vuelo',
          numeroReserva: 'RES-99',
          origen: 'EZE',
          destino: 'SCL',
          inicio: '2026-12-10T10:00:00Z',
          fin: '2026-12-10T13:00:00Z',
          estado: 'confirmada',
          origenCambio: 'correo',
        },
      },
      clienteTx,
    );
    expect(mismoPool.connect).not.toHaveBeenCalled();
  });
});
