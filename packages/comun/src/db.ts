import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Logger } from './logger.ts';

export type Pool = pg.Pool;
export type ClienteDb = pg.PoolClient;

/** Migraciones del kit: tablas eventos_salientes (outbox) y eventos_procesados (idempotencia). */
export const MIGRACIONES_EVENTOS = fileURLToPath(
  new URL('../migraciones/eventos/', import.meta.url),
);
/** Migración de la tabla accesos_rechazados de la base registro_accesos (la usa el gateway). */
export const MIGRACIONES_REGISTRO_ACCESOS = fileURLToPath(
  new URL('../migraciones/registro-accesos/', import.meta.url),
);

export interface OpcionesPool {
  url: string;
  maximo?: number;
  logger?: Logger;
  connectionTimeoutMillis?: number;
  statementTimeoutMs?: number;
  queryTimeoutMs?: number;
}

/** Pool de conexiones de PostgreSQL de un servicio (una base por servicio, ADR-001). */
export function crearPool({
  url,
  maximo = 10,
  logger,
  connectionTimeoutMillis = 5000,
  statementTimeoutMs,
  queryTimeoutMs,
}: OpcionesPool): Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max: maximo,
    connectionTimeoutMillis,
    ...(statementTimeoutMs !== undefined ? { statement_timeout: statementTimeoutMs } : {}),
    ...(queryTimeoutMs !== undefined ? { query_timeout: queryTimeoutMs } : {}),
  });
  pool.on('error', (error) => {
    logger?.error({ err: error }, 'Error en conexión inactiva de PostgreSQL');
  });
  return pool;
}

/**
 * Ejecuta fn dentro de una transacción: COMMIT si termina bien, ROLLBACK si lanza un error (y el
 * error se vuelve a lanzar). Si falla el ROLLBACK, descarta la conexión del pool.
 */
export async function enTransaccion<T>(
  pool: Pool,
  fn: (cliente: ClienteDb) => Promise<T>,
): Promise<T> {
  const cliente = await pool.connect();
  let destruir = false;
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    try {
      await cliente.query('ROLLBACK');
    } catch {
      destruir = true;
    }
    throw error;
  } finally {
    cliente.release(destruir ? true : undefined);
  }
}

/** Número que identifica el lock de las migraciones (pg_advisory_lock). */
const LOCK_MIGRACIONES = 7_412_001;

/**
 * Aplica las migraciones pendientes al arrancar. Cada carpeta tiene archivos SQL numerados
 * (001_crear_viajes.sql, 002_...); se ordenan por nombre entre todas las carpetas y cada uno se
 * aplica una sola vez, en su propia transacción. Los nombres tienen que ser únicos (los del kit
 * empiezan con 000_comun_). Si arrancan dos instancias juntas, la segunda espera a la primera.
 */
export async function migrar(pool: Pool, carpetas: string[], logger?: Logger): Promise<string[]> {
  const archivos = carpetas
    .flatMap((carpeta) =>
      readdirSync(carpeta)
        .filter((nombre) => nombre.endsWith('.sql'))
        .map((nombre) => ({ nombre, ruta: join(carpeta, nombre) })),
    )
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  const repetido = archivos.find((a, i) => archivos[i + 1]?.nombre === a.nombre);
  if (repetido) throw new Error(`Migración repetida: ${repetido.nombre}`);

  const cliente = await pool.connect();
  const aplicadas: string[] = [];
  let destruir = false;
  try {
    await cliente.query('SELECT pg_advisory_lock($1)', [LOCK_MIGRACIONES]);
    await cliente.query(
      `CREATE TABLE IF NOT EXISTS migraciones (
         nombre text PRIMARY KEY,
         aplicada_en timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await cliente.query<{ nombre: string }>('SELECT nombre FROM migraciones');
    const hechas = new Set(rows.map((r) => r.nombre));
    for (const archivo of archivos) {
      if (hechas.has(archivo.nombre)) continue;
      await cliente.query('BEGIN');
      try {
        await cliente.query(readFileSync(archivo.ruta, 'utf8'));
        await cliente.query('INSERT INTO migraciones (nombre) VALUES ($1)', [archivo.nombre]);
        await cliente.query('COMMIT');
      } catch (error) {
        try {
          await cliente.query('ROLLBACK');
        } catch {
          destruir = true;
        }
        throw new Error(`Falló la migración ${archivo.nombre}`, { cause: error });
      }
      aplicadas.push(archivo.nombre);
      logger?.info({ migracion: archivo.nombre }, 'Migración aplicada');
    }
  } finally {
    try {
      await cliente.query('SELECT pg_advisory_unlock($1)', [LOCK_MIGRACIONES]);
    } catch {
      destruir = true;
    }
    cliente.release(destruir ? true : undefined);
  }
  return aplicadas;
}
