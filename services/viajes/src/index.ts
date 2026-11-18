// Arranque de viajes: lee la configuración, abre las conexiones y empieza a escuchar.
import { fileURLToPath } from 'node:url';
import { cargarConfig, crearLogger } from '@trotamundos/comun';
import {
  conectarBroker,
  crearPool,
  crearValidador,
  iniciarPublicadorOutbox,
  migrar,
  MIGRACIONES_EVENTOS,
  registroPorEvento,
} from '@trotamundos/comun';
import { crearApp, SERVICIO } from './app.ts';
import { crearCacheNula, crearCacheRedis } from './cache.ts';
import { esquemaConfig } from './config.ts';
import { registrarConsumidoresViajes } from './consumidores.ts';
import { crearGestorViajes } from './gestor.ts';
import { crearNegocioViajes } from './rutas.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({ servicio: SERVICIO, region: config.REGION, nivel: config.NIVEL_LOG });

const pool = crearPool({
  url: config.URL_BASE,
  maximo: Math.max(10, config.CANTIDAD_CONSUMIDORES * 2),
});
pool.on('error', (err) => {
  logger.warn({ err }, 'error en conexión inactiva de la base principal');
});
const poolLectura =
  config.URL_BASE_LECTURA && config.URL_BASE_LECTURA !== config.URL_BASE
    ? crearPool({ url: config.URL_BASE_LECTURA, maximo: 15 })
    : pool;
if (poolLectura !== pool) {
  poolLectura.on('error', (err) => {
    logger.warn({ err }, 'error en conexión inactiva de la read replica');
  });
}
await migrar(
  pool,
  [MIGRACIONES_EVENTOS, fileURLToPath(new URL('../migrations/', import.meta.url))],
  logger,
);
const cache = config.URL_CACHE
  ? await crearCacheRedis({
      url: config.URL_CACHE,
      logger,
      ttlSegundos: config.TTL_CACHE_PANEL_S,
      timeoutMs: config.TIMEOUT_CACHE_MS,
    })
  : crearCacheNula();
const broker = await conectarBroker({
  url: config.URL_BROKER,
  servicio: SERVICIO,
  region: config.REGION,
  logger,
});
const registrarRechazo = registroPorEvento(broker, logger);
const validador = crearValidador({
  servicio: SERVICIO,
  region: config.REGION,
  logger,
  claves: { [config.REGION]: { url: config.URL_JWKS } },
  registrar: registrarRechazo,
  // Rutas internas con token de servicio: 'MÉTODO /ruta': { servicios: [...] }
  reglas: {},
});
const gestor = crearGestorViajes({
  region: config.REGION,
  logger,
  margenAgrupacionMs: config.MARGEN_AGRUPACION_HORAS * 60 * 60 * 1000,
});
const negocio = crearNegocioViajes({
  poolPrincipal: pool,
  poolLectura,
  cache,
  gestor,
  logger,
  registrar: registrarRechazo,
});
await registrarConsumidoresViajes({
  broker,
  pool,
  gestor,
  logger,
  cantidadConsumidores: config.CANTIDAD_CONSUMIDORES,
  prefetch: config.PREFETCH_CONSUMIDORES,
  alCambiarUsuario: (usuarioId) => cache.invalidar(usuarioId),
});
const outbox = iniciarPublicadorOutbox({ pool, broker, logger });

const servidor = crearApp({
  region: config.REGION,
  puerto: config.PUERTO,
  logger,
  validador,
  negocio,
  chequeos: {
    base: () => pool.query('SELECT 1'),
    broker: () => broker.verificar(),
  },
});
// Se apagan en orden inverso: primero el outbox, después cache/broker y al final las bases.
servidor.alApagar(() => pool.end());
if (poolLectura !== pool) {
  servidor.alApagar(() => poolLectura.end());
}
servidor.alApagar(() => broker.cerrar());
servidor.alApagar(() => cache.cerrar());
servidor.alApagar(() => outbox.detener());

await servidor.iniciar();
