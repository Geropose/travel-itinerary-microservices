// Arranque de gateway: lee la configuración, abre las conexiones y empieza a escuchar.
import { fileURLToPath } from 'node:url';
import { cargarConfig, crearLogger } from '@trotamundos/comun';
import {
  conectarBroker,
  crearPool,
  crearValidador,
  iniciarPublicadorOutbox,
  migrar,
  MIGRACIONES_EVENTOS,
  MIGRACIONES_REGISTRO_ACCESOS,
  registroEnBase,
} from '@trotamundos/comun';
import { crearApp, SERVICIO } from './app.ts';
import { esquemaConfig } from './config.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({ servicio: SERVICIO, region: config.REGION, nivel: config.NIVEL_LOG });

const pool = crearPool({ url: config.URL_BASE });
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
const validador = crearValidador({
  servicio: SERVICIO,
  region: config.REGION,
  logger,
  claves: { [config.REGION]: { url: config.URL_JWKS } },
  // El gateway guarda sus rechazos directo, sin pasar por el broker (CONVENCIONES 4.5).
  registrar: registroEnBase(pool, logger),
  // Rutas internas con token de servicio: 'MÉTODO /ruta': { servicios: [...] }
  reglas: {},
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
