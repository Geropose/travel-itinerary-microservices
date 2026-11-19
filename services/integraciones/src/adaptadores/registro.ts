import type { ConfigProveedorResuelta } from '../config-proveedores.ts';
import { crearAdaptadorAerolinea } from './aerolinea.ts';
import { crearAdaptadorHotel } from './hotel.ts';
import { crearAdaptadorRentadora } from './rentadora.ts';
import type { AdaptadorProveedorViaje } from './tipos.ts';

export interface ContextoFabricaAdaptador {
  ahora?: () => number;
  fetch?: typeof fetch;
}

export type FabricaAdaptadorProveedor = (
  config: ConfigProveedorResuelta,
  contexto: ContextoFabricaAdaptador,
) => AdaptadorProveedorViaje;

/**
 * Fábricas de adaptadores por tipo de proveedor (ADR-003, QA-10).
 * Para sumar un nuevo medio de transporte (tren, autobús) se agrega su fábrica aquí y su entrada
 * en `config/proveedores.yaml` (ver `docs/agregar-proveedor.md`).
 */
export const FABRICAS_PROVEEDORES_DEFECTO: Record<string, FabricaAdaptadorProveedor> = {
  aerolinea: (cfg, ctx) => {
    if (!cfg.secretoWebhook) {
      throw new Error(`El adaptador de aerolínea "${cfg.nombre}" requiere secretoWebhook.`);
    }
    return crearAdaptadorAerolinea({
      nombre: cfg.nombre,
      url: cfg.url,
      claveApi: cfg.claveApi,
      secretoWebhook: cfg.secretoWebhook,
      ...(ctx.ahora ? { ahora: ctx.ahora } : {}),
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
  },
  hotel: (cfg, ctx) =>
    crearAdaptadorHotel({
      nombre: cfg.nombre,
      url: cfg.url,
      claveApi: cfg.claveApi,
      intervaloConsultaMs: cfg.intervaloConsultaMs,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    }),
  rentadora: (cfg, ctx) =>
    crearAdaptadorRentadora({
      nombre: cfg.nombre,
      url: cfg.url,
      claveApi: cfg.claveApi,
      intervaloConsultaMs: cfg.intervaloConsultaMs,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    }),
};

export interface RegistroAdaptadoresProveedores {
  obtener(nombre: string): AdaptadorProveedorViaje | undefined;
  listar(): AdaptadorProveedorViaje[];
  listarPorModo(modo: 'aviso' | 'consulta'): AdaptadorProveedorViaje[];
}

export interface OpcionesRegistroProveedores {
  proveedores: ConfigProveedorResuelta[];
  fabricas?: Record<string, FabricaAdaptadorProveedor>;
  ahora?: () => number;
  fetch?: typeof fetch;
}

/** Construye los adaptadores de proveedores a partir de `config/proveedores.yaml`. */
export function crearRegistroAdaptadoresProveedores(
  opciones: OpcionesRegistroProveedores,
): RegistroAdaptadoresProveedores {
  const fabricas = {
    ...FABRICAS_PROVEEDORES_DEFECTO,
    ...(opciones.fabricas ?? {}),
  };
  const mapa = new Map<string, AdaptadorProveedorViaje>();
  const ctx: ContextoFabricaAdaptador = {
    ...(opciones.ahora ? { ahora: opciones.ahora } : {}),
    ...(opciones.fetch ? { fetch: opciones.fetch } : {}),
  };

  for (const cfg of opciones.proveedores) {
    const fabrica = fabricas[cfg.tipo];
    if (!fabrica) {
      throw new Error(
        `Tipo de proveedor desconocido "${cfg.tipo}" para "${cfg.nombre}". Registrá su fábrica en adaptadores/registro.ts.`,
      );
    }
    const adaptador = fabrica(cfg, ctx);
    if (adaptador.modo !== cfg.modo) {
      throw new Error(
        `El proveedor "${cfg.nombre}" está configurado con modo "${cfg.modo}" pero su adaptador "${cfg.tipo}" usa modo "${adaptador.modo}".`,
      );
    }
    mapa.set(cfg.nombre, adaptador);
  }

  return {
    obtener: (nombre) => mapa.get(nombre),
    listar: () => [...mapa.values()],
    listarPorModo: (modo) => [...mapa.values()].filter((a) => a.modo === modo),
  };
}
