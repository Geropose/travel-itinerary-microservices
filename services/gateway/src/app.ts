import {
  crearServidor,
  type Chequeo,
  type Logger,
  type Region,
  type RegistrarRechazo,
  type Servidor,
  type Validador,
} from '@trotamundos/comun';
import {
  montarEnrutamiento,
  rutaSpecDe,
  SERVICIOS_INTERNOS,
  type ServicioInterno,
} from './enrutamiento.ts';

export const SERVICIO = 'gateway';
/** Contrato del servicio: solo GET /health; la tabla de enrutamiento está en su descripción. */
export const RUTA_SPEC = rutaSpecDe('gateway');

export interface OpcionesApp {
  region: Region;
  puerto: number;
  logger: Logger;
  /** Validador de Intercepción. Sin él, toda ruta protegida responde 401. */
  validador?: Validador;
  /** Registro de accesos: rutas internas pedidas desde afuera (404). Por defecto, solo el log. */
  registrar?: RegistrarRechazo;
  /** Servicio interno de cada prefijo /api/<servicio> (por defecto, la tabla del contrato). */
  servicios?: Record<string, ServicioInterno>;
  /** Tiempo máximo del servicio interno (por defecto 2 s); si no responde, 503. */
  tiempoMaximoMs?: number;
  /** Tamaño máximo del cuerpo (por defecto 1mb); si lo supera, 413. */
  limiteCuerpo?: string;
  /** Origen de la web, el único con CORS. */
  origenWeb?: string;
  /** Chequeos de GET /health (base, broker...). */
  chequeos?: Record<string, Chequeo>;
  /** Escuchar SIGTERM para apagar en orden (las pruebas lo apagan). */
  manejarSenales?: boolean;
}

/**
 * Arma el API Gateway de la región: GET /health y el enrutamiento de /api/<servicio>/* con el
 * Validador de Intercepción (ADR-005). No abre conexiones: index.ts le pasa la base, el broker y
 * el validador, y las pruebas lo usan con servicios falsos.
 */
export function crearApp(opciones: OpcionesApp): Servidor {
  const { logger } = opciones;
  const servidor = crearServidor({
    servicio: SERVICIO,
    rutaSpec: RUTA_SPEC,
    region: opciones.region,
    puerto: opciones.puerto,
    logger,
    validador: opciones.validador,
    manejarSenales: opciones.manejarSenales ?? true,
    antesDelContrato: (app) =>
      montarEnrutamiento(app, {
        servicio: SERVICIO,
        logger,
        validador: opciones.validador,
        registrar:
          opciones.registrar ??
          ((rechazo) => logger.warn({ rechazo }, 'Acceso rechazado sin registro de accesos')),
        servicios: opciones.servicios ?? SERVICIOS_INTERNOS,
        tiempoMaximoMs: opciones.tiempoMaximoMs ?? 2000,
        limiteCuerpo: opciones.limiteCuerpo ?? '1mb',
        origenWeb: opciones.origenWeb ?? 'http://localhost:5173',
      }),
  });
  for (const [nombre, chequeo] of Object.entries(opciones.chequeos ?? {})) {
    servidor.registrarChequeo(nombre, chequeo);
  }
  return servidor;
}
