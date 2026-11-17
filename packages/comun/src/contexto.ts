import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Datos de la solicitud en curso. Viajan con el código asíncrono de la solicitud, así el logger
 * agrega el requestId a cada línea y el cliente HTTP propaga el JWT y el X-Request-Id sin que haya
 * que pasarlos a mano (CONVENCIONES 4.3, ADR-019).
 */
export interface ContextoSolicitud {
  requestId: string;
  /** JWT del usuario (o token de servicio) tal como llegó, sin "Bearer ". */
  token?: string;
}

const almacen = new AsyncLocalStorage<ContextoSolicitud>();

/** Contexto de la solicitud en curso, o undefined fuera de una solicitud. */
export function contextoActual(): ContextoSolicitud | undefined {
  return almacen.getStore();
}

/** Ejecuta fn dentro de un contexto (también sirve en tareas programadas y consumidores). */
export function conContexto<T>(contexto: ContextoSolicitud, fn: () => T): T {
  return almacen.run(contexto, fn);
}
