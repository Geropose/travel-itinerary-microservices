// Utilidades compartidas entre adaptadores HTTP de proveedores de correo (timeout, errores
// OAuth sin filtrar secretos y extracción de remitente/cabeceras).
import { ErrorProveedorCorreo } from './tipos.ts';

export type FetchLike = typeof fetch;

const DEFAULT_TIMEOUT_MS = 10_000;

export function quitarBarraFinal(url: string): string {
  return url.replace(/\/+$/, '');
}

export function extraerRetryAfterSeg(respuesta: Response): number | undefined {
  const raw = respuesta.headers.get('retry-after');
  if (!raw) return undefined;
  const seg = Number(raw);
  return Number.isFinite(seg) && seg >= 0 ? Math.ceil(seg) : undefined;
}

export function parsearScopes(scopeTexto: unknown): string[] {
  if (typeof scopeTexto !== 'string') return [];
  return scopeTexto
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Extrae solo la dirección email en minúsculas desde un header `From` ("Nombre <a@b.c>"). */
export function extraerEmailRemitente(raw: string): string {
  const entreAngulos = /<([^<>]+)>/.exec(raw)?.[1];
  return (entreAngulos ?? raw).trim().toLowerCase();
}

export async function ejecutarFetch(
  fetchFn: FetchLike,
  url: string | URL,
  init: RequestInit,
  tiempoMaximoMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetchFn(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(tiempoMaximoMs),
    });
  } catch {
    throw new ErrorProveedorCorreo(
      'proveedor-no-disponible',
      'No se pudo comunicar con el proveedor de correo.',
    );
  }
}

export async function leerJsonSeguro(respuesta: Response): Promise<Record<string, unknown>> {
  try {
    const texto = await respuesta.text();
    if (!texto) return {};
    const parsed = JSON.parse(texto) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface RespuestaTokenOAuth {
  accessToken: string;
  refreshToken?: string;
  expiraEn: Date;
  scope: string;
}

/**
 * Llama al endpoint OAuth `/token` (canje o refresh) y normaliza errores RFC 6749 sin incluir
 * credenciales ni tokens en excepciones.
 */
export async function solicitarTokenOAuth(params: {
  fetchFn: FetchLike;
  urlToken: string;
  formulario: URLSearchParams;
  grantType: 'authorization_code' | 'refresh_token';
  tiempoMaximoMs?: number;
  ahora?: () => number;
}): Promise<RespuestaTokenOAuth> {
  const {
    fetchFn,
    urlToken,
    formulario,
    grantType,
    tiempoMaximoMs = DEFAULT_TIMEOUT_MS,
    ahora = Date.now,
  } = params;

  const respuesta = await ejecutarFetch(
    fetchFn,
    urlToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formulario.toString(),
    },
    tiempoMaximoMs,
  );
  const cuerpo = await leerJsonSeguro(respuesta);

  if (!respuesta.ok) {
    const errorOAuth = typeof cuerpo.error === 'string' ? cuerpo.error : '';
    if (errorOAuth === 'invalid_scope') {
      throw new ErrorProveedorCorreo('scope-insuficiente', 'El proveedor rechazó el scope pedido.');
    }
    if (errorOAuth === 'invalid_grant' || errorOAuth === 'redirect_uri_mismatch') {
      throw new ErrorProveedorCorreo(
        grantType === 'refresh_token' ? 'permiso-revocado' : 'codigo-invalido',
        grantType === 'refresh_token'
          ? 'El permiso del buzón venció o fue revocado.'
          : 'El código OAuth es inválido o ya venció.',
      );
    }
    if (respuesta.status === 429) {
      throw new ErrorProveedorCorreo(
        'limite-cuota',
        'El proveedor limitó temporalmente las solicitudes.',
        extraerRetryAfterSeg(respuesta),
      );
    }
    throw new ErrorProveedorCorreo(
      'proveedor-no-disponible',
      `El endpoint OAuth del proveedor respondió ${respuesta.status}.`,
    );
  }

  const accessToken = typeof cuerpo.access_token === 'string' ? cuerpo.access_token : '';
  const refreshToken = typeof cuerpo.refresh_token === 'string' ? cuerpo.refresh_token : undefined;
  const expiresIn = typeof cuerpo.expires_in === 'number' ? cuerpo.expires_in : 3600;
  const scope = typeof cuerpo.scope === 'string' ? cuerpo.scope : '';
  if (!accessToken) {
    throw new ErrorProveedorCorreo(
      'proveedor-no-disponible',
      'El proveedor no devolvió access_token.',
    );
  }

  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiraEn: new Date(ahora() + expiresIn * 1000),
    scope,
  };
}
