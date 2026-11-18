// OAuth 2.0 contra specs/externos/outlook.md, sección 1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLIENTE,
  conectar,
  decidir,
  graph,
  levantar,
  REDIRECT,
  SCOPES,
  SECRETO,
  token,
  type Entorno,
} from './ayuda.ts';

let e: Entorno;
beforeAll(async () => {
  e = await levantar();
});
afterAll(() => e.cerrar());

const LECTURA = 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read';

describe('1.1 pedido de permiso', () => {
  const pedido = new URLSearchParams({
    client_id: CLIENTE,
    response_type: 'code',
    redirect_uri: REDIRECT,
    response_mode: 'query',
    scope: SCOPES,
    state: 'abc',
  });

  it('muestra "Permitir" con cualquier tenant', async () => {
    for (const tenant of ['common', 'consumers']) {
      const respuesta = await fetch(
        `${e.url}/${tenant}/oauth2/v2.0/authorize?${pedido.toString()}`,
      );
      const html = await respuesta.text();
      expect(respuesta.status).toBe(200);
      expect(html).toContain('Permitir');
      expect(html).toContain('Leer tu correo (solo lectura)');
    }
  });

  it('un redirect_uri no registrado no vuelve: 400', async () => {
    const otro = new URLSearchParams(pedido);
    otro.set('redirect_uri', 'https://malicioso.example/callback');
    const respuesta = await fetch(`${e.url}/common/oauth2/v2.0/authorize?${otro.toString()}`, {
      redirect: 'manual',
    });
    expect(respuesta.status).toBe(400);
  });

  it('un scope inválido vuelve con error=invalid_scope', async () => {
    const otro = new URLSearchParams(pedido);
    otro.set('scope', 'https://foo.microsoft.com/mail.read');
    const respuesta = await fetch(`${e.url}/common/oauth2/v2.0/authorize?${otro.toString()}`, {
      redirect: 'manual',
    });
    const vuelta = new URL(respuesta.headers.get('location') ?? '');
    expect(vuelta.searchParams.get('error')).toBe('invalid_scope');
    expect(vuelta.searchParams.get('state')).toBe('abc');
  });

  it('"Permitir" vuelve con code y el mismo state', async () => {
    const vuelta = await decidir(e.url, 'ana.garcia@outlook.example');
    expect(`${vuelta.origin}${vuelta.pathname}`).toBe(REDIRECT);
    expect(vuelta.searchParams.get('code')).toMatch(/^OAAABAAAA/);
    expect(vuelta.searchParams.get('state')).toBe('state-firmado');
  });

  it('"Cancelar" vuelve con access_denied, la descripción y el state', async () => {
    const vuelta = await decidir(e.url, 'ana.garcia@outlook.example', 'cancelar');
    expect(vuelta.searchParams.get('error')).toBe('access_denied');
    expect(vuelta.searchParams.get('error_description')).toBe(
      'the user canceled the authentication',
    );
    expect(vuelta.searchParams.get('state')).toBe('state-firmado');
  });
});

describe('1.2 y 1.3 canje y renovación', () => {
  it('el canje devuelve los campos del ejemplo, sin offline_access en scope', async () => {
    const respuesta = await conectar(e.url, 'ana.garcia@outlook.example');
    expect(Object.keys(respuesta)).toEqual([
      'access_token',
      'token_type',
      'expires_in',
      'scope',
      'refresh_token',
    ]);
    expect(respuesta).toMatchObject({ token_type: 'Bearer', expires_in: 3599, scope: LECTURA });
  });

  it('acepta los scopes cortos (Mail.Read) y devuelve la URL completa', async () => {
    const respuesta = await conectar(
      e.url,
      'bruno.diaz@outlook.example',
      'offline_access Mail.Read User.Read',
    );
    expect(respuesta.scope).toBe(LECTURA);
  });

  it('sin offline_access no hay refresh_token', async () => {
    const respuesta = await conectar(e.url, 'bruno.diaz@outlook.example', 'Mail.Read User.Read');
    expect(respuesta.refresh_token).toBeUndefined();
  });

  it('la renovación trae un refresh token nuevo y el anterior deja de servir', async () => {
    const { refresh_token = '' } = await conectar(e.url, 'carla.mendez@outlook.example');
    const renovar = (refresh: string) =>
      token(e.url, {
        client_id: CLIENTE,
        scope: SCOPES,
        refresh_token: refresh,
        grant_type: 'refresh_token',
        client_secret: SECRETO,
      });
    const primera = await renovar(refresh_token);
    const cuerpo = (await primera.json()) as Record<string, string>;
    expect(primera.status).toBe(200);
    expect(cuerpo.refresh_token).toBeDefined();
    expect(cuerpo.refresh_token).not.toBe(refresh_token);
    expect(cuerpo.scope).toBe(LECTURA);
    const yaUsado = await renovar(refresh_token);
    expect(yaUsado.status).toBe(400);
    expect(await yaUsado.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await renovar(cuerpo.refresh_token ?? '')).status).toBe(200);
  });
});

describe('1.4 errores de /token', () => {
  const formato = {
    error: expect.any(String) as string,
    error_description: expect.stringMatching(/^AADSTS\d+: /) as string,
    error_codes: [expect.any(Number)] as number[],
    timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/) as string,
    trace_id: expect.any(String) as string,
    correlation_id: expect.any(String) as string,
  };

  const canje = (code: string, extra: Record<string, string> = {}) =>
    token(e.url, {
      client_id: CLIENTE,
      scope: SCOPES,
      code,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
      client_secret: SECRETO,
      ...extra,
    });

  it('scope inválido: 400 invalid_scope con el formato del ejemplo', async () => {
    const code =
      (await decidir(e.url, 'diego.fernandez@outlook.example')).searchParams.get('code') ?? '';
    const respuesta = await canje(code, { scope: 'https://foo.microsoft.com/mail.read' });
    const cuerpo = await respuesta.json();
    expect(respuesta.status).toBe(400);
    expect(cuerpo).toEqual({ ...formato, error: 'invalid_scope', error_codes: [70011] });
  });

  it('código ya usado: invalid_grant', async () => {
    const code =
      (await decidir(e.url, 'diego.fernandez@outlook.example')).searchParams.get('code') ?? '';
    expect((await canje(code)).status).toBe(200);
    const respuesta = await canje(code);
    expect(respuesta.status).toBe(400);
    expect(await respuesta.json()).toEqual({ ...formato, error: 'invalid_grant' });
  });

  it('código vencido (más de 1 minuto): invalid_grant', async () => {
    const code =
      (await decidir(e.url, 'diego.fernandez@outlook.example')).searchParams.get('code') ?? '';
    e.reloj.ahora += 61_000;
    expect(await (await canje(code)).json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refresh token revocado: invalid_grant; secreto equivocado: 401 invalid_client', async () => {
    const { refresh_token = '' } = await conectar(e.url, 'elena.torres@outlook.example');
    await fetch(`${e.url}/admin/buzones/elena.torres@outlook.example/revocar-tokens`, {
      method: 'POST',
    });
    const datos = {
      client_id: CLIENTE,
      refresh_token,
      grant_type: 'refresh_token',
      client_secret: SECRETO,
    };
    expect(await (await token(e.url, datos)).json()).toMatchObject({ error: 'invalid_grant' });
    const otro = await token(e.url, { ...datos, client_secret: 'otro' });
    expect(otro.status).toBe(401);
    expect(await otro.json()).toMatchObject({ error: 'invalid_client' });
  });
});

describe('1.5 uso del token', () => {
  it('token vencido: 401 InvalidAuthenticationToken con innerError', async () => {
    const { access_token } = await conectar(e.url, 'facundo.ruiz@outlook.example');
    expect((await graph(e.url, access_token, '/me')).status).toBe(200);
    e.reloj.ahora += 3600 * 1000;
    const { status, cuerpo } = await graph(e.url, access_token, '/me');
    expect(status).toBe(401);
    expect(cuerpo).toEqual({
      error: {
        code: 'InvalidAuthenticationToken',
        message: 'Access token has expired or is not yet valid.',
        innerError: {
          date: new Date(e.reloj.ahora).toISOString().slice(0, 19),
          'request-id': expect.any(String) as string,
        },
      },
    });
  });

  it('token vencido desde /admin, inventado o ausente: 401', async () => {
    const { access_token } = await conectar(e.url, 'gabriela.sosa@outlook.example');
    await fetch(`${e.url}/admin/buzones/gabriela.sosa@outlook.example/vencer-tokens`, {
      method: 'POST',
    });
    expect((await graph(e.url, access_token, '/me')).status).toBe(401);
    expect((await graph(e.url, 'inventado', '/me')).status).toBe(401);
    expect((await fetch(`${e.url}/v1.0/me`)).status).toBe(401);
  });

  it('un token sin Mail.Read no lee correos (403)', async () => {
    const { access_token, scope } = await conectar(
      e.url,
      'hernan.lopez@outlook.example',
      'User.Read',
    );
    expect(scope).not.toContain('Mail.Read');
    const { status, cuerpo } = await graph(e.url, access_token, '/me/messages');
    expect(status).toBe(403);
    expect(cuerpo).toMatchObject({ error: { code: 'ErrorAccessDenied' } });
  });
});
