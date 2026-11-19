import type { PluginConsulta } from './tipos.ts';

export interface RegistroPlugins {
  registrar(plugin: PluginConsulta): void;
  obtener(intencion: string): PluginConsulta | undefined;
  listar(): PluginConsulta[];
}

/**
 * Registro de plug-ins del Asistente Virtual (ADR-018).
 * Permite sumar nuevos tipos de consulta sin modificar el núcleo ni los demás plug-ins.
 */
export function crearRegistroPlugins(iniciales: PluginConsulta[] = []): RegistroPlugins {
  const mapa = new Map<string, PluginConsulta>();
  for (const plugin of iniciales) {
    mapa.set(plugin.intencion, plugin);
  }
  return {
    registrar(plugin) {
      mapa.set(plugin.intencion, plugin);
    },
    obtener: (intencion) => mapa.get(intencion),
    listar: () => [...mapa.values()],
  };
}
