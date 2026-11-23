// Arranque de usuarios: lee la configuración, abre las conexiones y empieza a escuchar.
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
import { crearApp, reglasDeRutas, SERVICIO } from './app.ts';
import { crearViajes } from './clientes.ts';
import { esquemaConfig, parsearAgencias } from './config.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({ servicio: SERVICIO, region: config.REGION, nivel: config.NIVEL_LOG });

const pool = crearPool({ url: config.URL_BASE, logger });
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
const registrar = registroPorEvento(broker, logger);
const validador = crearValidador({
  servicio: SERVICIO,
  region: config.REGION,
  logger,
  claves: { [config.REGION]: { url: config.URL_JWKS } },
  registrar,
  reglas: reglasDeRutas(),
});
const outbox = iniciarPublicadorOutbox({ pool, broker, logger });

const servidor = crearApp({
  region: config.REGION,
  puerto: config.PUERTO,
  logger,
  validador,
  negocio: {
    pool,
    viajes: crearViajes({ urlViajes: config.URL_VIAJES, logger }),
    agencias: parsearAgencias(config.AGENCIAS_CONFIGURADAS),
    registrar,
  },
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
