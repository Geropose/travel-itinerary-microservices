// OAuth 2.0 de la Microsoft identity platform con authorization code (specs/externos/outlook.md,
// sección 1): pantalla de permiso, canje del código y renovación. Todo en memoria.
import { randomBytes } from 'node:crypto';
import express, { Router, type Request } from 'express';
import type { Almacen } from './buzones.ts';
import { errorToken } from './errores.ts';

const GRAPH = 'https://graph.microsoft.com/';

/** Permisos de Graph que conoce el mock (el nombre como lo escribe Microsoft). */
const PERMISOS_GRAPH = ['Mail.Read', 'Mail.ReadBasic', 'Mail.ReadWrite', 'Mail.Send', 'User.Read'];
/** Scopes de OpenID Connect: no son de Graph y no van en el `scope` de la respuesta (salvo openid...). */
const SCOPES_OIDC = ['offline_access', 'openid', 'profile', 'email'];

export const MAIL_READ = `${GRAPH}Mail.Read`;
export const USER_READ = `${GRAPH}User.Read`;

/** El código vence en alrededor de 1 minuto (sección 1.1). */
const VIDA_CODIGO_MS = 60_000;

/**
 * Normaliza los scopes pedidos ("Mail.Read" o la URL completa) a la URL completa de Graph.
 * Devuelve el primer scope inválido si hay uno.
 */
export function normalizarScopes(texto: string): { scopes: string[]; invalido?: string } {
  const scopes: string[] = [];
  for (const scope of texto.split(/\s+/).filter(Boolean)) {
    const minuscula = scope.toLowerCase();
    if (SCOPES_OIDC.includes(minuscula)) {
      scopes.push(minuscula);
      continue;
    }
    const nombre = minuscula.startsWith(GRAPH) ? scope.slice(GRAPH.length) : scope;
    const permiso = PERMISOS_GRAPH.find((p) => p.toLowerCase() === nombre.toLowerCase());
    if (!permiso || nombre.includes('/')) return { scopes, invalido: scope };
    scopes.push(`${GRAPH}${permiso}`);
  }
  return { scopes: [...new Set(scopes)] };
}

export interface OpcionesOAuth {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  vidaTokenS: number;
  reloj: () => number;
  almacen: Almacen;
}

interface Codigo {
  email: string;
  scopes: string[];
  redirectUri: string;
  vence: number;
  usado: boolean;
}

export interface Acceso {
  email: string;
  clientId: string;
  scopes: string[];
  vence: number;
}

export type ResultadoToken = { acceso: Acceso } | { error: 'vacio' | 'invalido' | 'vencido' };

export interface OAuth {
  router: Router;
  /** Revisa el header Authorization de una llamada a Graph. */
  validar(authorization: string | undefined): ResultadoToken;
  vencerTokens(email: string): number;
  revocar(email: string): number;
}

const alAzar = (bytes: number) => randomBytes(bytes).toString('base64url');

const escapar = (texto: string) =>
  texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ESTILO = `body{font-family:"Segoe UI",system-ui,sans-serif;background:#f2f2f2;margin:0;padding:16px}
main{max-width:440px;margin:40px auto;background:#fff;padding:32px;box-shadow:0 2px 6px #0003}
h1{font-size:1.4rem;font-weight:600}label{display:block;margin:16px 0}input{width:100%;padding:8px;box-sizing:border-box}
.botones{display:flex;gap:8px;justify-content:flex-end}button{padding:8px 24px;border:1px solid #8a8886;background:#fff}
button[value=permitir]{background:#0067b8;border-color:#0067b8;color:#fff}`;

function pagina(titulo: string, contenido: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapar(titulo)}</title>
<style>${ESTILO}</style></head><body><main>${contenido}</main></body></html>`;
}

const DESCRIPCION: Record<string, string> = {
  [MAIL_READ]: 'Leer tu correo (solo lectura)',
  [USER_READ]: 'Ver tu perfil básico',
  offline_access: 'Mantener el acceso que le diste',
};

/** Valor de texto de la query o del formulario. */
const texto = (valor: unknown) => (typeof valor === 'string' ? valor : '');

export function crearOAuth({
  clientId,
  clientSecret,
  redirectUris,
  vidaTokenS,
  reloj,
  almacen,
}: OpcionesOAuth): OAuth {
  const codigos = new Map<string, Codigo>();
  const accesos = new Map<string, Acceso>();
  const renovaciones = new Map<string, { email: string; scopes: string[] }>();
  const router = Router();

  /** Error del pedido de permiso que no permite volver a redirect_uri. */
  function revisarPedido(datos: Record<string, unknown>): string | undefined {
    if (texto(datos.client_id) !== clientId) {
      return `AADSTS700016: No existe la aplicación con id '${texto(datos.client_id)}'.`;
    }
    if (!redirectUris.includes(texto(datos.redirect_uri))) {
      return 'AADSTS50011: El redirect_uri del pedido no coincide con los registrados para la aplicación.';
    }
    return undefined;
  }

  /** Vuelve a redirect_uri con los parámetros, como response_mode=query. */
  function volver(redirectUri: string, parametros: Record<string, string>) {
    const destino = new URL(redirectUri);
    for (const [clave, valor] of Object.entries(parametros)) {
      if (valor) destino.searchParams.set(clave, valor);
    }
    return destino.toString();
  }

  // 1.1 Pantalla de permiso. {tenant} es "common"; el mock acepta cualquier valor.
  router.get('/:tenant/oauth2/v2.0/authorize', (req, res) => {
    const datos = req.query;
    const error = revisarPedido(datos);
    if (error) {
      res
        .status(400)
        .type('html')
        .send(pagina('Error', `<h1>No se pudo iniciar sesión</h1><p>${escapar(error)}</p>`));
      return;
    }
    const state = texto(datos.state);
    const redirectUri = texto(datos.redirect_uri);
    if (texto(datos.response_type) !== 'code') {
      res.redirect(302, volver(redirectUri, { error: 'unsupported_response_type', state }));
      return;
    }
    const { scopes, invalido } = normalizarScopes(texto(datos.scope));
    if (invalido || scopes.length === 0) {
      res.redirect(
        302,
        volver(redirectUri, {
          error: 'invalid_scope',
          error_description: `AADSTS70011: The provided value for the input parameter 'scope' is not valid. The scope ${invalido ?? '(vacío)'} is not valid.`,
          state,
        }),
      );
      return;
    }
    const ocultos = ['client_id', 'redirect_uri', 'scope', 'state']
      .map((n) => `<input type="hidden" name="${n}" value="${escapar(texto(datos[n]))}">`)
      .join('');
    const opciones = almacen
      .todos()
      .map((b) => `<option value="${escapar(b.email)}">`)
      .join('');
    const permisos = scopes
      .filter((s) => s !== 'openid' && s !== 'profile' && s !== 'email')
      .map((s) => `<li>${escapar(DESCRIPCION[s] ?? s)}</li>`)
      .join('');
    res.type('html').send(
      pagina(
        'Permisos solicitados',
        `<h1>Permisos solicitados</h1><p>Trotamundos quiere:</p><ul>${permisos}</ul>
<form method="post" action="/${escapar(req.params.tenant)}/oauth2/v2.0/authorize/decision">${ocultos}
<label>Cuenta <input name="email" type="email" list="buzones" required value="${escapar(texto(datos.login_hint))}"></label>
<datalist id="buzones">${opciones}</datalist>
<div class="botones"><button name="decision" value="cancelar" formnovalidate>Cancelar</button>
<button name="decision" value="permitir">Permitir</button></div></form>`,
      ),
    );
  });

  // Respuesta de la pantalla: vuelve a redirect_uri con el código o con access_denied.
  router.post(
    '/:tenant/oauth2/v2.0/authorize/decision',
    express.urlencoded({ extended: false }),
    (req, res) => {
      const datos = req.body as Record<string, unknown>;
      const error = revisarPedido(datos);
      if (error) {
        res
          .status(400)
          .type('html')
          .send(pagina('Error', `<p>${escapar(error)}</p>`));
        return;
      }
      const state = texto(datos.state);
      const redirectUri = texto(datos.redirect_uri);
      if (texto(datos.decision) !== 'permitir') {
        res.redirect(
          302,
          volver(redirectUri, {
            error: 'access_denied',
            error_description: 'the user canceled the authentication',
            state,
          }),
        );
        return;
      }
      const buzon = almacen.buscar(texto(datos.email));
      const { scopes, invalido } = normalizarScopes(texto(datos.scope));
      if (!buzon || invalido) {
        res
          .status(400)
          .type('html')
          .send(pagina('Error', '<p>No existe esa cuenta o el scope no es válido.</p>'));
        return;
      }
      const codigo = `OAAABAAAA${alAzar(48)}`;
      codigos.set(codigo, {
        email: buzon.email,
        scopes,
        redirectUri,
        vence: reloj() + VIDA_CODIGO_MS,
        usado: false,
      });
      res.redirect(302, volver(redirectUri, { code: codigo, state }));
    },
  );

  /** client_id y client_secret, en el cuerpo o con HTTP Basic. */
  function cliente(req: Request, datos: Record<string, unknown>) {
    const basico = /^Basic (.+)$/.exec(req.get('authorization') ?? '');
    if (basico?.[1]) {
      const [id = '', secreto = ''] = Buffer.from(basico[1], 'base64').toString().split(':');
      return { id: decodeURIComponent(id), secreto: decodeURIComponent(secreto) };
    }
    return { id: texto(datos.client_id), secreto: texto(datos.client_secret) };
  }

  /** Respuesta del canje y de la renovación (sección 1.2), con un refresh token nuevo. */
  function emitir(email: string, scopes: string[]) {
    const token = `eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.${alAzar(48)}`;
    accesos.set(token, { email, clientId, scopes, vence: reloj() + vidaTokenS * 1000 });
    const respuesta: Record<string, unknown> = {
      access_token: token,
      token_type: 'Bearer',
      expires_in: vidaTokenS,
      scope: scopes.filter((s) => s !== 'offline_access').join(' '),
    };
    // Sin offline_access no hay refresh_token.
    if (scopes.includes('offline_access')) {
      const renovacion = `AwABAAAA${alAzar(48)}`;
      renovaciones.set(renovacion, { email, scopes });
      respuesta.refresh_token = renovacion;
    }
    return respuesta;
  }

  // 1.2 y 1.3: canje del código y renovación.
  router.post('/:tenant/oauth2/v2.0/token', express.urlencoded({ extended: false }), (req, res) => {
    const datos = (req.body ?? {}) as Record<string, unknown>;
    const ahora = reloj();
    res.set('Cache-Control', 'no-store');
    const { id, secreto } = cliente(req, datos);
    if (id !== clientId || secreto !== clientSecret) {
      res
        .status(401)
        .json(errorToken('invalid_client', 7000215, 'Invalid client secret provided.', ahora));
      return;
    }
    const pedido = normalizarScopes(texto(datos.scope));
    if (pedido.invalido) {
      res
        .status(400)
        .json(
          errorToken(
            'invalid_scope',
            70011,
            `The provided value for the input parameter 'scope' is not valid. The scope ${pedido.invalido} is not valid.`,
            ahora,
          ),
        );
      return;
    }
    const tipo = texto(datos.grant_type);

    if (tipo === 'authorization_code') {
      const codigo = codigos.get(texto(datos.code));
      if (!codigo) {
        res
          .status(400)
          .json(
            errorToken(
              'invalid_grant',
              70000,
              'The provided authorization code is invalid.',
              ahora,
            ),
          );
        return;
      }
      if (codigo.usado) {
        res
          .status(400)
          .json(
            errorToken(
              'invalid_grant',
              54005,
              'OAuth2 Authorization code was already redeemed.',
              ahora,
            ),
          );
        return;
      }
      if (codigo.vence <= ahora) {
        res
          .status(400)
          .json(
            errorToken(
              'invalid_grant',
              70008,
              'The provided authorization code has expired.',
              ahora,
            ),
          );
        return;
      }
      if (codigo.redirectUri !== texto(datos.redirect_uri)) {
        res
          .status(400)
          .json(
            errorToken(
              'invalid_grant',
              50148,
              'The redirect_uri does not match the one used to get the code.',
              ahora,
            ),
          );
        return;
      }
      codigo.usado = true;
      res.json(emitir(codigo.email, codigo.scopes));
      return;
    }

    if (tipo === 'refresh_token') {
      const viejo = texto(datos.refresh_token);
      const renovacion = renovaciones.get(viejo);
      if (!renovacion) {
        res
          .status(400)
          .json(
            errorToken(
              'invalid_grant',
              50173,
              'The provided grant has expired due to it being revoked.',
              ahora,
            ),
          );
        return;
      }
      // Trae un refresh token nuevo: el mock descarta el anterior (sección 1.3).
      renovaciones.delete(viejo);
      res.json(emitir(renovacion.email, renovacion.scopes));
      return;
    }

    res
      .status(400)
      .json(
        errorToken(
          'unsupported_grant_type',
          70003,
          `The app requested an unsupported grant type '${tipo}'.`,
          ahora,
        ),
      );
  });

  return {
    router,
    validar(authorization) {
      const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
      if (!token) return { error: 'vacio' };
      const acceso = accesos.get(token);
      if (!acceso) return { error: 'invalido' };
      if (acceso.vence <= reloj()) return { error: 'vencido' };
      return { acceso };
    },
    vencerTokens(email) {
      let cantidad = 0;
      for (const acceso of accesos.values()) {
        if (acceso.email === email && acceso.vence > reloj()) {
          acceso.vence = reloj();
          cantidad += 1;
        }
      }
      return cantidad;
    },
    revocar(email) {
      let cantidad = 0;
      for (const mapa of [accesos, renovaciones]) {
        for (const [token, dueno] of mapa) {
          if (dueno.email === email) {
            mapa.delete(token);
            cantidad += 1;
          }
        }
      }
      return cantidad;
    },
  };
}
