// OAuth 2.0 contra specs/externos/gmail.md, sección 1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCOPE_LECTURA } from '../src/oauth.ts';
import { CLIENTE, conectar, gmail, levantar, REDIRECT, SECRETO, type Entorno } from './ayuda.ts';

let e: Entorno;
beforeAll(async () => {
  e = await levantar();
});
afterAll(() => e.cerrar());

const token = (datos: Record<string, string>) =>
  fetch(`${e.url}/token`, { method: 'POST', body: new URLSearchParams(datos) });

describe('1.1 pantalla de permiso', () => {
  const pedido = new URLSearchParams({
    client_id: CLIENTE,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE_LECTURA,
    access_type: 'offline',
    include_granted_scopes: 'true',
    state: 'abc',
    login_hint: 'ana.garcia@gmail.example',
  });

  it('muestra el botón "Permitir" en /o/oauth2/v2/auth y en /o/oauth2/auth', async () => {
    for (const ruta of ['/o/oauth2/v2/auth', '/o/oauth2/auth']) {
      const respuesta = await fetch(`${e.url}${ruta}?${pedido.toString()}`);
      const html = await respuesta.text();
      expect(respuesta.status).toBe(200);
      expect(html).toContain('Permitir');
      expect(html).toContain('Ver tus correos (solo lectura)');
      expect(html).toContain('value="ana.garcia@gmail.example"');
    }
  });

  it('rechaza un cliente o un redirect_uri que no están registrados', async () => {
    const otroCliente = new URLSearchParams(pedido);
    otroCliente.set('client_id', 'otro.apps.googleusercontent.com');
    const otraVuelta = new URLSearchParams(pedido);
    otraVuelta.set('redirect_uri', 'https://malicioso.example/callback');
    expect((await fetch(`${e.url}/o/oauth2/v2/auth?${otroCliente.toString()}`)).status).toBe(400);
    const respuesta = await fetch(`${e.url}/o/oauth2/v2/auth?${otraVuelta.toString()}`);
    expect(respuesta.status).toBe(400);
    expect(await respuesta.text()).toContain('redirect_uri_mismatch');
  });

  const decidir = (decision: string, email = 'ana.garcia@gmail.example') =>
    fetch(`${e.url}/o/oauth2/v2/auth/decision`, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({
        client_id: CLIENTE,
        redirect_uri: REDIRECT,
        scope: SCOPE_LECTURA,
        state: 'state-firmado',
        access_type: 'offline',
        email,
        decision,
      }),
    });

  it('"Permitir" vuelve a redirect_uri con code, scope y el mismo state', async () => {
    const respuesta = await decidir('permitir');
    expect(respuesta.status).toBe(302);
    const vuelta = new URL(respuesta.headers.get('location') ?? '');
    expect(`${vuelta.origin}${vuelta.pathname}`).toBe(REDIRECT);
    expect(vuelta.searchParams.get('code')).toMatch(/^4\//);
    expect(vuelta.searchParams.get('scope')).toBe(SCOPE_LECTURA);
    expect(vuelta.searchParams.get('state')).toBe('state-firmado');
  });

  it('"Cancelar" vuelve con error=access_denied y el state', async () => {
    const vuelta = new URL((await decidir('cancelar')).headers.get('location') ?? '');
    expect(vuelta.searchParams.get('error')).toBe('access_denied');
    expect(vuelta.searchParams.get('state')).toBe('state-firmado');
    expect(vuelta.searchParams.has('code')).toBe(false);
  });

  it('una cuenta que no existe no recibe código', async () => {
    expect((await decidir('permitir', 'nadie@gmail.example')).status).toBe(400);
  });
});

describe('1.2 y 1.3 canje y renovación', () => {
  it('el canje devuelve access_token, expires_in, refresh_token, scope y token_type', async () => {
    const respuesta = await conectar(e.url, 'bruno.diaz@gmail.example');
    expect(Object.keys(respuesta)).toEqual([
      'access_token',
      'expires_in',
      'refresh_token',
      'scope',
      'token_type',
    ]);
    expect(respuesta.access_token).toMatch(/^ya29\./);
    expect(respuesta.refresh_token).toMatch(/^1\/\//);
    expect(respuesta.expires_in).toBe(3599);
    expect(respuesta.scope).toBe(SCOPE_LECTURA);
    expect(respuesta.token_type).toBe('Bearer');
  });

  it('sin access_type=offline no hay refresh_token', async () => {
    const respuesta = await conectar(e.url, 'bruno.diaz@gmail.example', { offline: false });
    expect(respuesta.refresh_token).toBeUndefined();
  });

  it('la renovación devuelve un token nuevo sin refresh_token', async () => {
    const { refresh_token = '' } = await conectar(e.url, 'carla.mendez@gmail.example');
    const respuesta = await token({
      client_id: CLIENTE,
      client_secret: SECRETO,
      refresh_token,
      grant_type: 'refresh_token',
    });
    const cuerpo = (await respuesta.json()) as Record<string, unknown>;
    expect(respuesta.status).toBe(200);
    expect(Object.keys(cuerpo)).toEqual(['access_token', 'expires_in', 'scope', 'token_type']);
    const perfil = await gmail(e.url, String(cuerpo.access_token), '/profile');
    expect(perfil.cuerpo.emailAddress).toBe('carla.mendez@gmail.example');
  });
});

describe('1.4 errores de /token', () => {
  it('un código ya usado o inventado: 400 invalid_grant', async () => {
    const decision = await fetch(`${e.url}/o/oauth2/v2/auth/decision`, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({
        client_id: CLIENTE,
        redirect_uri: REDIRECT,
        scope: SCOPE_LECTURA,
        email: 'diego.fernandez@gmail.example',
        decision: 'permitir',
      }),
    });
    const code = new URL(decision.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const canje = {
      code,
      client_id: CLIENTE,
      client_secret: SECRETO,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    };
    expect((await token(canje)).status).toBe(200);
    for (const datos of [canje, { ...canje, code: '4/inventado' }]) {
      const respuesta = await token(datos);
      expect(respuesta.status).toBe(400);
      expect(await respuesta.json()).toMatchObject({ error: 'invalid_grant' });
    }
  });

  it('un código vencido (más de 10 min): invalid_grant', async () => {
    const decision = await fetch(`${e.url}/o/oauth2/v2/auth/decision`, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({
        client_id: CLIENTE,
        redirect_uri: REDIRECT,
        scope: SCOPE_LECTURA,
        email: 'diego.fernandez@gmail.example',
        decision: 'permitir',
      }),
    });
    const code = new URL(decision.headers.get('location') ?? '').searchParams.get('code') ?? '';
    e.reloj.ahora += 11 * 60_000;
    const respuesta = await token({
      code,
      client_id: CLIENTE,
      client_secret: SECRETO,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    });
    expect(await respuesta.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('un refresh token revocado: invalid_grant; un secreto equivocado: invalid_client', async () => {
    const { refresh_token = '' } = await conectar(e.url, 'elena.torres@gmail.example');
    await fetch(`${e.url}/admin/buzones/elena.torres@gmail.example/revocar-tokens`, {
      method: 'POST',
    });
    const revocado = await token({
      client_id: CLIENTE,
      client_secret: SECRETO,
      refresh_token,
      grant_type: 'refresh_token',
    });
    expect(revocado.status).toBe(400);
    expect(await revocado.json()).toMatchObject({ error: 'invalid_grant' });
    const otroSecreto = await token({
      client_id: CLIENTE,
      client_secret: 'otro',
      refresh_token,
      grant_type: 'refresh_token',
    });
    expect(otroSecreto.status).toBe(401);
    expect(await otroSecreto.json()).toMatchObject({ error: 'invalid_client' });
  });
});

describe('1.5 uso del token', () => {
  const error401 = {
    error: {
      errors: [
        {
          domain: 'global',
          reason: 'authError',
          message: 'Invalid Credentials',
          locationType: 'header',
          location: 'Authorization',
        },
      ],
      code: 401,
      message: 'Invalid Credentials',
    },
  };

  it('sin token o con uno inventado: 401 con el formato de Gmail', async () => {
    expect(await gmail(e.url, 'ya29.inventado', '/profile')).toEqual({
      status: 401,
      cuerpo: error401,
    });
  });

  it('un token vencido: 401', async () => {
    const { access_token } = await conectar(e.url, 'facundo.ruiz@gmail.example');
    expect((await gmail(e.url, access_token, '/profile')).status).toBe(200);
    e.reloj.ahora += 3600 * 1000;
    expect(await gmail(e.url, access_token, '/profile')).toEqual({ status: 401, cuerpo: error401 });
  });

  it('un token vencido desde /admin (para probar la renovación): 401', async () => {
    const { access_token } = await conectar(e.url, 'gabriela.sosa@gmail.example');
    await fetch(`${e.url}/admin/buzones/gabriela.sosa@gmail.example/vencer-tokens`, {
      method: 'POST',
    });
    expect((await gmail(e.url, access_token, '/profile')).status).toBe(401);
  });

  it('un token con otro scope: 401', async () => {
    const respuesta = await conectar(e.url, 'hernan.lopez@gmail.example', {
      scope: 'https://www.googleapis.com/auth/gmail.send',
    });
    expect(respuesta.scope).not.toContain('gmail.readonly');
    expect(await gmail(e.url, respuesta.access_token, '/profile')).toEqual({
      status: 401,
      cuerpo: error401,
    });
  });

  it('otro userId que no es "me" ni el dueño: 403', async () => {
    const { access_token } = await conectar(e.url, 'ines.romero@gmail.example');
    const respuesta = await fetch(`${e.url}/gmail/v1/users/ana.garcia@gmail.example/profile`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(respuesta.status).toBe(403);
  });
});
