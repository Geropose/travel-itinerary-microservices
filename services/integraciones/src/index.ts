// Arranque de integraciones: lee la configuración, abre las conexiones, inicia consultas y escucha.
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
import {
  crearApp,
  crearNegocioIntegraciones,
  REGLAS_VALIDADOR_INTEGRACIONES,
  SERVICIO,
} from './app.ts';
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
const validador = crearValidador({
  servicio: SERVICIO,
  region: config.REGION,
  logger,
  claves: { [config.REGION]: { url: config.URL_JWKS } },
  registrar: registroPorEvento(broker, logger),
  reglas: REGLAS_VALIDADOR_INTEGRACIONES,
});
const outbox = iniciarPublicadorOutbox({ pool, broker, logger });

const negocio = crearNegocioIntegraciones({
  pool,
  region: config.REGION,
  logger,
  ...(config.RUTA_CONFIG_PROVEEDORES
    ? { rutaConfigProveedores: config.RUTA_CONFIG_PROVEEDORES }
    : {}),
  env: { ...process.env, ...config },
  intervaloGlobalSeg: config.INTERVALO_CONSULTA_PROVEEDORES_SEG,
  ventanaInicialMs: config.VENTANA_INICIAL_CONSULTA_SEG * 1000,
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

// Se apagan en orden inverso: primero consultador y outbox, después el broker y al final la base.
servidor.alApagar(() => pool.end());
servidor.alApagar(() => broker.cerrar());
servidor.alApagar(() => outbox.detener());
servidor.alApagar(() => negocio.consultador.detener());

await servidor.iniciar();
negocio.consultador.iniciar();
