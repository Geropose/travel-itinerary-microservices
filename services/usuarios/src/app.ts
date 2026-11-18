import { fileURLToPath } from 'node:url';
import {
  crearServidor,
  type Chequeo,
  type Logger,
  type Region,
  type ReglaRuta,
  type Servidor,
  type Validador,
} from '@trotamundos/comun';
import { registrarRutas, type Negocio } from './rutas.ts';

export const SERVICIO = 'usuarios';
/** Contrato del servicio: las solicitudes y las respuestas se validan contra él. */
export const RUTA_SPEC = fileURLToPath(
  new URL('../../../specs/openapi/usuarios.yaml', import.meta.url),
);

/** Reglas del Validador de Intercepción para las rutas de Usuarios. */
export function reglasDeRutas(): Record<string, ReglaRuta> {
  return {
    // La llama Autenticación en POST /registro (token de servicio).
    'POST /interna/cuentas': { servicios: ['autenticacion'] },
  };
}

export interface OpcionesApp {
  region: Region;
  puerto: number;
  logger: Logger;
  /** Validador de Intercepción. Sin él, toda ruta protegida responde 401. */
  validador?: Validador;
  /** Base, cliente de viajes y configuración. Sin esto solo responde /health. */
  negocio?: Negocio;
  /** Chequeos de GET /health (base, broker...). */
  chequeos?: Record<string, Chequeo>;
  /** Escuchar SIGTERM para apagar en orden (las pruebas lo apagan). */
  manejarSenales?: boolean;
}

/**
 * Arma el servidor de usuarios con sus rutas. No abre conexiones: index.ts le pasa la base, el
 * broker, el validador y el cliente de Viajes, y las pruebas lo usan con los suyos.
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
    registrarRutas(servidor, opciones.region, SERVICIO, opciones.negocio);
  }

  return servidor;
}
