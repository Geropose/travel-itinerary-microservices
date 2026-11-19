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
import {
  crearRegistroAdaptadoresProveedores,
  type FabricaAdaptadorProveedor,
  type RegistroAdaptadoresProveedores,
} from './adaptadores/registro.ts';
import { cargarConfigProveedores, type ConfigIntegracionesResuelta } from './config-proveedores.ts';
import { crearConsultadorProveedores, type ConsultadorProveedores } from './consultador.ts';
import { crearProcesadorProveedores } from './procesador.ts';
import {
  REGLAS_VALIDADOR_INTEGRACIONES,
  registrarRutas,
  registrarRutasAntesDelContrato,
  type NegocioIntegraciones,
} from './rutas.ts';

export const SERVICIO = 'integraciones';
/** Contrato del servicio: las solicitudes y las respuestas se validan contra él. */
export const RUTA_SPEC = fileURLToPath(
  new URL('../../../specs/openapi/integraciones.yaml', import.meta.url),
);

export { REGLAS_VALIDADOR_INTEGRACIONES };

export interface OpcionesApp {
  region: Region;
  puerto: number;
  logger: Logger;
  /** Validador de Intercepción. Sin él, toda ruta protegida responde 401. */
  validador?: Validador;
  /** Dependencias de negocio (base, adaptadores, procesador). Sin esto solo responde /health. */
  negocio?: NegocioIntegraciones;
  /** Chequeos de GET /health (base, broker...). */
  chequeos?: Record<string, Chequeo>;
  /** Escuchar SIGTERM para apagar en orden (las pruebas lo apagan). */
  manejarSenales?: boolean;
}

export interface OpcionesNegocioIntegraciones {
  pool: Pool;
  region: Region;
  logger: Logger;
  configProveedores?: ConfigIntegracionesResuelta;
  rutaConfigProveedores?: string;
  env?: Record<string, string | number | undefined>;
  intervaloGlobalSeg?: number;
  ventanaInicialMs?: number;
  demoraInicialConsultaMs?: number;
  fabricas?: Record<string, FabricaAdaptadorProveedor>;
  registro?: RegistroAdaptadoresProveedores;
  ahora?: () => number;
  fetch?: typeof fetch;
}

export interface NegocioIntegracionesCompleto extends NegocioIntegraciones {
  configProveedores: ConfigIntegracionesResuelta;
  consultador: ConsultadorProveedores;
}

/** Construye los adaptadores desde config/proveedores.yaml, el procesador y el consultador. */
export function crearNegocioIntegraciones(
  opciones: OpcionesNegocioIntegraciones,
): NegocioIntegracionesCompleto {
  const configProveedores =
    opciones.configProveedores ??
    cargarConfigProveedores({
      ...(opciones.rutaConfigProveedores ? { ruta: opciones.rutaConfigProveedores } : {}),
      ...(opciones.env ? { env: opciones.env } : {}),
      ...(opciones.intervaloGlobalSeg !== undefined
        ? { intervaloGlobalSeg: opciones.intervaloGlobalSeg }
        : {}),
    });

  const registro =
    opciones.registro ??
    crearRegistroAdaptadoresProveedores({
      proveedores: configProveedores.proveedores,
      ...(opciones.fabricas ? { fabricas: opciones.fabricas } : {}),
      ...(opciones.ahora ? { ahora: opciones.ahora } : {}),
      ...(opciones.fetch ? { fetch: opciones.fetch } : {}),
    });

  const procesador = crearProcesadorProveedores({
    pool: opciones.pool,
    region: opciones.region,
    logger: opciones.logger,
    ...(opciones.ahora ? { ahora: opciones.ahora } : {}),
  });

  const consultador = crearConsultadorProveedores({
    pool: opciones.pool,
    registro,
    procesador,
    logger: opciones.logger,
    ...(opciones.ventanaInicialMs !== undefined
      ? { ventanaInicialMs: opciones.ventanaInicialMs }
      : {}),
    ...(opciones.demoraInicialConsultaMs !== undefined
      ? { demoraInicialMs: opciones.demoraInicialConsultaMs }
      : {}),
    ...(opciones.ahora ? { ahora: opciones.ahora } : {}),
  });

  return {
    pool: opciones.pool,
    registro,
    procesador,
    consultador,
    configProveedores,
    logger: opciones.logger,
  };
}

/**
 * Arma el servidor de integraciones con sus rutas. No abre conexiones: index.ts le pasa la base, el
 * broker y el validador, y las pruebas lo usan sin ellos.
 */
export function crearApp(opciones: OpcionesApp): Servidor {
  const { negocio } = opciones;
  const servidor = crearServidor({
    servicio: SERVICIO,
    rutaSpec: RUTA_SPEC,
    region: opciones.region,
    puerto: opciones.puerto,
    logger: opciones.logger,
    validador: opciones.validador,
    manejarSenales: opciones.manejarSenales ?? true,
    ...(negocio
      ? {
          antesDelContrato: (app) => {
            registrarRutasAntesDelContrato(app, negocio);
          },
        }
      : {}),
  });
  for (const [nombre, chequeo] of Object.entries(opciones.chequeos ?? {})) {
    servidor.registrarChequeo(nombre, chequeo);
  }

  if (opciones.negocio) {
    registrarRutas(servidor, opciones.negocio);
  }

  return servidor;
}
