import { fileURLToPath } from 'node:url';
import {
  crearServidor,
  type Chequeo,
  type Logger,
  type Region,
  type Servidor,
  type Validador,
} from '@trotamundos/comun';
import { registrarRutas, type NegocioAnalitica } from './rutas.ts';

export const SERVICIO = 'analitica';
/** Contrato del servicio: las solicitudes y las respuestas se validan contra él. */
export const RUTA_SPEC = fileURLToPath(
  new URL('../../../specs/openapi/analitica.yaml', import.meta.url),
);

export interface OpcionesApp {
  region: Region;
  puerto: number;
  logger: Logger;
  /** Validador de Intercepción. Sin él, toda ruta protegida responde 401. */
  validador?: Validador;
  /** Fachada de negocio de consultas analíticas y ejecuciones Map-Reduce. */
  negocio?: NegocioAnalitica;
  /** Chequeos de GET /health (base, broker...). */
  chequeos?: Record<string, Chequeo>;
  /** Escuchar SIGTERM para apagar en orden (las pruebas lo apagan). */
  manejarSenales?: boolean;
}

/**
 * Arma el servidor de analitica con sus rutas. No abre conexiones: index.ts le pasa la base, el
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
    registrarRutas(servidor, opciones.negocio);
  }

  return servidor;
}
