// Enrutador global con dos regiones falsas (Iteración 6, ADR-017). Cada región falsa hace de
// nginx + gateway + Autenticación: anota lo que le llega, responde 307 si la cuenta es de la otra
// región y 403 si el JWT no es suyo (como el gateway).
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Region } from '@trotamundos/comun';
import { loggerDePrueba } from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearApp, rutaParaLog } from '../src/app.ts';
import { regionDelJwt } from '../src/region.ts';

const b64 = (datos: unknown) => Buffer.from(JSON.stringify(datos)).toString('base64url');
const jwtDe = (region: Region) => `${b64({ alg: 'RS256' })}.${b64({ sub: 'u', region })}.firma`;

interface Recibida {
  metodo: string;
  url: string;
  authorization?: string;
  cuerpo: string;
  xForwardedFor?: string;
}

/** Cuentas de cada región (CONST-6: cada una solo tiene las suyas). */
const CUENTAS: Record<Region, Record<string, string>> = {
  'region-1': { 'ana@r1.example': 'clave-de-ana' },
  'region-2': { 'beto@r2.example': 'clave-de-beto' },
};

const leer = (req: IncomingMessage) =>
  new Promise<string>((resolver) => {
    const trozos: Buffer[] = [];
    req.on('data', (t: Buffer) => trozos.push(t));
    req.on('end', () => resolver(Buffer.concat(trozos).toString('utf8')));
  });

function regionFalsa(region: Region) {
  const otra: Region = region === 'region-1' ? 'region-2' : 'region-1';
  const recibidas: Recibida[] = [];
  const servidor = createServer((req, res) => {
    void leer(req).then((cuerpo) => {
      recibidas.push({
        metodo: req.method ?? '',
        url: req.url ?? '',
        cuerpo,
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        ...(req.headers['x-forwarded-for']
          ? { xForwardedFor: String(req.headers['x-forwarded-for']) }
          : {}),
      });
      const json = (status: number, datos: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(datos));
      };
      if (req.method === 'POST' && req.url === '/api/autenticacion/login') {
        const { email, contrasena } = JSON.parse(cuerpo) as { email: string; contrasena: string };
        if (CUENTAS[region][email] === contrasena) {
          json(200, { jwt: jwtDe(region), tokenRenovacion: 'renovacion', region });
        } else if (CUENTAS[otra][email]) {
          json(307, { region: otra }, { location: `http://localhost:1/api/autenticacion/login` });
        } else {
          json(401, { status: 401 });
        }
        return;
      }
      if (req.method === 'POST' && req.url === '/api/autenticacion/registro') {
        const pedida = (JSON.parse(cuerpo) as { region: Region }).region;
        if (pedida !== region) json(307, { region: pedida });
        else json(201, { usuarioId: `nuevo-en-${region}` });
        return;
      }
      // Como el gateway: un JWT de la otra región, 403.
      const delJwt = regionDelJwt(req.headers.authorization);
      if (delJwt && delJwt !== region) {
        json(403, { status: 403 });
        return;
      }
      json(200, { region, url: req.url });
    });
  });
  return { servidor, recibidas };
}

const escuchar = (s: Server) =>
  new Promise<string>((resolver) => {
    s.listen(0, '127.0.0.1', () =>
      resolver(`http://127.0.0.1:${(s.address() as AddressInfo).port}`),
    );
  });

const r1 = regionFalsa('region-1');
const r2 = regionFalsa('region-2');
const { logger, lineas } = loggerDePrueba('enrutador', 'global');
let url: string;
let enrutador: ReturnType<typeof crearApp>;

beforeAll(async () => {
  const [url1, url2] = await Promise.all([escuchar(r1.servidor), escuchar(r2.servidor)]);
  enrutador = crearApp({
    puerto: 0,
    logger,
    regiones: { 'region-1': url1, 'region-2': url2 },
    regionPorDefecto: 'region-1',
    limiteCuerpo: '1kb',
  });
  url = `http://127.0.0.1:${await enrutador.iniciar()}`;
});
afterAll(async () => {
  await enrutador.detener();
  r1.servidor.close();
  r2.servidor.close();
});
beforeEach(() => {
  r1.recibidas.length = 0;
  r2.recibidas.length = 0;
  lineas.length = 0;
});

const login = (email: string, contrasena: string, headers: Record<string, string> = {}) =>
  fetch(`${url}/api/autenticacion/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ email, contrasena }),
    redirect: 'manual',
  });

describe('enrutador global', () => {
  it('GET /health responde ok sin pasar a ninguna región', async () => {
    const respuesta = await fetch(`${url}/health`);
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toEqual({ estado: 'ok' });
    expect([...r1.recibidas, ...r2.recibidas]).toEqual([]);
  });

  it('usuario de r1 y usuario de r2: cada uno llega a su región con su JWT', async () => {
    for (const region of ['region-1', 'region-2'] as const) {
      const respuesta = await fetch(`${url}/api/viajes?desde=2026-11-01`, {
        headers: { authorization: `Bearer ${jwtDe(region)}` },
      });
      expect(respuesta.status).toBe(200);
      expect(await respuesta.json()).toEqual({ region, url: '/api/viajes?desde=2026-11-01' });
    }
    expect(r1.recibidas).toHaveLength(1);
    expect(r2.recibidas).toHaveLength(1);
  });

  it('un JWT de r2 nunca llega a r1, aunque traiga prefijo o X-Region de r1', async () => {
    const jwt = `Bearer ${jwtDe('region-2')}`;
    const pedidos = [
      fetch(`${url}/api/viajes`, { headers: { authorization: jwt } }),
      fetch(`${url}/api/viajes`, { headers: { authorization: jwt, 'x-region': 'region-1' } }),
      fetch(`${url}/region-1/api/viajes`, { headers: { authorization: jwt } }),
      fetch(`${url}/api/autenticacion/login`, {
        method: 'POST',
        headers: { authorization: jwt, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'beto@r2.example', contrasena: 'clave-de-beto' }),
      }),
    ];
    for (const respuesta of await Promise.all(pedidos)) expect(respuesta.status).toBe(200);
    expect(r1.recibidas).toEqual([]);
    expect(r2.recibidas).toHaveLength(4);
  });

  it('sin JWT usa X-Region; si no viene, la región por defecto', async () => {
    const conHeader = await login('beto@r2.example', 'clave-de-beto', { 'x-region': 'region-2' });
    expect(conHeader.status).toBe(200);
    expect(r1.recibidas).toEqual([]);
    expect(r2.recibidas).toHaveLength(1);

    const sinHeader = await fetch(`${url}/api/autenticacion/.well-known/jwks.json`);
    expect(await sinHeader.json()).toMatchObject({ region: 'region-1' });
  });

  it('el prefijo /region-N elige la región y se quita de la ruta', async () => {
    const respuesta = await fetch(`${url}/region-2/api/correo/oauth/callback?code=abc&state=x`);
    expect(await respuesta.json()).toEqual({
      region: 'region-2',
      url: '/api/correo/oauth/callback?code=abc&state=x',
    });
  });

  it('login desde un dispositivo nuevo en la región equivocada: sigue el 307 y responde 200', async () => {
    const respuesta = await login('beto@r2.example', 'clave-de-beto');
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toMatchObject({ region: 'region-2' });
    // r1 respondió 307 y el enrutador repitió la misma solicitud, con el mismo cuerpo, en r2.
    expect(r1.recibidas).toHaveLength(1);
    expect(r2.recibidas).toHaveLength(1);
    expect(r2.recibidas[0]?.cuerpo).toBe(r1.recibidas[0]?.cuerpo);
    expect(r2.recibidas[0]?.xForwardedFor).toBeTruthy();
    expect(lineas).toContainEqual(
      expect.objectContaining({
        mensaje: 'Solicitud enrutada',
        regionDestino: 'region-1',
        reenviadaA: 'region-2',
        status: 200,
      }),
    );
  });

  it('el registro con la región de la otra cuenta también sigue el 307', async () => {
    const respuesta = await fetch(`${url}/api/autenticacion/registro`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'caro@r2.example', contrasena: 'x', region: 'region-2' }),
    });
    expect(respuesta.status).toBe(201);
    expect(await respuesta.json()).toEqual({ usuarioId: 'nuevo-en-region-2' });
  });

  it('las credenciales incorrectas no se reenvían: 401 de la región', async () => {
    const respuesta = await login('nadie@r1.example', 'no');
    expect(respuesta.status).toBe(401);
    expect(r2.recibidas).toEqual([]);
  });

  it('nunca escribe en el log el cuerpo, el JWT, la query ni los emails de la ruta', async () => {
    await login('beto@r2.example', 'clave-de-beto');
    await fetch(`${url}/api/usuarios/itinerarios/v1/designados/beto%40r2.example?token=secreto`, {
      headers: { authorization: `Bearer ${jwtDe('region-2')}` },
    });
    const texto = JSON.stringify(lineas);
    for (const prohibido of ['beto', 'clave-de-beto', jwtDe('region-2'), 'secreto', 'renovacion']) {
      expect(texto).not.toContain(prohibido);
    }
    expect(lineas).toContainEqual(
      expect.objectContaining({ ruta: '/api/usuarios/itinerarios/v1/designados/:email' }),
    );
    expect(rutaParaLog('/a/b@c/d')).toBe('/a/:email/d');
  });

  it('un cuerpo de login muy grande: 413, sin mandarlo a ninguna región', async () => {
    const respuesta = await login('ana@r1.example', 'x'.repeat(2000));
    expect(respuesta.status).toBe(413);
    expect(respuesta.headers.get('content-type')).toContain('application/problem+json');
    expect(r1.recibidas).toEqual([]);
  });

  it('propaga el X-Request-Id', async () => {
    const id = '7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c';
    const respuesta = await fetch(`${url}/api/viajes`, { headers: { 'x-request-id': id } });
    expect(respuesta.headers.get('x-request-id')).toBe(id);
  });
});

describe('enrutador global con una región caída', () => {
  it('responde 503 problem+json (proxy y login)', async () => {
    const cerrado = createServer();
    const urlCerrada = await escuchar(cerrado);
    await new Promise((r) => cerrado.close(r));
    const solo = crearApp({
      puerto: 0,
      logger,
      regiones: { 'region-1': urlCerrada, 'region-2': urlCerrada },
      regionPorDefecto: 'region-1',
    });
    const base = `http://127.0.0.1:${await solo.iniciar()}`;
    try {
      const proxy = await fetch(`${base}/api/viajes`);
      expect(proxy.status).toBe(503);
      expect(await proxy.json()).toMatchObject({ status: 503 });
      const enLogin = await fetch(`${base}/api/autenticacion/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(enLogin.status).toBe(503);
      expect(enLogin.headers.get('content-type')).toContain('application/problem+json');
    } finally {
      await solo.detener();
    }
  });
});
