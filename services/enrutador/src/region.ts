// Elección de la región de cada solicitud (specs/openapi/gateway.yaml, Enrutador global;
// Iteración 6, ADR-017).
import { REGIONES, type Region } from '@trotamundos/comun';

/** Por qué se eligió la región: va al log de cada solicitud. */
export type Motivo = 'jwt' | 'prefijo' | 'x-region' | 'por-defecto';

export interface Eleccion {
  region: Region;
  motivo: Motivo;
  /** La URL que se manda a la región (sin el prefijo /region-N, si lo tenía). */
  url: string;
}

export const esRegion = (valor: unknown): valor is Region =>
  typeof valor === 'string' && (REGIONES as readonly string[]).includes(valor);

/**
 * Claim `region` del JWT del header Authorization, sin verificar la firma: la verifica el gateway
 * de la región. Si el token no se puede leer o no trae una región válida, undefined.
 */
export function regionDelJwt(authorization: string | undefined): Region | undefined {
  const partes = /^Bearer\s+([\w-]+)\.([\w-]+)\.[\w-]*$/i.exec(authorization?.trim() ?? '');
  const carga = partes?.[2];
  if (!carga) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(carga, 'base64url').toString('utf8'));
    const region =
      typeof claims === 'object' && claims !== null
        ? (claims as Record<string, unknown>).region
        : undefined;
    return esRegion(region) ? region : undefined;
  } catch {
    return undefined;
  }
}

const PREFIJO = /^\/(region-1|region-2)(?=[/?]|$)/;

/** Separa el prefijo /region-1 o /region-2 de la URL, si lo tiene. */
export function quitarPrefijo(url: string): { region?: Region; url: string } {
  const prefijo = PREFIJO.exec(url);
  if (!prefijo) return { url };
  const resto = url.slice(prefijo[0].length);
  return {
    region: prefijo[1] as Region,
    url: resto === '' || resto.startsWith('?') ? `/${resto}` : resto,
  };
}

export interface DatosSolicitud {
  url: string;
  authorization?: string | undefined;
  xRegion?: string | string[] | undefined;
}

/**
 * Elige la región en este orden: JWT, prefijo, X-Region y región por defecto. El JWT va primero:
 * un JWT de una región nunca se manda a la otra (CONST-6), aunque traiga prefijo o X-Region.
 */
export function elegirRegion(solicitud: DatosSolicitud, porDefecto: Region): Eleccion {
  const { region: delPrefijo, url } = quitarPrefijo(solicitud.url);
  const delJwt = regionDelJwt(solicitud.authorization);
  if (delJwt) return { region: delJwt, motivo: 'jwt', url };
  if (delPrefijo) return { region: delPrefijo, motivo: 'prefijo', url };
  const xRegion = solicitud.xRegion;
  if (esRegion(xRegion)) return { region: xRegion, motivo: 'x-region', url };
  return { region: porDefecto, motivo: 'por-defecto', url };
}
