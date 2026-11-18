// Arranque de autenticacion: lee la configuración, abre las conexiones y empieza a escuchar.
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
  type Region,
} from '@trotamundos/comun';
import { crearApp, reglasDeRutas, SERVICIO } from './app.ts';
import { leerClaves } from './claves.ts';
import { crearOtraRegion, crearUsuarios } from './clientes.ts';
import { esquemaConfig, secretosDeServicios } from './config.ts';
import { tokenDeServicioPropio } from './tokens.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({ servicio: SERVICIO, region: config.REGION, nivel: config.NIVEL_LOG });
const otraRegion: Region = config.REGION === 'region-1' ? 'region-2' : 'region-1';

const claves = leerClaves(config.JWT_CLAVE_PRIVADA, config.REGION);
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
const registrar = registroPorEvento(broker, logger);
const validador = crearValidador({
  servicio: SERVICIO,
  region: config.REGION,
  logger,
  claves: {
    // Autenticación verifica con sus propias claves: no se descarga el JWKS a sí misma.
    [config.REGION]: { claves: claves.jwks },
    // Las de la otra región validan el token de servicio de su Autenticación (ADR-017).
    [otraRegion]: { url: config.URL_JWKS_OTRA_REGION },
  },
  registrar,
  reglas: reglasDeRutas(config.REGION),
});
const outbox = iniciarPublicadorOutbox({ pool, broker, logger });

const token = tokenDeServicioPropio(claves, config.REGION);
const clientes = {
  urlUsuarios: config.URL_USUARIOS,
  urlOtraRegion: config.URL_OTRA_REGION,
  otraRegion,
  token,
};
const servidor = crearApp({
  region: config.REGION,
  puerto: config.PUERTO,
  logger,
  validador,
  jwks: claves.jwks,
  negocio: {
    pool,
    claves,
    usuarios: crearUsuarios(clientes),
    otraRegion: crearOtraRegion(clientes),
    urlPublicaOtraRegion: config.URL_PUBLICA_OTRA_REGION,
    secretos: secretosDeServicios(),
    registrar,
    limiteLogin: {
      maxIntentos: config.LOGIN_MAX_INTENTOS,
      ventanaMinutos: config.LOGIN_VENTANA_MINUTOS,
    },
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
