import { fileURLToPath } from 'node:url';
import {
  crearServidor,
  type Chequeo,
  type Logger,
  type Region,
  type Servidor,
  type Validador,
} from '@trotamundos/comun';
import type { Vigilante } from './vigilante.ts';

export const SERVICIO = 'monitor';
/** Contrato del servicio: las solicitudes y las respuestas se validan contra él. */
export const RUTA_SPEC = fileURLToPath(
  new URL('../../../specs/openapi/monitor.yaml', import.meta.url),
);

export interface OpcionesApp {
  region: Region;
  puerto: number;
  logger: Logger;
  /** Ping-echo de las instancias de la región (GET /estado). */
  vigilante?: Vigilante;
  /** Validador de Intercepción. Sin él, toda ruta protegida responde 401. */
  validador?: Validador;
  /** Chequeos de GET /health (Docker...). */
  chequeos?: Record<string, Chequeo>;
  /** Escuchar SIGTERM para apagar en orden (las pruebas lo apagan). */
  manejarSenales?: boolean;
}

/**
 * Arma el servidor del monitor de salud: GET /health y GET /estado. No abre conexiones: index.ts
 * le pasa el vigilante con el cliente de Docker, y las pruebas uno con un Docker falso.
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

  servidor.app.get('/estado', (_req, res) => {
    const estado = opciones.vigilante?.estado() ?? {
      actualizadoEn: null,
      intervaloMs: 5000,
      instancias: [],
    };
    res.json({ region: opciones.region, ...estado });
  });

  return servidor;
}
