// Arranque de correo: lee la configuración, abre las conexiones y empieza a escuchar.
import { fileURLToPath } from 'node:url';
import {
  cargarConfig,
  conectarBroker,
  crearLogger,
  crearPool,
  crearValidador,
  iniciarPublicadorOutbox,
  migrar,
  MIGRACIONES_EVENTOS,
  registroPorEvento,
} from '@trotamundos/comun';
import { crearApp, crearNegocioCorreo, SERVICIO } from './app.ts';
import { esquemaConfig, resolverConfigAdaptadores } from './config.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({ servicio: SERVICIO, region: config.REGION, nivel: config.NIVEL_LOG });
const adaptadoresConfig = resolverConfigAdaptadores(config);

const pool = crearPool({ url: config.URL_BASE });
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
const outbox = iniciarPublicadorOutbox({ pool, broker, logger });

const negocio = crearNegocioCorreo({
  pool,
  claveTokensBase64: config.CLAVE_TOKENS_CORREO,
  urlWeb: config.URL_WEB,
  logger,
  margenRenovacionMs: config.MARGEN_RENOVACION_SEG * 1000,
  gmail: adaptadoresConfig.gmail,
  outlook: adaptadoresConfig.outlook,
});

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
// Se apagan en orden inverso: primero el outbox, después el broker y al final la base.
servidor.alApagar(() => pool.end());
servidor.alApagar(() => broker.cerrar());
servidor.alApagar(() => outbox.detener());

await servidor.iniciar();
