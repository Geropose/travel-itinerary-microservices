// Arranque de __NOMBRE__: lee la configuración, abre las conexiones y empieza a escuchar.
// dependencias:inicio
import { fileURLToPath } from 'node:url';
// dependencias:fin
import { cargarConfig, crearLogger } from '@trotamundos/comun';
// dependencias:inicio
import {
  conectarBroker,
  crearPool,
  crearValidador,
  iniciarPublicadorOutbox,
  migrar,
  MIGRACIONES_EVENTOS,
  registroPorEvento,
} from '@trotamundos/comun';
// dependencias:fin
import { crearApp, SERVICIO } from './app.ts';
import { esquemaConfig } from './config.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({ servicio: SERVICIO, region: config.REGION, nivel: config.NIVEL_LOG });

// dependencias:inicio
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
// dependencias:fin

const servidor = crearApp({
  region: config.REGION,
  puerto: config.PUERTO,
  logger,
  // dependencias:inicio
  validador,
  chequeos: {
    base: () => pool.query('SELECT 1'),
    broker: () => broker.verificar(),
  },
  // dependencias:fin
});
// dependencias:inicio
// Se apagan en orden inverso: primero el outbox, después el broker y al final la base.
servidor.alApagar(() => pool.end());
servidor.alApagar(() => broker.cerrar());
servidor.alApagar(() => outbox.detener());
// dependencias:fin

await servidor.iniciar();
