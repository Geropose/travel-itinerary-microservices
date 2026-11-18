import { fileURLToPath } from 'node:url';
import {
  crearServidor,
  type Broker,
  type Chequeo,
  type Logger,
  type Pool,
  type Region,
  type Servidor,
  type Validador,
} from '@trotamundos/comun';
import { crearAdaptadorGmail } from './adaptadores/gmail.ts';
import { crearAdaptadorOutlook } from './adaptadores/outlook.ts';
import { crearRegistroAdaptadores, type RegistroAdaptadores } from './adaptadores/registro.ts';
import { leerClaveTokens } from './cifrado.ts';
import type { ClienteViajes } from './clientes.ts';
import type { ColaBuzones } from './cola.ts';
import {
  crearExaminador,
  type ConfigBackoff429,
  type Examinador,
  type IntervalosExaminador,
} from './examinador.ts';
import { crearProcesadorCorreo, type ProcesadorCorreo } from './procesador.ts';
import * as repositorio from './repositorio.ts';
import { registrarRutas, type Negocio } from './rutas.ts';
import { crearGestorTokens } from './tokens.ts';

export const SERVICIO = 'correo';
/** Contrato del servicio: las solicitudes y las respuestas se validan contra él. */
export const RUTA_SPEC = fileURLToPath(
  new URL('../../../specs/openapi/correo.yaml', import.meta.url),
);

export interface OpcionesApp {
  region: Region;
  puerto: number;
  logger: Logger;
  /** Validador de Intercepción. Sin él, toda ruta protegida responde 401. */
  validador?: Validador;
  /** Base de datos, adaptadores, gestor de tokens y examinador. Sin esto solo responde /health. */
  negocio?: Negocio;
  /** Chequeos de GET /health (base, broker...). */
  chequeos?: Record<string, Chequeo>;
  /** Escuchar SIGTERM para apagar en orden (las pruebas lo apagan). */
  manejarSenales?: boolean;
}

export interface OpcionesNegocioCorreo {
  pool: Pool;
  region?: Region;
  claveTokensBase64: string;
  urlWeb: string;
  logger: Logger;
  margenRenovacionMs?: number;
  ahora?: () => number;
  adaptadores?: RegistroAdaptadores;
  gmail?: Parameters<typeof crearAdaptadorGmail>[0];
  outlook?: Parameters<typeof crearAdaptadorOutlook>[0];
  cola?: ColaBuzones;
  broker?: Broker;
  viajes?: ClienteViajes;
  pushGmail?: {
    secreto: string;
    suscripcion: string;
  };
  intervalos?: Partial<IntervalosExaminador>;
  backoff429?: Partial<ConfigBackoff429>;
  cantidadProcesadores?: number;
  concurrenciaLectura?: number;
}

const INTERVALOS_POR_DEFECTO: IntervalosExaminador = {
  cicloMs: 30_000,
  viajeProximoMs: 5 * 60_000,
  normalMs: 60 * 60_000,
};

const BACKOFF_POR_DEFECTO: ConfigBackoff429 = {
  inicialMs: 30_000,
  maxMs: 900_000,
};

export interface NegocioCorreo extends Negocio {
  examinador: Examinador;
  procesador: ProcesadorCorreo;
}

/** Construye las dependencias de negocio de correo (clave AES, adaptadores, tokens y examinador). */
export function crearNegocioCorreo(opciones: OpcionesNegocioCorreo): NegocioCorreo {
  const claveTokens = leerClaveTokens(opciones.claveTokensBase64);
  const ahora = opciones.ahora ?? Date.now;
  const adaptadores =
    opciones.adaptadores ??
    crearRegistroAdaptadores([
      ...(opciones.gmail ? [crearAdaptadorGmail({ ...opciones.gmail, ahora })] : []),
      ...(opciones.outlook ? [crearAdaptadorOutlook({ ...opciones.outlook, ahora })] : []),
    ]);

  const intervalos: IntervalosExaminador = {
    ...INTERVALOS_POR_DEFECTO,
    ...opciones.intervalos,
  };
  const backoff429: ConfigBackoff429 = {
    ...BACKOFF_POR_DEFECTO,
    ...opciones.backoff429,
  };

  const examinador = crearExaminador({
    pool: opciones.pool,
    cola: opciones.cola,
    viajes: opciones.viajes,
    adaptadores,
    logger: opciones.logger,
    intervalos,
    backoff429,
    ahora,
  });

  const gestorTokens = crearGestorTokens({
    pool: opciones.pool,
    claveTokens,
    adaptadores,
    logger: opciones.logger,
    margenRenovacionMs: opciones.margenRenovacionMs ?? 300_000,
    ahora,
    alLimitarCuota: (cuentaId, retryAfterSeg) =>
      examinador.registrarLimiteCuota(cuentaId, retryAfterSeg),
    alExito: async (cuentaId) => {
      await repositorio.limpiarBackoff429(opciones.pool, cuentaId, new Date(ahora()));
    },
  });

  const procesador = crearProcesadorCorreo({
    pool: opciones.pool,
    region: opciones.region ?? 'region-1',
    gestorTokens,
    cola: opciones.cola,
    broker: opciones.broker,
    logger: opciones.logger,
    cantidadProcesadores: opciones.cantidadProcesadores ?? 4,
    concurrenciaLectura: opciones.concurrenciaLectura ?? 5,
    ahora,
  });

  return {
    pool: opciones.pool,
    claveTokens,
    adaptadores,
    gestorTokens,
    examinador,
    procesador,
    urlWeb: opciones.urlWeb,
    logger: opciones.logger,
    ...(opciones.pushGmail ? { pushGmail: opciones.pushGmail } : {}),
    ahora,
  };
}

/**
 * Arma el servidor de correo con sus rutas. No abre conexiones: index.ts le pasa la base, el
 * broker y el validador, y las pruebas lo usan sin ellos.
 */
export function crearApp(opciones: OpcionesApp): Servidor {
  const servidor = crearServidor({
    servicio: SERVICIO,
    rutaSpec: RUTA_SPEC,
    region: opciones.region,
    puerto: opciones.puerto,
    logger: opciones.logger,
    validador: opciones.validador,
    manejarSenales: opciones.manejarSenales ?? true,
  });
  for (const [nombre, chequeo] of Object.entries(opciones.chequeos ?? {})) {
    servidor.registrarChequeo(nombre, chequeo);
  }

  if (opciones.negocio) {
    registrarRutas(servidor, opciones.region, opciones.negocio);
  }

  return servidor;
}
