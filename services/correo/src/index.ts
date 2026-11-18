// Arranque de correo: lee la configuración, abre las conexiones, inicia el examinador y escucha.
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
import { crearClienteViajes, crearProveedorTokenServicio } from './clientes.ts';
import { conectarColaBuzones } from './cola.ts';
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
const cola = await conectarColaBuzones({ url: config.URL_BROKER, logger });
const validador = crearValidador({
  servicio: SERVICIO,
  region: config.REGION,
  logger,
  claves: { [config.REGION]: { url: config.URL_JWKS } },
  registrar: registroPorEvento(broker, logger),
  reglas: {},
});
const outbox = iniciarPublicadorOutbox({ pool, broker, logger });

const obtenerTokenServicio = crearProveedorTokenServicio({
  urlAutenticacion: config.URL_AUTENTICACION,
  servicio: SERVICIO,
  secreto: config.SECRETO_SERVICIO_CORREO,
  logger,
});
const viajes = crearClienteViajes({
  urlViajes: config.URL_VIAJES,
  obtenerToken: obtenerTokenServicio,
  ttlCacheMs: config.CACHE_VIAJES_MIN * 60_000,
  dias: config.DIAS_VIAJE_PROXIMO,
  logger,
});

const negocio = crearNegocioCorreo({
  pool,
  region: config.REGION,
  claveTokensBase64: config.CLAVE_TOKENS_CORREO,
  urlWeb: config.URL_WEB,
  logger,
  margenRenovacionMs: config.MARGEN_RENOVACION_SEG * 1000,
  gmail: adaptadoresConfig.gmail,
  outlook: adaptadoresConfig.outlook,
  cola,
  broker,
  viajes,
  pushGmail: {
    secreto: config.SECRETO_AVISOS_GMAIL,
    suscripcion: adaptadoresConfig.suscripcionGmail,
  },
  intervalos: {
    cicloMs: config.INTERVALO_EXAMINADOR_SEG * 1000,
    viajeProximoMs: config.INTERVALO_VIAJE_PROXIMO_MIN * 60_000,
    normalMs: config.INTERVALO_NORMAL_MIN * 60_000,
  },
  backoff429: {
    inicialMs: config.BACKOFF_429_INICIAL_SEG * 1000,
    maxMs: config.BACKOFF_429_MAX_SEG * 1000,
  },
  cantidadProcesadores: config.CANTIDAD_PROCESADORES,
  concurrenciaLectura: config.CONCURRENCIA_LECTURA,
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
    cola: () => cola.verificar(),
  },
});

// Se apagan en orden inverso: primero procesadores/examinador/outbox, después cola/broker y al final la base.
servidor.alApagar(() => pool.end());
servidor.alApagar(() => cola.cerrar());
servidor.alApagar(() => broker.cerrar());
servidor.alApagar(() => outbox.detener());
servidor.alApagar(() => negocio.examinador.detener());
servidor.alApagar(() => negocio.procesador.detener());

await negocio.procesador.iniciar();
await servidor.iniciar();
negocio.examinador.iniciar();
