// Cache local del móvil (Iteración 4, QA-3): guarda el último panel del usuario en IndexedDB para
// mostrarlo apenas se abre la app, sin esperar a la red. El service worker (vite-plugin-pwa)
// guarda la aplicación; esto guarda los datos.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { components } from '../api/generado/viajes.ts';

export type Panel = components['schemas']['Panel'];

export interface PanelGuardado {
  panel: Panel;
  /** Cuándo se guardó (ISO 8601), para mostrar de cuándo es. */
  guardadoEn: string;
}

interface BaseLocal extends DBSchema {
  panel: { key: string; value: PanelGuardado };
}

const BASE = 'trotamundos';
const VERSION = 1;

function abrir(): Promise<IDBPDatabase<BaseLocal>> {
  return openDB<BaseLocal>(BASE, VERSION, {
    upgrade(base) {
      base.createObjectStore('panel');
    },
  });
}

async function conBase<T>(tarea: (base: IDBPDatabase<BaseLocal>) => Promise<T>): Promise<T> {
  const base = await abrir();
  try {
    return await tarea(base);
  } finally {
    base.close();
  }
}

/** Guarda el panel del usuario (reemplaza el anterior). */
export function guardarPanel(usuarioId: string, panel: Panel, ahora = new Date()): Promise<void> {
  return conBase(async (base) => {
    await base.put('panel', { panel, guardadoEn: ahora.toISOString() }, usuarioId);
  });
}

/** Último panel guardado del usuario, o undefined si no hay. */
export function leerPanel(usuarioId: string): Promise<PanelGuardado | undefined> {
  return conBase((base) => base.get('panel', usuarioId));
}

/** Borra el panel del usuario (al cerrar sesión: no quedan sus viajes en el dispositivo). */
export function borrarPanel(usuarioId: string): Promise<void> {
  return conBase((base) => base.delete('panel', usuarioId));
}
