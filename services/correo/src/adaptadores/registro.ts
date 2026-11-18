// Registro extensible de adaptadores de correo (ADR-003). Agregar un proveedor nuevo solo
// requiere registrar su adaptador aquí o en la composición sin modificar rutas ni otros adaptadores.
import type { AdaptadorCorreo, ProveedorCorreo } from './tipos.ts';

export interface RegistroAdaptadores {
  obtener(proveedor: ProveedorCorreo): AdaptadorCorreo | undefined;
  listar(): AdaptadorCorreo[];
}

export function crearRegistroAdaptadores(adaptadores: AdaptadorCorreo[]): RegistroAdaptadores {
  const mapa = new Map<string, AdaptadorCorreo>();
  for (const adaptador of adaptadores) {
    mapa.set(adaptador.proveedor, adaptador);
  }
  return {
    obtener: (proveedor) => mapa.get(proveedor),
    listar: () => [...mapa.values()],
  };
}
