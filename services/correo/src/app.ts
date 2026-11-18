import { fileURLToPath } from 'node:url';
import {
  crearServidor,
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
  /** Base de datos, adaptadores y gestor de tokens. Sin esto solo responde /health. */
  negocio?: Negocio;
  /** Chequeos de GET /health (base, broker...). */
  chequeos?: Record<string, Chequeo>;
  /** Escuchar SIGTERM para apagar en orden (las pruebas lo apagan). */
  manejarSenales?: boolean;
}

export interface OpcionesNegocioCorreo {
  pool: Pool;
  claveTokensBase64: string;
  urlWeb: string;
  logger: Logger;
  margenRenovacionMs?: number;
  ahora?: () => number;
  adaptadores?: RegistroAdaptadores;
  gmail?: Parameters<typeof crearAdaptadorGmail>[0];
  outlook?: Parameters<typeof crearAdaptadorOutlook>[0];
}

/** Construye las dependencias de negocio de correo (clave AES, adaptadores y gestor de tokens). */
export function crearNegocioCorreo(opciones: OpcionesNegocioCorreo): Negocio {
  const claveTokens = leerClaveTokens(opciones.claveTokensBase64);
  const ahora = opciones.ahora ?? Date.now;
  const adaptadores =
    opciones.adaptadores ??
    crearRegistroAdaptadores([
      ...(opciones.gmail ? [crearAdaptadorGmail({ ...opciones.gmail, ahora })] : []),
      ...(opciones.outlook ? [crearAdaptadorOutlook({ ...opciones.outlook, ahora })] : []),
    ]);
  const gestorTokens = crearGestorTokens({
    pool: opciones.pool,
    claveTokens,
    adaptadores,
    logger: opciones.logger,
    margenRenovacionMs: opciones.margenRenovacionMs ?? 300_000,
    ahora,
  });

  return {
    pool: opciones.pool,
    claveTokens,
    adaptadores,
    gestorTokens,
    urlWeb: opciones.urlWeb,
    logger: opciones.logger,
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
