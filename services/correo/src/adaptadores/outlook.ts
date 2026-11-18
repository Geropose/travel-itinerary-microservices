// Adaptador de Outlook (specs/externos/outlook.md): Microsoft identity platform OAuth 2.0 +
// Microsoft Graph v1.0 con permisos de solo lectura Mail.Read + User.Read.
import { randomBytes } from 'node:crypto';
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
  type ResumenMensajeNuevo,
} from './tipos.ts';

const GRAPH_BASE_SCOPE = 'https://graph.microsoft.com/';
export const SCOPE_OUTLOOK_MAIL_READ = `${GRAPH_BASE_SCOPE}Mail.Read`;
export const SCOPE_OUTLOOK_USER_READ = `${GRAPH_BASE_SCOPE}User.Read`;
export const SCOPES_OUTLOOK = `offline_access ${SCOPE_OUTLOOK_MAIL_READ} ${SCOPE_OUTLOOK_USER_READ}`;

const SCOPES_PERMITIDOS_MIN = new Set([
  'https://graph.microsoft.com/mail.read',
  'https://graph.microsoft.com/user.read',
  'offline_access',
  'openid',
  'profile',
  'email',
]);

/** Suscripción válida por 6 días (máximo permitido por Graph: 10.080 minutos / 7 días). */
const VIDA_SUSCRIPCION_MS = 6 * 86_400_000;

export interface OpcionesAdaptadorOutlook {
  urlApi: string;
  urlPublica?: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** URL pública/interna de avisos (acepta función para puertos efímeros en pruebas). */
  urlAvisos: string | (() => string);
  tenant?: string;
  fetch?: FetchLike;
  tiempoMaximoMs?: number;
  ahora?: () => number;
}

function normalizarScopeOutlook(scope: string): string {
  const limpio = scope.trim().toLowerCase();
  if (['offline_access', 'openid', 'profile', 'email'].includes(limpio)) return limpio;
  return limpio.startsWith(GRAPH_BASE_SCOPE) ? limpio : `${GRAPH_BASE_SCOPE}${limpio}`;
}

function esScopeSoloLecturaOutlook(scopeTexto: string): boolean {
  const scopes = parsearScopes(scopeTexto).map(normalizarScopeOutlook);
  if (scopes.length === 0) return false;
  const conjunto = new Set(scopes);
  if (!conjunto.has('https://graph.microsoft.com/mail.read')) return false;
  if (!conjunto.has('https://graph.microsoft.com/user.read')) return false;
  return [...conjunto].every((s) => SCOPES_PERMITIDOS_MIN.has(s));
}

export function crearAdaptadorOutlook(opciones: OpcionesAdaptadorOutlook): AdaptadorCorreo {
  const urlApi = quitarBarraFinal(opciones.urlApi);
  const urlPublica = quitarBarraFinal(opciones.urlPublica ?? opciones.urlApi);
  const tenant = opciones.tenant ?? 'common';
  const fetchFn = opciones.fetch ?? fetch;
  const ahora = opciones.ahora ?? Date.now;

  const resolverUrlAvisos = () =>
    typeof opciones.urlAvisos === 'function' ? opciones.urlAvisos() : opciones.urlAvisos;

  async function llamarGraph(
    accessToken: string,
    urlCompleta: string,
    init: RequestInit = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const respuesta = await ejecutarFetch(
      fetchFn,
      urlCompleta,
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
      throw new ErrorProveedorCorreo('token-invalido', 'El access token de Outlook venció.');
    }
    if (respuesta.status === 429) {
      throw new ErrorProveedorCorreo(
        'limite-cuota',
        'Se alcanzó el límite de solicitudes de Microsoft Graph.',
        extraerRetryAfterSeg(respuesta),
      );
    }
    return { status: respuesta.status, json };
  }

  async function obtenerPerfil(accessToken: string): Promise<string> {
    const qs = new URLSearchParams({ $select: 'id,mail,userPrincipalName' });
    const { status, json } = await llamarGraph(accessToken, `${urlApi}/v1.0/me?${qs}`);
    if (status >= 400) {
      throw new ErrorProveedorCorreo(
        'proveedor-no-disponible',
        `Microsoft Graph /me respondió ${status}.`,
      );
    }
    // En cuentas personales `mail` puede ser null; se usa `userPrincipalName` (sección 1.6).
    const emailRaw =
      typeof json.mail === 'string' && json.mail
        ? json.mail
        : typeof json.userPrincipalName === 'string'
          ? json.userPrincipalName
          : '';
    const email = emailRaw.trim().toLowerCase();
    if (!email) {
      throw new ErrorProveedorCorreo(
        'proveedor-no-disponible',
        'Microsoft Graph /me no devolvió dirección de correo.',
      );
    }
    return email;
  }

  return {
    proveedor: 'outlook',
    soportaPush: true,

    urlAutorizacion(state) {
      const url = new URL(`${urlPublica}/${tenant}/oauth2/v2.0/authorize`);
      url.searchParams.set('client_id', opciones.clientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', opciones.redirectUri);
      url.searchParams.set('response_mode', 'query');
      url.searchParams.set('scope', SCOPES_OUTLOOK);
      url.searchParams.set('state', state);
      return url.toString();
    },

    validarScopeCallback(scope) {
      return esScopeSoloLecturaOutlook(scope);
    },

    async canjearCodigo(codigo) {
      const tokens = await solicitarTokenOAuth({
        fetchFn,
        urlToken: `${urlApi}/${tenant}/oauth2/v2.0/token`,
        grantType: 'authorization_code',
        tiempoMaximoMs: opciones.tiempoMaximoMs,
        ahora,
        formulario: new URLSearchParams({
          client_id: opciones.clientId,
          scope: SCOPES_OUTLOOK,
          code: codigo,
          redirect_uri: opciones.redirectUri,
          grant_type: 'authorization_code',
          client_secret: opciones.clientSecret,
        }),
      });
      if (!esScopeSoloLecturaOutlook(tokens.scope)) {
        throw new ErrorProveedorCorreo(
          'scope-insuficiente',
          'Outlook devolvió permisos distintos al scope de solo lectura.',
        );
      }
      if (!tokens.refreshToken) {
        throw new ErrorProveedorCorreo(
          'scope-insuficiente',
          'Outlook no devolvió refresh_token (se requiere offline_access).',
        );
      }
      const email = await obtenerPerfil(tokens.accessToken);
      const credenciales: CredencialesOAuth = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiraEn: tokens.expiraEn,
        scope: tokens.scope,
      };
      return { credenciales, perfil: { email } };
    },

    async renovarToken(refreshToken) {
      const tokens = await solicitarTokenOAuth({
        fetchFn,
        urlToken: `${urlApi}/${tenant}/oauth2/v2.0/token`,
        grantType: 'refresh_token',
        tiempoMaximoMs: opciones.tiempoMaximoMs,
        ahora,
        formulario: new URLSearchParams({
          client_id: opciones.clientId,
          scope: SCOPES_OUTLOOK,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
          client_secret: opciones.clientSecret,
        }),
      });
      if (!esScopeSoloLecturaOutlook(tokens.scope)) {
        throw new ErrorProveedorCorreo(
          'scope-insuficiente',
          'El token renovado de Outlook no mantiene permisos de solo lectura.',
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
      const inicioIso =
        desde.cursor ?? desde.fechaDesde?.toISOString() ?? '1970-01-01T00:00:00.000Z';
      const qs = new URLSearchParams({
        $filter: `receivedDateTime ge ${inicioIso}`,
        $orderby: 'receivedDateTime asc',
        $select: 'id,receivedDateTime',
        $top: '50',
      });
      let siguienteUrl: string | undefined = `${urlApi}/v1.0/me/messages?${qs}`;
      const mensajes: ResumenMensajeNuevo[] = [];
      let ultimoCursor = desde.cursor ?? undefined;

      while (siguienteUrl) {
        const { status, json } = await llamarGraph(accessToken, siguienteUrl);
        if (status >= 400) {
          throw new ErrorProveedorCorreo(
            'proveedor-no-disponible',
            `Graph /me/messages respondió ${status}.`,
          );
        }
        const lista = Array.isArray(json.value) ? json.value : [];
        for (const item of lista) {
          const m = item as { id?: unknown; receivedDateTime?: unknown };
          if (typeof m.id !== 'string' || !m.id) continue;
          const fechaStr = typeof m.receivedDateTime === 'string' ? m.receivedDateTime : undefined;
          const recibidoEn = fechaStr ? new Date(fechaStr) : undefined;
          mensajes.push({
            id: m.id,
            ...(recibidoEn && !Number.isNaN(recibidoEn.getTime()) ? { recibidoEn } : {}),
          });
          if (fechaStr) ultimoCursor = fechaStr;
        }
        siguienteUrl =
          typeof json['@odata.nextLink'] === 'string' ? json['@odata.nextLink'] : undefined;
      }

      return {
        mensajes,
        ...(ultimoCursor ? { nuevoCursor: ultimoCursor } : {}),
      };
    },

    async leerMensaje(accessToken, mensajeId): Promise<MensajeCorreo> {
      const qs = new URLSearchParams({
        $select: 'id,receivedDateTime,from,subject,body,internetMessageId',
      });
      const { status, json } = await llamarGraph(
        accessToken,
        `${urlApi}/v1.0/me/messages/${encodeURIComponent(mensajeId)}?${qs}`,
        { headers: { Prefer: 'outlook.body-content-type="html"' } },
      );
      if (status >= 400) {
        throw new ErrorProveedorCorreo(
          'proveedor-no-disponible',
          `Graph /me/messages/{id} respondió ${status}.`,
        );
      }

      const fromObj = json.from as { emailAddress?: { address?: unknown } } | undefined;
      const bodyObj = json.body as { contentType?: unknown; content?: unknown } | undefined;
      const tipoCuerpo =
        typeof bodyObj?.contentType === 'string' ? bodyObj.contentType.toLowerCase() : 'html';
      const contenido = typeof bodyObj?.content === 'string' ? bodyObj.content : '';
      const fechaStr = typeof json.receivedDateTime === 'string' ? json.receivedDateTime : '';
      const fechaParsed = fechaStr ? new Date(fechaStr) : new Date();
      const recibidoEn = Number.isNaN(fechaParsed.getTime()) ? new Date() : fechaParsed;
      const internetMessageId =
        typeof json.internetMessageId === 'string' ? json.internetMessageId : undefined;

      return {
        id: typeof json.id === 'string' ? json.id : mensajeId,
        remitente: extraerEmailRemitente(
          typeof fromObj?.emailAddress?.address === 'string' ? fromObj.emailAddress.address : '',
        ),
        asunto: typeof json.subject === 'string' ? json.subject : '',
        recibidoEn,
        ...(tipoCuerpo === 'text' ? { cuerpoTexto: contenido } : { cuerpoHtml: contenido }),
        ...(fechaStr ? { cursor: fechaStr } : {}),
        ...(internetMessageId ? { internetMessageId } : {}),
      };
    },

    async suscribirAvisos(accessToken) {
      const secreto = randomBytes(24).toString('base64url');
      const venceEn = new Date(ahora() + VIDA_SUSCRIPCION_MS);
      const { status, json } = await llamarGraph(accessToken, `${urlApi}/v1.0/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changeType: 'created',
          notificationUrl: resolverUrlAvisos(),
          resource: "me/mailFolders('Inbox')/messages",
          expirationDateTime: venceEn.toISOString(),
          clientState: secreto,
        }),
      });
      if (status >= 400) {
        throw new ErrorProveedorCorreo(
          'proveedor-no-disponible',
          `Graph /v1.0/subscriptions respondió ${status}.`,
        );
      }
      const suscripcionId = typeof json.id === 'string' ? json.id : '';
      const expiracion =
        typeof json.expirationDateTime === 'string' ? new Date(json.expirationDateTime) : venceEn;
      if (!suscripcionId) {
        throw new ErrorProveedorCorreo(
          'proveedor-no-disponible',
          'Graph no devolvió id de suscripción.',
        );
      }
      return {
        suscripcionId,
        venceEn: Number.isNaN(expiracion.getTime()) ? venceEn : expiracion,
        secreto,
      };
    },

    async desuscribirAvisos(accessToken, suscripcionId) {
      const { status } = await llamarGraph(
        accessToken,
        `${urlApi}/v1.0/subscriptions/${encodeURIComponent(suscripcionId)}`,
        { method: 'DELETE' },
      );
      if (status !== 204 && status !== 200 && status !== 404) {
        throw new ErrorProveedorCorreo(
          'proveedor-no-disponible',
          `Graph DELETE /v1.0/subscriptions respondió ${status}.`,
        );
      }
    },
  };
}
