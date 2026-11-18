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
import { esquemaConfig } from './config.ts';
import { registrarConsumidoresViajes } from './consumidores.ts';
import { crearGestorViajes } from './gestor.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({ servicio: SERVICIO, region: config.REGION, nivel: config.NIVEL_LOG });

const pool = crearPool({
  url: config.URL_BASE,
  maximo: Math.max(10, config.CANTIDAD_CONSUMIDORES * 2),
});
await migrar(
  pool,
  [MIGRACIONES_EVENTOS, fileURLToPath(new URL('../migrations/', import.meta.url))],
  logger,
);
const broker = await conectarBroker({
  url: config.URL_BROKER,
  servicio: SERVICIO,
  region: config.REGION,
  logger,
});
const validador = crearValidador({
  servicio: SERVICIO,
  region: config.REGION,
  logger,
  claves: { [config.REGION]: { url: config.URL_JWKS } },
  registrar: registroPorEvento(broker, logger),
  // Rutas internas con token de servicio: 'MÉTODO /ruta': { servicios: [...] }
  reglas: {},
});
const gestor = crearGestorViajes({
  region: config.REGION,
  logger,
  margenAgrupacionMs: config.MARGEN_AGRUPACION_HORAS * 60 * 60 * 1000,
});
await registrarConsumidoresViajes({
  broker,
  pool,
  gestor,
  logger,
  cantidadConsumidores: config.CANTIDAD_CONSUMIDORES,
  prefetch: config.PREFETCH_CONSUMIDORES,
});
const outbox = iniciarPublicadorOutbox({ pool, broker, logger });

const servidor = crearApp({
  region: config.REGION,
  puerto: config.PUERTO,
  logger,
  validador,
  chequeos: {
    base: () => pool.query('SELECT 1'),
    broker: () => broker.verificar(),
  },
});
// Se apagan en orden inverso: primero el outbox, después el broker y al final la base.
servidor.alApagar(() => pool.end());
servidor.alApagar(() => broker.cerrar());
servidor.alApagar(() => outbox.detener());

await servidor.iniciar();
