// OAuth 2.0 de Google con authorization code (specs/externos/gmail.md, sección 1): pantalla de
// permiso, canje del código y renovación del token. Todo en memoria.
import { randomBytes } from 'node:crypto';
import express, { Router, type Request } from 'express';
import type { Almacen } from './buzones.ts';
import { errorToken } from './errores.ts';

/** Único scope que usa Trotamundos (ADR-015): solo lectura. */
export const SCOPE_LECTURA = 'https://www.googleapis.com/auth/gmail.readonly';

/** Vida del código de autorización (Google: unos minutos). */
const VIDA_CODIGO_MS = 10 * 60_000;

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
  scope: string;
  redirectUri: string;
  offline: boolean;
  vence: number;
  usado: boolean;
}

export interface Acceso {
  email: string;
  scope: string;
  vence: number;
}

export interface OAuth {
  router: Router;
  /** Dueño del access token, si es válido, no venció y tiene el scope gmail.readonly. */
  validar(authorization: string | undefined): Acceso | undefined;
  /** Hace vencer los access tokens del buzón (para probar la renovación). */
  vencerTokens(email: string): number;
  /** Revoca los refresh tokens y access tokens del buzón (el usuario quitó el permiso). */
  revocar(email: string): number;
}

const alAzar = (bytes: number) => randomBytes(bytes).toString('base64url');

const escapar = (texto: string) =>
  texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ESTILO = `body{font-family:system-ui,sans-serif;background:#f1f3f4;margin:0;padding:16px}
main{max-width:420px;margin:40px auto;background:#fff;border-radius:8px;padding:24px;box-shadow:0 1px 3px #0003}
h1{font-size:1.3rem}label{display:block;margin:16px 0}input{width:100%;padding:8px;box-sizing:border-box}
.botones{display:flex;gap:8px;justify-content:flex-end}button{padding:8px 16px;border-radius:4px;border:1px solid #1a73e8;background:#fff;color:#1a73e8}
button[value=permitir]{background:#1a73e8;color:#fff}`;

function pagina(titulo: string, contenido: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapar(titulo)}</title>
<style>${ESTILO}</style></head><body><main>${contenido}</main></body></html>`;
}

const paginaError = (codigo: string, detalle: string) =>
  pagina('Error de acceso', `<h1>Error 400: ${escapar(codigo)}</h1><p>${escapar(detalle)}</p>`);

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
  const renovaciones = new Map<string, { email: string; scope: string }>();
  const router = Router();

  /** Error de los parámetros del pedido de permiso, o undefined si están bien. */
  function revisarPedido(datos: Record<string, unknown>): [string, string] | undefined {
    if (texto(datos.client_id) !== clientId)
      return ['invalid_client', 'El cliente OAuth no existe.'];
    if (!redirectUris.includes(texto(datos.redirect_uri))) {
      return ['redirect_uri_mismatch', 'El redirect_uri no está registrado para este cliente.'];
    }
    if (texto(datos.response_type) && texto(datos.response_type) !== 'code') {
      return ['unsupported_response_type', 'Solo se acepta response_type=code.'];
    }
    if (!texto(datos.scope).trim()) return ['invalid_request', 'Falta el parámetro scope.'];
    return undefined;
  }

  // 1.1 Pantalla de permiso (Google acepta las dos rutas).
  router.get(['/o/oauth2/v2/auth', '/o/oauth2/auth'], (req, res) => {
    const datos = req.query;
    const error = revisarPedido(datos);
    if (error || texto(datos.response_type) !== 'code') {
      const [codigo, detalle] = error ?? ['invalid_request', 'Falta response_type=code.'];
      res.status(400).type('html').send(paginaError(codigo, detalle));
      return;
    }
    const ocultos = ['client_id', 'redirect_uri', 'scope', 'state', 'access_type']
      .map((n) => `<input type="hidden" name="${n}" value="${escapar(texto(datos[n]))}">`)
      .join('');
    const opciones = almacen
      .todos()
      .map((b) => `<option value="${escapar(b.email)}">`)
      .join('');
    const permisos = texto(datos.scope)
      .split(' ')
      .filter(Boolean)
      .map((s) => `<li>${s === SCOPE_LECTURA ? 'Ver tus correos (solo lectura)' : escapar(s)}</li>`)
      .join('');
    res.type('html').send(
      pagina(
        'Acceder con Google',
        `<h1>Trotamundos quiere acceder a tu cuenta de Google</h1>
<p>Va a poder:</p><ul>${permisos}</ul>
<form method="post" action="/o/oauth2/v2/auth/decision">${ocultos}
<label>Cuenta <input name="email" type="email" list="buzones" required value="${escapar(texto(datos.login_hint))}"></label>
<datalist id="buzones">${opciones}</datalist>
<div class="botones"><button name="decision" value="cancelar" formnovalidate>Cancelar</button>
<button name="decision" value="permitir">Permitir</button></div></form>`,
      ),
    );
  });

  // Respuesta de la pantalla: vuelve a redirect_uri con el código o con access_denied.
  router.post('/o/oauth2/v2/auth/decision', express.urlencoded({ extended: false }), (req, res) => {
    const datos = req.body as Record<string, unknown>;
    const error = revisarPedido(datos);
    if (error) {
      res
        .status(400)
        .type('html')
        .send(paginaError(...error));
      return;
    }
    const destino = new URL(texto(datos.redirect_uri));
    const state = texto(datos.state);
    if (texto(datos.decision) !== 'permitir') {
      destino.searchParams.set('error', 'access_denied');
      if (state) destino.searchParams.set('state', state);
      res.redirect(302, destino.toString());
      return;
    }
    const buzon = almacen.buscar(texto(datos.email));
    if (!buzon) {
      res.status(400).type('html').send(paginaError('account_not_found', 'No existe esa cuenta.'));
      return;
    }
    const codigo = `4/${alAzar(24)}`;
    const scope = texto(datos.scope).trim();
    codigos.set(codigo, {
      email: buzon.email,
      scope,
      redirectUri: texto(datos.redirect_uri),
      offline: texto(datos.access_type) === 'offline',
      vence: reloj() + VIDA_CODIGO_MS,
      usado: false,
    });
    destino.searchParams.set('code', codigo);
    destino.searchParams.set('scope', scope);
    if (state) destino.searchParams.set('state', state);
    res.redirect(302, destino.toString());
  });

  /** client_id y client_secret, en el cuerpo o con HTTP Basic. */
  function cliente(req: Request, datos: Record<string, unknown>) {
    const basico = /^Basic (.+)$/.exec(req.get('authorization') ?? '');
    if (basico?.[1]) {
      const [id = '', secreto = ''] = Buffer.from(basico[1], 'base64').toString().split(':');
      return { id: decodeURIComponent(id), secreto: decodeURIComponent(secreto) };
    }
    return { id: texto(datos.client_id), secreto: texto(datos.client_secret) };
  }

  function nuevoAcceso(email: string, scope: string) {
    const token = `ya29.${alAzar(32)}`;
    accesos.set(token, { email, scope, vence: reloj() + vidaTokenS * 1000 });
    return { access_token: token, expires_in: vidaTokenS, scope, token_type: 'Bearer' };
  }

  // 1.2 y 1.3: canje del código y renovación.
  router.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    const datos = (req.body ?? {}) as Record<string, unknown>;
    res.set('Cache-Control', 'no-store');
    const { id, secreto } = cliente(req, datos);
    if (id !== clientId || secreto !== clientSecret) {
      res.status(401).json(errorToken('invalid_client', 'Unauthorized'));
      return;
    }
    const tipo = texto(datos.grant_type);

    if (tipo === 'authorization_code') {
      const codigo = codigos.get(texto(datos.code));
      if (!codigo || codigo.usado || codigo.vence <= reloj()) {
        res.status(400).json(errorToken('invalid_grant', 'Malformed auth code.'));
        return;
      }
      if (codigo.redirectUri !== texto(datos.redirect_uri)) {
        res.status(400).json(errorToken('redirect_uri_mismatch', 'Bad Request'));
        return;
      }
      // Un código se usa una sola vez.
      codigo.usado = true;
      const respuesta: Record<string, unknown> = nuevoAcceso(codigo.email, codigo.scope);
      if (codigo.offline) {
        // Sin access_type=offline, Google no devuelve refresh_token.
        const renovacion = `1//${alAzar(32)}`;
        renovaciones.set(renovacion, { email: codigo.email, scope: codigo.scope });
        respuesta.refresh_token = renovacion;
      }
      // Mismo orden de campos que el ejemplo de la sección 1.2.
      const { access_token, expires_in, refresh_token, scope, token_type } = respuesta;
      res.json({ access_token, expires_in, refresh_token, scope, token_type });
      return;
    }

    if (tipo === 'refresh_token') {
      const renovacion = renovaciones.get(texto(datos.refresh_token));
      if (!renovacion) {
        res.status(400).json(errorToken('invalid_grant', 'Token has been expired or revoked.'));
        return;
      }
      // Sin refresh_token: se sigue usando el mismo.
      res.json(nuevoAcceso(renovacion.email, renovacion.scope));
      return;
    }

    res
      .status(400)
      .json(errorToken('unsupported_grant_type', `Invalid grant_type: ${tipo || '(vacío)'}`));
  });

  return {
    router,
    validar(authorization) {
      const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
      const acceso = token ? accesos.get(token) : undefined;
      if (!acceso || acceso.vence <= reloj()) return undefined;
      if (!acceso.scope.split(' ').includes(SCOPE_LECTURA)) return undefined;
      return acceso;
    },
    vencerTokens(email) {
      let cantidad = 0;
      for (const acceso of accesos.values()) {
        if (acceso.email === email.toLowerCase() && acceso.vence > reloj()) {
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
          if (dueno.email === email.toLowerCase()) {
            mapa.delete(token);
            cantidad += 1;
          }
        }
      }
      return cantidad;
    },
  };
}
