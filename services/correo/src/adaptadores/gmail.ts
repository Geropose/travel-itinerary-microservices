// Adaptador de Gmail (specs/externos/gmail.md): OAuth 2.0 + Gmail API v1 con scope gmail.readonly.
import {
  ejecutarFetch,
  extraerEmailRemitente,
  extraerRetryAfterSeg,
  leerJsonSeguro,
  parsearScopes,
  quitarBarraFinal,
  solicitarTokenOAuth,
  type FetchLike,
} from './comun.ts';
import {
  ErrorProveedorCorreo,
  type AdaptadorCorreo,
  type CredencialesOAuth,
  type DesdeRevision,
  type MensajeCorreo,
  type ResultadoListaMensajes,
} from './tipos.ts';

export const SCOPE_GMAIL_LECTURA = 'https://www.googleapis.com/auth/gmail.readonly';

export interface OpcionesAdaptadorGmail {
  /** URL base para llamadas backend (API, /token). */
  urlApi: string;
  /** URL base para la pantalla de permiso en el navegador (por defecto urlApi). */
  urlPublica?: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  topicoWatch: string;
  fetch?: FetchLike;
  tiempoMaximoMs?: number;
  ahora?: () => number;
}

interface ParteGmail {
  mimeType?: string;
  headers?: { name?: string; value?: string }[];
  body?: { size?: number; data?: string };
  parts?: ParteGmail[];
}

function esScopeSoloLecturaGmail(scopeTexto: string): boolean {
  const scopes = new Set(parsearScopes(scopeTexto));
  return scopes.size === 1 && scopes.has(SCOPE_GMAIL_LECTURA);
}

function decodificarBase64Url(datos: string): string {
  const normalizado = datos.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return Buffer.from(normalizado, 'base64url').toString('utf8');
}

function buscarHeader(headers: { name?: string; value?: string }[] | undefined, nombre: string) {
  const objetivo = nombre.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === objetivo)?.value ?? '';
}

function extraerCuerposMime(parte: ParteGmail | undefined): { html?: string; texto?: string } {
  const resultado: { html?: string; texto?: string } = {};
  if (!parte) return resultado;

  const recorrer = (nodo: ParteGmail) => {
    const tipo = (nodo.mimeType ?? '').toLowerCase();
    if (nodo.body?.data) {
      if (tipo === 'text/html' && resultado.html === undefined) {
        resultado.html = decodificarBase64Url(nodo.body.data);
      } else if (tipo === 'text/plain' && resultado.texto === undefined) {
        resultado.texto = decodificarBase64Url(nodo.body.data);
      }
    }
    for (const hija of nodo.parts ?? []) recorrer(hija);
  };

  recorrer(parte);
  return resultado;
}

export function crearAdaptadorGmail(opciones: OpcionesAdaptadorGmail): AdaptadorCorreo {
  const urlApi = quitarBarraFinal(opciones.urlApi);
  const urlPublica = quitarBarraFinal(opciones.urlPublica ?? opciones.urlApi);
  const fetchFn = opciones.fetch ?? fetch;
  const ahora = opciones.ahora ?? Date.now;

  async function llamarApi(
    accessToken: string,
    rutaConQuery: string,
    init: RequestInit = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const respuesta = await ejecutarFetch(
      fetchFn,
      `${urlApi}${rutaConQuery}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...init.headers,
        },
      },
      opciones.tiempoMaximoMs,
    );
    const json = await leerJsonSeguro(respuesta);
    if (respuesta.status === 401) {
      throw new ErrorProveedorCorreo('token-invalido', 'El access token de Gmail venció.');
    }
    if (respuesta.status === 429) {
      throw new ErrorProveedorCorreo(
        'limite-cuota',
        'Se alcanzó el límite de cuota de Gmail.',
        extraerRetryAfterSeg(respuesta),
      );
    }
    return { status: respuesta.status, json };
  }

  async function obtenerPerfil(
    accessToken: string,
  ): Promise<{ email: string; historyId?: string }> {
    const { status, json } = await llamarApi(accessToken, '/gmail/v1/users/me/profile');
    if (status >= 400) {
      throw new ErrorProveedorCorreo(
        'proveedor-no-disponible',
        `Gmail profile respondió ${status}.`,
      );
    }
    const email =
      typeof json.emailAddress === 'string' ? json.emailAddress.trim().toLowerCase() : '';
    if (!email) {
      throw new ErrorProveedorCorreo(
        'proveedor-no-disponible',
        'Gmail no informó emailAddress en el perfil.',
      );
    }
    const historyId = typeof json.historyId === 'string' ? json.historyId : undefined;
    return { email, ...(historyId ? { historyId } : {}) };
  }

  async function sincronizacionCompleta(
    accessToken: string,
    fechaDesde?: Date,
  ): Promise<ResultadoListaMensajes> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    const q = fechaDesde ? `after:${Math.floor(fechaDesde.getTime() / 1000)}` : undefined;

    do {
      const qs = new URLSearchParams({ maxResults: '100' });
      if (q) qs.set('q', q);
      if (pageToken) qs.set('pageToken', pageToken);
      const { status, json } = await llamarApi(accessToken, `/gmail/v1/users/me/messages?${qs}`);
      if (status >= 400) {
        throw new ErrorProveedorCorreo(
          'proveedor-no-disponible',
          `Gmail messages.list respondió ${status}.`,
        );
      }
      const lista = Array.isArray(json.messages) ? json.messages : [];
      for (const item of lista) {
        const id = (item as { id?: unknown }).id;
        if (typeof id === 'string' && id) ids.push(id);
      }
      pageToken = typeof json.nextPageToken === 'string' ? json.nextPageToken : undefined;
    } while (pageToken);

    // messages.list devuelve del más nuevo al más viejo; procesamos en orden cronológico.
    ids.reverse();
    const perfil = await obtenerPerfil(accessToken);
    return {
      mensajes: ids.map((id) => ({ id })),
      ...(perfil.historyId ? { nuevoCursor: perfil.historyId } : {}),
    };
  }

  return {
    proveedor: 'gmail',

    urlAutorizacion(state) {
      const url = new URL(`${urlPublica}/o/oauth2/v2/auth`);
      url.searchParams.set('client_id', opciones.clientId);
      url.searchParams.set('redirect_uri', opciones.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', SCOPE_GMAIL_LECTURA);
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('include_granted_scopes', 'true');
      url.searchParams.set('state', state);
      return url.toString();
    },

    validarScopeCallback(scope) {
      return esScopeSoloLecturaGmail(scope);
    },

    async canjearCodigo(codigo) {
      const tokens = await solicitarTokenOAuth({
        fetchFn,
        urlToken: `${urlApi}/token`,
        grantType: 'authorization_code',
        tiempoMaximoMs: opciones.tiempoMaximoMs,
        ahora,
        formulario: new URLSearchParams({
          code: codigo,
          client_id: opciones.clientId,
          client_secret: opciones.clientSecret,
          redirect_uri: opciones.redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      if (!esScopeSoloLecturaGmail(tokens.scope)) {
        throw new ErrorProveedorCorreo(
          'scope-insuficiente',
          'Gmail devolvió permisos distintos al scope de solo lectura.',
        );
      }
      if (!tokens.refreshToken) {
        throw new ErrorProveedorCorreo(
          'scope-insuficiente',
          'Gmail no devolvió refresh_token (se requiere acceso offline).',
        );
      }
      const perfil = await obtenerPerfil(tokens.accessToken);
      const credenciales: CredencialesOAuth = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiraEn: tokens.expiraEn,
        scope: tokens.scope,
      };
      return { credenciales, perfil: { email: perfil.email } };
    },

    async renovarToken(refreshToken) {
      const tokens = await solicitarTokenOAuth({
        fetchFn,
        urlToken: `${urlApi}/token`,
        grantType: 'refresh_token',
        tiempoMaximoMs: opciones.tiempoMaximoMs,
        ahora,
        formulario: new URLSearchParams({
          client_id: opciones.clientId,
          client_secret: opciones.clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });
      if (!esScopeSoloLecturaGmail(tokens.scope)) {
        throw new ErrorProveedorCorreo(
          'scope-insuficiente',
          'El token renovado de Gmail no mantiene el scope de solo lectura.',
        );
      }
      return {
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        expiraEn: tokens.expiraEn,
        scope: tokens.scope,
      };
    },

    async listarNuevos(accessToken, desde: DesdeRevision): Promise<ResultadoListaMensajes> {
      if (!desde.cursor) return sincronizacionCompleta(accessToken, desde.fechaDesde);

      const ids = new Set<string>();
      let pageToken: string | undefined;
      let nuevoCursor = desde.cursor;

      do {
        const qs = new URLSearchParams({
          startHistoryId: desde.cursor,
          historyTypes: 'messageAdded',
          maxResults: '100',
        });
        if (pageToken) qs.set('pageToken', pageToken);
        const { status, json } = await llamarApi(accessToken, `/gmail/v1/users/me/history?${qs}`);

        if (status === 404) {
          const completa = await sincronizacionCompleta(accessToken, desde.fechaDesde);
          return { ...completa, cursorExpirado: true };
        }
        if (status >= 400) {
          throw new ErrorProveedorCorreo(
            'proveedor-no-disponible',
            `Gmail history.list respondió ${status}.`,
          );
        }

        if (typeof json.historyId === 'string' && json.historyId) {
          nuevoCursor = json.historyId;
        }
        const historial = Array.isArray(json.history) ? json.history : [];
        for (const entrada of historial) {
          const obj = entrada as {
            messagesAdded?: { message?: { id?: string } }[];
            messages?: { id?: string }[];
          };
          const agregados = obj.messagesAdded ?? [];
          if (agregados.length > 0) {
            for (const m of agregados) {
              if (typeof m.message?.id === 'string' && m.message.id) ids.add(m.message.id);
            }
          } else {
            for (const m of obj.messages ?? []) {
              if (typeof m.id === 'string' && m.id) ids.add(m.id);
            }
          }
        }
        pageToken = typeof json.nextPageToken === 'string' ? json.nextPageToken : undefined;
      } while (pageToken);

      return {
        mensajes: [...ids].map((id) => ({ id })),
        nuevoCursor,
      };
    },

    async leerMensaje(accessToken, mensajeId): Promise<MensajeCorreo> {
      const qs = new URLSearchParams({ format: 'full' });
      const { status, json } = await llamarApi(
        accessToken,
        `/gmail/v1/users/me/messages/${encodeURIComponent(mensajeId)}?${qs}`,
      );
      if (status >= 400) {
        throw new ErrorProveedorCorreo(
          'proveedor-no-disponible',
          `Gmail messages.get respondió ${status}.`,
        );
      }

      const payload = (json.payload ?? {}) as ParteGmail;
      const headers = payload.headers;
      const cuerpos = extraerCuerposMime(payload);
      const internalDateMs = Number(json.internalDate);
      const recibidoEn = Number.isFinite(internalDateMs) ? new Date(internalDateMs) : new Date();
      const messageIdHeader = buscarHeader(headers, 'Message-ID');
      const historyId = typeof json.historyId === 'string' ? json.historyId : undefined;

      return {
        id: typeof json.id === 'string' ? json.id : mensajeId,
        remitente: extraerEmailRemitente(buscarHeader(headers, 'From')),
        asunto: buscarHeader(headers, 'Subject'),
        recibidoEn,
        ...(cuerpos.html !== undefined ? { cuerpoHtml: cuerpos.html } : {}),
        ...(cuerpos.texto !== undefined ? { cuerpoTexto: cuerpos.texto } : {}),
        ...(historyId ? { cursor: historyId } : {}),
        ...(messageIdHeader ? { internetMessageId: messageIdHeader } : {}),
      };
    },

    async suscribirAvisos(accessToken) {
      const { status, json } = await llamarApi(accessToken, '/gmail/v1/users/me/watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topicName: opciones.topicoWatch,
          labelIds: ['INBOX'],
          labelFilterBehavior: 'include',
        }),
      });
      if (status >= 400) {
        throw new ErrorProveedorCorreo(
          'proveedor-no-disponible',
          `Gmail watch respondió ${status}.`,
        );
      }
      const expirationMs = Number(json.expiration);
      if (!Number.isFinite(expirationMs)) {
        throw new ErrorProveedorCorreo(
          'proveedor-no-disponible',
          'Gmail watch no devolvió expiration.',
        );
      }
      const historyId = typeof json.historyId === 'string' ? json.historyId : undefined;
      return {
        suscripcionId: opciones.topicoWatch,
        venceEn: new Date(expirationMs),
        ...(historyId ? { cursorInicial: historyId } : {}),
      };
    },
  };
}
