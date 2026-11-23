// Cache distribuida del panel en Redis (Iteración 4, ADR-004, ADR-011): clave `panel:{usuarioId}`,
// TTL 10 min por defecto y degradación segura (si Redis no responde, no falla ni frena las lecturas).
import type { Logger } from '@trotamundos/comun';
import { createClient } from 'redis';
import type { PanelPublico } from './modelo.ts';

export const clavePanelUsuario = (usuarioId: string) => `panel:${usuarioId}`;
export const claveVersionPanel = (usuarioId: string) => `panel:ver:${usuarioId}`;
export const claveMutacionPanel = (usuarioId: string) => `panel:mut:${usuarioId}`;

export interface CachePanel {
  obtener(usuarioId: string): Promise<PanelPublico | null>;
  guardar(usuarioId: string, panel: PanelPublico, versionEsperada?: string | null): Promise<void>;
  invalidar(usuarioId: string): Promise<void>;
  obtenerVersion?(usuarioId: string): Promise<string | null>;
  mutacionReciente?(usuarioId: string): Promise<boolean>;
  cerrar(): Promise<void>;
}

export interface OpcionesCacheRedis {
  url: string;
  logger: Logger;
  /** Tiempo de vida de cada entrada en segundos (por defecto 600 = 10 minutos). */
  ttlSegundos?: number;
  /** Tiempo máximo por operación contra Redis antes de degradar a la réplica (por defecto 500 ms). */
  timeoutMs?: number;
  /** Ventana en segundos tras invalidar para leer desde la base principal y evitar lag de réplica. */
  ventanaMutacionSegundos?: number;
}

function conTimeout<T>(promesa: Promise<T>, ms: number, etiqueta: string): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined;
  const limite = new Promise<never>((_res, rej) => {
    temporizador = setTimeout(() => rej(new Error(`Timeout en Redis (${etiqueta}, ${ms} ms)`)), ms);
  });
  return Promise.race([promesa, limite]).finally(() => {
    if (temporizador) clearTimeout(temporizador);
  });
}

/** Cache nula (no-op) para pruebas sin Redis o instancias donde URL_CACHE no está configurada. */
export function crearCacheNula(): CachePanel {
  return {
    obtener: async () => null,
    guardar: async () => undefined,
    invalidar: async () => undefined,
    obtenerVersion: async () => null,
    mutacionReciente: async () => false,
    cerrar: async () => undefined,
  };
}

/**
 * Crea y conecta el cliente Redis para la cache del panel.
 * Usa `disableOfflineQueue: true` para degradar de inmediato cuando Redis cae en vez de encolar
 * operaciones indefinidamente. Si la conexión inicial falla, el servicio igual arranca y reintenta.
 */
export async function crearCacheRedis(opciones: OpcionesCacheRedis): Promise<CachePanel> {
  const { url, logger } = opciones;
  const ttlSegundos = Math.max(1, opciones.ttlSegundos ?? 600);
  const timeoutMs = Math.max(50, opciones.timeoutMs ?? 500);
  const ventanaMutacionSegundos = Math.max(1, opciones.ventanaMutacionSegundos ?? 5);

  const cliente = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: timeoutMs,
      reconnectStrategy: (intentos) => Math.min(intentos * 200, 3000),
    },
  });

  let cerrando = false;
  cliente.on('error', (err: unknown) => {
    if (!cerrando) {
      logger.warn({ err }, 'error en la cache Redis del panel; se degrada a lectura de base');
    }
  });

  try {
    await conTimeout(cliente.connect(), timeoutMs * 2, 'connect');
  } catch (err) {
    logger.warn({ err }, 'no se pudo conectar inicialmente a Redis; el panel degradará a réplica');
  }

  return {
    async obtener(usuarioId) {
      if (!cliente.isReady) return null;
      try {
        const crudo = await conTimeout(cliente.get(clavePanelUsuario(usuarioId)), timeoutMs, 'GET');
        if (!crudo) return null;
        return JSON.parse(crudo) as PanelPublico;
      } catch (err) {
        logger.warn({ err }, 'falló lectura de cache del panel; se leerá de base');
        return null;
      }
    },

    async obtenerVersion(usuarioId) {
      if (!cliente.isReady) return null;
      try {
        const valor = await conTimeout(
          cliente.get(claveVersionPanel(usuarioId)),
          timeoutMs,
          'GET VER',
        );
        return typeof valor === 'string' ? valor : null;
      } catch (err) {
        logger.warn({ err }, 'falló lectura de versión de cache del panel');
        return null;
      }
    },

    async mutacionReciente(usuarioId) {
      if (!cliente.isReady) return false;
      try {
        const existe = await conTimeout(
          cliente.exists(claveMutacionPanel(usuarioId)),
          timeoutMs,
          'EXISTS MUT',
        );
        return existe > 0;
      } catch (err) {
        logger.warn({ err }, 'falló consulta de mutación reciente del panel');
        return false;
      }
    },

    async guardar(usuarioId, panel, versionEsperada) {
      if (!cliente.isReady) return;
      try {
        const carga = JSON.stringify(panel);
        if (versionEsperada !== undefined) {
          await conTimeout(
            cliente.eval(
              `if (redis.call('GET', KEYS[2]) or '') == ARGV[3] then
                 redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
                 return 1
               end
               return 0`,
              {
                keys: [clavePanelUsuario(usuarioId), claveVersionPanel(usuarioId)],
                arguments: [carga, String(ttlSegundos), versionEsperada ?? ''],
              },
            ),
            timeoutMs,
            'EVAL SET',
          );
          return;
        }
        await conTimeout(
          cliente.set(clavePanelUsuario(usuarioId), carga, { EX: ttlSegundos }),
          timeoutMs,
          'SET',
        );
      } catch (err) {
        logger.warn({ err }, 'falló guardado en cache del panel');
      }
    },

    async invalidar(usuarioId) {
      if (!cliente.isReady) return;
      try {
        const ttlVersion = Math.max(ttlSegundos * 2, 3600);
        await conTimeout(
          cliente.eval(
            `redis.call('DEL', KEYS[1])
             redis.call('INCR', KEYS[2])
             redis.call('EXPIRE', KEYS[2], tonumber(ARGV[1]))
             redis.call('SET', KEYS[3], '1', 'EX', tonumber(ARGV[2]))
             return 1`,
            {
              keys: [
                clavePanelUsuario(usuarioId),
                claveVersionPanel(usuarioId),
                claveMutacionPanel(usuarioId),
              ],
              arguments: [String(ttlVersion), String(ventanaMutacionSegundos)],
            },
          ),
          timeoutMs,
          'EVAL INVALIDAR',
        );
      } catch (err) {
        logger.warn({ err }, 'falló invalidación de cache del panel');
      }
    },

    async cerrar() {
      cerrando = true;
      try {
        if (cliente.isOpen) {
          await conTimeout(cliente.quit(), 1000, 'QUIT').catch(() => cliente.destroy());
        }
      } catch {
        // Ignorado al apagar.
      }
    },
  };
}
