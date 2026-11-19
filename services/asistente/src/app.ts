import { fileURLToPath } from 'node:url';
import {
  crearServidor,
  type Chequeo,
  type Logger,
  type Pool,
  type Region,
  type RegistrarRechazo,
  type Servidor,
  type Validador,
} from '@trotamundos/comun';
import { crearClientesAsistente, type ClientesAsistente } from './clientes.ts';
import { crearNucleoConversacion, type NucleoConversacion } from './nucleo.ts';
import { crearPluginDerivacion } from './plugins/derivacion.ts';
import { crearPluginEstado } from './plugins/estado.ts';
import { crearPluginProblemasMenores } from './plugins/problemas-menores.ts';
import { crearRegistroPlugins, type RegistroPlugins } from './plugins/registro.ts';
import { crearPluginReprogramacion } from './plugins/reprogramacion.ts';
import type { PluginConsulta } from './plugins/tipos.ts';
import { crearGestorReglas, type GestorReglas } from './reglas.ts';
import { registrarRutas } from './rutas.ts';

export const SERVICIO = 'asistente';
/** Contrato del servicio: las solicitudes y las respuestas se validan contra él. */
export const RUTA_SPEC = fileURLToPath(
  new URL('../../../specs/openapi/asistente.yaml', import.meta.url),
);

export interface OpcionesApp {
  region: Region;
  puerto: number;
  logger: Logger;
  /** Validador de Intercepción. Sin él, toda ruta protegida responde 401. */
  validador?: Validador;
  /** Núcleo de conversación del asistente. Sin esto solo responde /health. */
  nucleo?: NucleoConversacion;
  /** Chequeos de GET /health (base, reglas...). */
  chequeos?: Record<string, Chequeo>;
  /** Escuchar SIGTERM para apagar en orden (las pruebas lo apagan). */
  manejarSenales?: boolean;
}

export interface OpcionesNegocioAsistente {
  pool: Pool;
  region: Region;
  logger: Logger;
  dirReglas?: string;
  reglas?: GestorReglas;
  clientes?: ClientesAsistente;
  urlViajes?: string;
  urlUsuarios?: string;
  urlIntegraciones?: string;
  timeoutServiciosMs?: number;
  timeoutProveedorMs?: number;
  pluginsExtra?: PluginConsulta[];
  registrarRechazo?: RegistrarRechazo;
  ahora?: () => number;
  fetch?: typeof fetch;
}

export interface NegocioAsistente {
  reglas: GestorReglas;
  plugins: RegistroPlugins;
  nucleo: NucleoConversacion;
}

/** Construye reglas externas recargables, los 4 plug-ins y el núcleo de conversación. */
export function crearNegocioAsistente(opciones: OpcionesNegocioAsistente): NegocioAsistente {
  const reglas =
    opciones.reglas ??
    crearGestorReglas({
      ...(opciones.dirReglas ? { dirReglas: opciones.dirReglas } : {}),
      logger: opciones.logger,
    });

  const clientes =
    opciones.clientes ??
    crearClientesAsistente({
      urlViajes: opciones.urlViajes ?? 'http://viajes:3004',
      urlUsuarios: opciones.urlUsuarios ?? 'http://usuarios:3002',
      urlIntegraciones: opciones.urlIntegraciones ?? 'http://integraciones:3005',
      ...(opciones.timeoutServiciosMs !== undefined
        ? { timeoutServiciosMs: opciones.timeoutServiciosMs }
        : {}),
      ...(opciones.timeoutProveedorMs !== undefined
        ? { timeoutProveedorMs: opciones.timeoutProveedorMs }
        : {}),
      ...(opciones.fetch ? { fetch: opciones.fetch } : {}),
    });

  const plugins = crearRegistroPlugins([
    crearPluginEstado(clientes.viajes),
    crearPluginReprogramacion({
      viajes: clientes.viajes,
      integraciones: clientes.integraciones,
    }),
    crearPluginProblemasMenores(),
    crearPluginDerivacion({
      usuarios: clientes.usuarios,
      integraciones: clientes.integraciones,
    }),
    ...(opciones.pluginsExtra ?? []),
  ]);

  const nucleo = crearNucleoConversacion({
    pool: opciones.pool,
    region: opciones.region,
    reglas,
    plugins,
    logger: opciones.logger,
    ...(opciones.registrarRechazo ? { registrarRechazo: opciones.registrarRechazo } : {}),
    ...(opciones.ahora ? { ahora: opciones.ahora } : {}),
  });

  return { reglas, plugins, nucleo };
}

/**
 * Arma el servidor de asistente con sus rutas. No abre conexiones: index.ts le pasa la base, el
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

  if (opciones.nucleo) {
    registrarRutas(servidor, opciones.nucleo);
  }

  return servidor;
}
