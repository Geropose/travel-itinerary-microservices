// Semillas de Autenticación: crea el usuario analista de prueba en la base de esta región.
//
//   npm run semillas -w services/autenticacion        (con URL_BASE y CONTRASENA_ANALISTA)
//
// npm run infra:levantar lo corre en cada región. Se puede correr varias veces: si el analista ya
// existe, solo le actualiza la contraseña.
import { fileURLToPath } from 'node:url';
import {
  cargarConfig,
  crearLogger,
  crearPool,
  migrar,
  MIGRACIONES_EVENTOS,
} from '@trotamundos/comun';
import { z } from 'zod';
import { EMAIL_ANALISTA, sembrarAnalista } from './analista.ts';

const config = cargarConfig(
  z.object({
    REGION: z.enum(['region-1', 'region-2']),
    URL_BASE: z.url(),
    CONTRASENA_ANALISTA: z.string().min(8),
    EMAIL_ANALISTA: z.email().default(EMAIL_ANALISTA),
  }),
);
const logger = crearLogger({ servicio: 'autenticacion', region: config.REGION, nivel: 'info' });
const pool = crearPool({ url: config.URL_BASE, maximo: 1 });
try {
  await migrar(
    pool,
    [MIGRACIONES_EVENTOS, fileURLToPath(new URL('../migrations/', import.meta.url))],
    logger,
  );
  const usuarioId = await sembrarAnalista(pool, config.CONTRASENA_ANALISTA, config.EMAIL_ANALISTA);
  logger.info({ usuarioId }, `Analista de prueba listo: ${config.EMAIL_ANALISTA}`);
} finally {
  await pool.end();
}
