// Clientes HTTP internos de Correo (Autenticación para token de servicio y Viajes para
// consultar usuarios con viaje próximo con caché en memoria de 10 minutos, ADR-010).
import { crearClienteHttp, type Logger } from '@trotamundos/comun';

export interface OpcionesTokenServicio {
  urlAutenticacion: string;
  servicio: string;
  secreto: string;
  logger: Logger;
  fetch?: typeof fetch;
  ahora?: () => number;
}

export type ObtenerTokenServicio = () => Promise<string>;

/** Obtiene y cachea en memoria el token de servicio emitido por Autenticación. */
export function crearProveedorTokenServicio(opciones: OpcionesTokenServicio): ObtenerTokenServicio {
  const cliente = crearClienteHttp({
    urlBase: opciones.urlAutenticacion,
    fetch: opciones.fetch,
  });
  const ahora = opciones.ahora ?? Date.now;
  let enCache: { token: string; venceEnMs: number } | undefined;
  let enVuelo: Promise<string> | undefined;

  async function solicitarNuevo(): Promise<string> {
    const { datos } = await cliente.post<{ tokenServicio: string; expiraEn: number }>(
      '/interna/tokens-servicio',
      { servicio: opciones.servicio, secreto: opciones.secreto },
      { token: null },
    );
    // Renovamos 30 s antes del vencimiento real para evitar carreras al límite del TTL.
    const ttlMs = Math.max(10_000, (datos.expiraEn - 30) * 1000);
    enCache = { token: datos.tokenServicio, venceEnMs: ahora() + ttlMs };
    return datos.tokenServicio;
  }

  return async () => {
    if (enCache && ahora() < enCache.venceEnMs) {
      return enCache.token;
    }
    if (!enVuelo) {
      enVuelo = solicitarNuevo().finally(() => {
        enVuelo = undefined;
      });
    }
    return enVuelo;
  };
}

export interface ClienteViajes {
  /** Devuelve el conjunto de usuarioId de esta región con viaje en curso o en los próximos días. */
  obtenerUsuariosConViajeProximo(): Promise<ReadonlySet<string>>;
}

export interface OpcionesClienteViajes {
  urlViajes: string;
  obtenerToken: ObtenerTokenServicio;
  ttlCacheMs: number;
  dias: number;
  logger: Logger;
  fetch?: typeof fetch;
  ahora?: () => number;
}

interface RespuestaViajesProximos {
  dias: number;
  calculadoEn: string;
  usuarioIds: string[];
}

/** Cliente de GET /interna/usuarios-con-viaje-proximo con caché en memoria por TTL configurado. */
export function crearClienteViajes(opciones: OpcionesClienteViajes): ClienteViajes {
  const cliente = crearClienteHttp({
    urlBase: opciones.urlViajes,
    fetch: opciones.fetch,
  });
  const ahora = opciones.ahora ?? Date.now;

  let cache: { usuarios: ReadonlySet<string>; venceEnMs: number } | undefined;
  let enVuelo: Promise<ReadonlySet<string>> | undefined;

  async function actualizarCache(): Promise<ReadonlySet<string>> {
    try {
      const token = await opciones.obtenerToken();
      const { datos } = await cliente.get<RespuestaViajesProximos>(
        '/interna/usuarios-con-viaje-proximo',
        { query: { dias: String(opciones.dias) }, token },
      );
      const usuarios = new Set(datos.usuarioIds);
      cache = { usuarios, venceEnMs: ahora() + opciones.ttlCacheMs };
      return usuarios;
    } catch (error) {
      // Si Viajes no está disponible todavía o falla momentáneamente, mantenemos el último valor
      // o conjunto vacío sin bloquear la revisión prioritaria ni los avisos push.
      opciones.logger.warn(
        { err: error },
        'no se pudo consultar usuarios con viaje próximo en Viajes',
      );
      return cache?.usuarios ?? new Set<string>();
    }
  }

  return {
    async obtenerUsuariosConViajeProximo() {
      if (cache && ahora() < cache.venceEnMs) {
        return cache.usuarios;
      }
      if (!enVuelo) {
        enVuelo = actualizarCache().finally(() => {
          enVuelo = undefined;
        });
      }
      return enVuelo;
    },
  };
}
