// Arranque de analitica: lee la configuración, abre las conexiones (base regional + base global
// de analítica + broker regional), inicia el Anonimizador y empieza a escuchar.
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
import { crearApp, SERVICIO } from './app.ts';
import { esquemaConfig } from './config.ts';
import { registrarConsumidorAnonimizador } from './consumidor.ts';
import { crearNegocioAnalitica } from './rutas.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({ servicio: SERVICIO, region: config.REGION, nivel: config.NIVEL_LOG });

const dirMigraciones = fileURLToPath(new URL('../migrations/', import.meta.url));
const maximoPool = Math.max(10, config.CANTIDAD_CONSUMIDORES * 2);
const poolRegional = crearPool({ url: config.URL_BASE, maximo: maximoPool, logger });

const poolAnalitica =
  config.URL_BASE_ANALITICA && config.URL_BASE_ANALITICA !== config.URL_BASE
    ? crearPool({
        url: config.URL_BASE_ANALITICA,
        maximo: Math.max(15, config.CANTIDAD_CONSUMIDORES * 2),
        logger,
      })
    : poolRegional;

if (poolAnalitica === poolRegional) {
  await migrar(poolRegional, [MIGRACIONES_EVENTOS, dirMigraciones], logger);
} else {
  await migrar(poolRegional, [MIGRACIONES_EVENTOS], logger);
  await migrar(poolAnalitica, [dirMigraciones], logger);
}

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
  // Todas las rutas de specs/openapi/analitica.yaml (salvo /health) exigen el rol analista.
  rolesPorDefecto: ['analista'],
  reglas: {},
});

await registrarConsumidorAnonimizador({
  broker,
  poolRegional,
  poolAnalitica,
  region: config.REGION,
  secretoAnalitica: config.SECRETO_ANALITICA,
  logger,
  cantidadConsumidores: config.CANTIDAD_CONSUMIDORES,
  prefetch: config.PREFETCH_CONSUMIDORES,
});

const negocio = crearNegocioAnalitica({
  poolAnalitica,
  urlBaseAnalitica: config.URL_BASE_ANALITICA ?? config.URL_BASE,
  logger,
  procesadoresDefecto: config.PROCESADORES_MAPREDUCE_DEFECTO,
});

const servidor = crearApp({
  region: config.REGION,
  puerto: config.PUERTO,
  logger,
  validador,
  negocio,
  chequeos: {
    base: () => poolRegional.query('SELECT 1'),
    ...(poolAnalitica !== poolRegional
      ? { baseAnalitica: () => poolAnalitica.query('SELECT 1') }
      : {}),
    broker: () => broker.verificar(),
  },
});

// Se apagan en orden inverso: primero ejecuciones Map-Reduce, después broker y al final bases.
servidor.alApagar(() => poolRegional.end());
if (poolAnalitica !== poolRegional) {
  servidor.alApagar(() => poolAnalitica.end());
}
servidor.alApagar(() => broker.cerrar());
servidor.alApagar(() => negocio.detener());

await servidor.iniciar();
