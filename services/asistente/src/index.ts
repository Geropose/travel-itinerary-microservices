// Arranque de asistente: lee la configuración, abre las conexiones y empieza a escuchar.
import { fileURLToPath } from 'node:url';
import {
  cargarConfig,
  conectarBroker,
  crearLogger,
  crearPool,
  crearValidador,
  migrar,
  MIGRACIONES_EVENTOS,
  registroPorEvento,
} from '@trotamundos/comun';
import { crearApp, crearNegocioAsistente, SERVICIO } from './app.ts';
import { esquemaConfig } from './config.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({ servicio: SERVICIO, region: config.REGION, nivel: config.NIVEL_LOG });

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
const registrarRechazo = registroPorEvento(broker, logger);
const validador = crearValidador({
  servicio: SERVICIO,
  region: config.REGION,
  logger,
  claves: { [config.REGION]: { url: config.URL_JWKS } },
  registrar: registrarRechazo,
  reglas: {},
});

const negocio = crearNegocioAsistente({
  pool,
  region: config.REGION,
  logger,
  ...(config.DIR_REGLAS ? { dirReglas: config.DIR_REGLAS } : {}),
  urlViajes: config.URL_VIAJES,
  urlUsuarios: config.URL_USUARIOS,
  urlIntegraciones: config.URL_INTEGRACIONES,
  timeoutServiciosMs: config.TIMEOUT_SERVICIOS_MS,
  timeoutProveedorMs: config.TIMEOUT_PROVEEDOR_MS,
  registrarRechazo,
});

const servidor = crearApp({
  region: config.REGION,
  puerto: config.PUERTO,
  logger,
  validador,
  nucleo: negocio.nucleo,
  chequeos: {
    base: () => pool.query('SELECT 1'),
    reglas: async () => {
      if (!negocio.reglas.estaCargado()) throw new Error('Reglas de intenciones no cargadas');
    },
  },
});

// Se apagan en orden inverso: primero el broker y al final la base.
servidor.alApagar(() => pool.end());
servidor.alApagar(() => broker.cerrar());

await servidor.iniciar();
