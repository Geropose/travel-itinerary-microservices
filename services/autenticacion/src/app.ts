import { fileURLToPath } from 'node:url';
import {
  crearServidor,
  errores,
  type Chequeo,
  type Logger,
  type Region,
  type ReglaRuta,
  type Servidor,
  type Validador,
} from '@trotamundos/comun';
import type { ClavesJwt } from './claves.ts';
import { registrarRutas, type Negocio } from './rutas.ts';

export const SERVICIO = 'autenticacion';
/** Contrato del servicio: las solicitudes y las respuestas se validan contra él. */
export const RUTA_SPEC = fileURLToPath(
  new URL('../../../specs/openapi/autenticacion.yaml', import.meta.url),
);

/** Reglas del Validador de Intercepción para las rutas de Autenticación. */
export function reglasDeRutas(region: Region): Record<string, ReglaRuta> {
  return {
    // Solo la Autenticación de cualquiera de las dos regiones (ADR-017).
    'GET /interna/cuentas/existe': {
      servicios: ['autenticacion'],
      regiones: [region, region === 'region-1' ? 'region-2' : 'region-1'],
    },
    // El analista también cierra sesión.
    'POST /logout': { roles: ['usuario', 'analista'] },
  };
}

export interface OpcionesApp {
  region: Region;
  puerto: number;
  logger: Logger;
  /** Validador de Intercepción. Sin él, toda ruta protegida responde 401. */
  validador?: Validador;
  /** Chequeos de GET /health (base, broker...). */
  chequeos?: Record<string, Chequeo>;
  /** Claves públicas que se publican en GET /.well-known/jwks.json. */
  jwks?: ClavesJwt['jwks'];
  /** Base, claves y clientes para las rutas de negocio. Sin esto solo responden /health y el JWKS. */
  negocio?: Negocio;
  /** Escuchar SIGTERM para apagar en orden (las pruebas lo apagan). */
  manejarSenales?: boolean;
}

/**
 * Arma el servidor de autenticacion con sus rutas. No abre conexiones: index.ts le pasa la base, el
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

  // Rutas del servicio, una por operación de specs/openapi/autenticacion.yaml.
  if (opciones.negocio) {
    registrarRutas(servidor, opciones.region, SERVICIO, opciones.negocio, opciones.logger);
  }

  // Clave pública del JWT (ADR-014): los validadores la descargan una vez y verifican sin red.
  servidor.app.get('/.well-known/jwks.json', (_req, res) => {
    if (!opciones.jwks) throw errores.noDisponible('Todavía no hay claves de firma');
    res.set('Cache-Control', 'public, max-age=3600').json(opciones.jwks);
  });

  return servidor;
}
