// Arranque de gateway: lee la configuración, abre las conexiones y empieza a escuchar.
import { fileURLToPath } from 'node:url';
import {
  cargarConfig,
  crearLogger,
  conectarBroker,
  crearPool,
  crearValidador,
  iniciarPublicadorOutbox,
  migrar,
  MIGRACIONES_EVENTOS,
  MIGRACIONES_REGISTRO_ACCESOS,
  registroEnBase,
  type Region,
} from '@trotamundos/comun';
import { crearApp, SERVICIO } from './app.ts';
import { esquemaConfig } from './config.ts';
import { consumirAccesosRechazados } from './registro-accesos.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({ servicio: SERVICIO, region: config.REGION, nivel: config.NIVEL_LOG });
const otraRegion: Region = config.REGION === 'region-1' ? 'region-2' : 'region-1';

const pool = crearPool({ url: config.URL_BASE, logger });
await migrar(
  pool,
  [
    MIGRACIONES_EVENTOS,
    // La base del gateway es registro_accesos (Iteración 5): guarda los accesos rechazados.
    MIGRACIONES_REGISTRO_ACCESOS,
    fileURLToPath(new URL('../migrations/', import.meta.url)),
  ],
  logger,
);
const broker = await conectarBroker({
  url: config.URL_BROKER,
  servicio: SERVICIO,
  region: config.REGION,
  logger,
});
// El gateway guarda sus rechazos directo, sin pasar por el broker (CONVENCIONES 4.5).
const registrar = registroEnBase(pool, logger);
const validador = crearValidador({
  servicio: SERVICIO,
  region: config.REGION,
  logger,
  claves: {
    [config.REGION]: { url: config.URL_JWKS },
    // Solo para reconocer los JWT de la otra región y responder 403 (nunca se aceptan acá).
    [otraRegion]: { url: config.URL_JWKS_OTRA_REGION },
  },
  registrar,
  // Ninguna regla: un token de servicio nunca pasa por el gateway (403).
  reglas: {},
});
const outbox = iniciarPublicadorOutbox({ pool, broker, logger });
// Los rechazos de los microservicios llegan por el broker (Iteración 5, QA-8).
await consumirAccesosRechazados({ broker, pool, logger });

const servidor = crearApp({
  region: config.REGION,
  puerto: config.PUERTO,
  logger,
  validador,
  registrar,
  tiempoMaximoMs: config.TIEMPO_MAXIMO_MS,
  limiteCuerpo: config.LIMITE_CUERPO,
  origenWeb: config.ORIGEN_WEB,
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
