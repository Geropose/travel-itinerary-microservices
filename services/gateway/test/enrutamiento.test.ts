// API Gateway con Validador de Intercepción (P1.5, ADR-005, specs/openapi/gateway.yaml). Los
// servicios internos son falsos: un eco que devuelve lo que recibió y un servicio armado con el
// kit común (crearServidor + validador), para probar que el servicio vuelve a validar el JWT.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  autenticacion,
  crearPool,
  crearServidor,
  crearValidador,
  migrar,
  MIGRACIONES_REGISTRO_ACCESOS,
  registroEnBase,
  type AccesoRechazado,
  type Pool,
  type Servidor,
} from '@trotamundos/comun';
import {
  dockerDisponible,
  firmarJwt,
  firmarTokenServicio,
  generarClaves,
  levantarPostgres,
  loggerDePrueba,
  USUARIO_PRUEBA,
  type ClavesPrueba,
  type ContenedorPostgres,
} from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.ts';
import { esRutaInterna, rutaSpecDe, SERVICIOS_INTERNOS } from '../src/enrutamiento.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGEN_WEB = 'http://localhost:5173';
const hayDocker = await dockerDisponible();
const { logger } = loggerDePrueba('gateway');

interface Recibida {
  metodo: string;
  url: string;
  encabezados: IncomingHttpHeaders;
  cuerpo: string;
}

let r1: ClavesPrueba;
let r2: ClavesPrueba;
let eco: Server;
const recibidas: Recibida[] = [];
let servicioKit: Servidor;
let urlKit: string;
const rechazosKit: AccesoRechazado[] = [];
let gateway: Servidor;
let url: string;
const rechazos: (AccesoRechazado & { en: number })[] = [];
let postgres: ContenedorPostgres | undefined;
let pool: Pool | undefined;

async function escuchar(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const jwtUsuario = (claims: Parameters<typeof firmarJwt>[1] = {}) => firmarJwt(r1, claims);
const conToken = (token: string, extra: Record<string, string> = {}) => ({
  headers: { authorization: `Bearer ${token}`, ...extra },
});

beforeAll(async () => {
  r1 = await generarClaves('r1');
  r2 = await generarClaves('r2');
  if (hayDocker) {
    postgres = await levantarPostgres();
    pool = crearPool({ url: postgres.url });
    await migrar(pool, [MIGRACIONES_REGISTRO_ACCESOS], logger);
  }

  // Eco: responde 200 con lo que recibió. Con x-demora tarda esos milisegundos.
  eco = createServer((req, res) => {
    const partes: Buffer[] = [];
    req.on('data', (p: Buffer) => partes.push(p));
    req.on('end', () => {
      const recibida = {
        metodo: req.method ?? '',
        url: req.url ?? '',
        encabezados: req.headers,
        cuerpo: Buffer.concat(partes).toString('utf8'),
      };
      recibidas.push(recibida);
      setTimeout(
        () => {
          if (res.destroyed) return;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(recibida));
        },
        Number(req.headers['x-demora'] ?? 0),
      );
    });
  });
  const urlEco = await escuchar(eco);

  // Servicio de Usuarios armado con el kit, con su propio Validador de Intercepción.
  servicioKit = crearServidor({
    servicio: 'usuarios',
    rutaSpec: rutaSpecDe('usuarios'),
    region: 'region-1',
    puerto: 0,
    logger,
    validarRespuestas: false,
    manejarSenales: false,
    validador: crearValidador({
      servicio: 'usuarios',
      region: 'region-1',
      logger,
      claves: { 'region-1': { claves: r1.jwks } },
      registrar: (r) => rechazosKit.push(r),
    }),
  });
  servicioKit.app.get('/perfil', (req, res) => {
    res.json({ usuarioId: autenticacion(req).sub });
  });
  urlKit = `http://127.0.0.1:${await servicioKit.iniciar()}`;

  const registrarEnBase = pool ? registroEnBase(pool, logger) : undefined;
  const registrar = (r: AccesoRechazado) => {
    rechazos.push({ ...r, en: performance.now() });
    registrarEnBase?.(r);
  };
  gateway = crearApp({
    region: 'region-1',
    puerto: 0,
    logger,
    manejarSenales: false,
    registrar,
    validador: crearValidador({
      servicio: 'gateway',
      region: 'region-1',
      logger,
      claves: { 'region-1': { claves: r1.jwks }, 'region-2': { claves: r2.jwks } },
      registrar,
    }),
    servicios: {
      autenticacion: { ...SERVICIOS_INTERNOS.autenticacion, url: urlEco },
      usuarios: { url: urlKit },
      viajes: { url: urlEco },
      analitica: { ...SERVICIOS_INTERNOS.analitica, url: urlEco },
      // Nadie escucha en el puerto 1: la conexión se rechaza.
      correo: { url: 'http://127.0.0.1:1' },
    },
    tiempoMaximoMs: 300,
    limiteCuerpo: '1kb',
    origenWeb: ORIGEN_WEB,
  });
  url = `http://127.0.0.1:${await gateway.iniciar()}`;
}, 120_000);

afterAll(async () => {
  await gateway?.detener();
  await servicioKit?.detener();
  await new Promise((r) => eco?.close(r));
  await pool?.end();
  await postgres?.detener();
}, 60_000);

describe('enrutamiento de /api/<servicio>/*', () => {
  it('ruta pública sin token: 200 y llega al servicio sin el prefijo, con el mismo cuerpo', async () => {
    const cuerpo = JSON.stringify({ email: 'ana@prueba.example', contrasena: 'secreta-123' });
    const respuesta = await fetch(`${url}/api/autenticacion/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: cuerpo,
    });
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toMatchObject({ metodo: 'POST', url: '/login', cuerpo });
  });

  it('el JWKS de Autenticación es público', async () => {
    const respuesta = await fetch(`${url}/api/autenticacion/.well-known/jwks.json`);
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toMatchObject({ url: '/.well-known/jwks.json' });
  });

  it('ruta protegida sin token: 401 problem+json, no llega al servicio y queda registrada', async () => {
    const antes = recibidas.length;
    const respuesta = await fetch(`${url}/api/viajes/panel`);
    expect(respuesta.status).toBe(401);
    expect(respuesta.headers.get('content-type')).toContain('application/problem+json');
    expect(recibidas.length).toBe(antes);
    expect(rechazos.at(-1)).toMatchObject({
      servicio: 'gateway',
      metodo: 'GET',
      ruta: '/api/viajes/panel',
      status: 401,
      motivo: 'sin-token',
      requestId: respuesta.headers.get('x-request-id'),
    });
  });

  it('token de otra región: 403 (CONST-6)', async () => {
    const token = await firmarJwt(r2, { region: 'region-2' });
    const respuesta = await fetch(`${url}/api/viajes/panel`, conToken(token));
    expect(respuesta.status).toBe(403);
    expect(rechazos.at(-1)).toMatchObject({ status: 403, motivo: 'otra-region' });
  });

  it('token vencido o con una firma desconocida: 401', async () => {
    const vencido = await jwtUsuario({ venceEnSegundos: -10 });
    expect((await fetch(`${url}/api/viajes/panel`, conToken(vencido))).status).toBe(401);
    const otraClave = await firmarJwt(await generarClaves('r1'));
    expect((await fetch(`${url}/api/viajes/panel`, conToken(otraClave))).status).toBe(401);
    expect(rechazos.at(-1)).toMatchObject({ status: 401, motivo: 'token-invalido' });
  });

  it('ruta interna desde afuera: 404 aun con token de servicio, y queda registrada', async () => {
    const antes = recibidas.length;
    const token = await firmarTokenServicio(r1, 'autenticacion');
    const respuesta = await fetch(
      `${url}/api/autenticacion/interna/cuentas/existe?email=ana%40prueba.example`,
      conToken(token),
    );
    expect(respuesta.status).toBe(404);
    expect(respuesta.headers.get('content-type')).toContain('application/problem+json');
    expect(rechazos.at(-1)).toMatchObject({
      servicio: 'gateway',
      ruta: '/api/autenticacion/interna/cuentas/existe',
      status: 404,
      motivo: 'ruta-interna',
      requestId: respuesta.headers.get('x-request-id'),
    });
    // Ni disfrazada: codificada, en mayúsculas o con "..".
    for (const ruta of ['/%69nterna/cuentas', '/INTERNA/cuentas', '/perfil/../interna/cuentas']) {
      const r = await fetch(`${url}/api/usuarios${ruta}`, { method: 'POST' });
      expect(r.status).toBe(404);
    }
    expect(recibidas.length).toBe(antes);
  });

  it('esRutaInterna reconoce las rutas internas', () => {
    expect(esRutaInterna('/interna')).toBe(true);
    expect(esRutaInterna('/interna/x')).toBe(true);
    expect(esRutaInterna('/%49nterna/x')).toBe(true);
    expect(esRutaInterna('/internacional')).toBe(false);
    expect(esRutaInterna('/viajes/interna')).toBe(false);
  });

  it('operación que no está en el contrato o prefijo desconocido: 404', async () => {
    const token = await jwtUsuario();
    expect((await fetch(`${url}/api/viajes/no-existe`, conToken(token))).status).toBe(404);
    expect((await fetch(`${url}/api/desconocido/algo`, conToken(token))).status).toBe(404);
    // Servicio de la tabla, pero que este gateway de prueba no enruta.
    expect((await fetch(`${url}/api/asistente/conversaciones`, conToken(token))).status).toBe(404);
  });

  it('crea el X-Request-Id si no viene, lo propaga y lo devuelve; Authorization va tal cual', async () => {
    const token = await jwtUsuario();
    const respuesta = await fetch(`${url}/api/viajes/panel`, conToken(token));
    expect(respuesta.status).toBe(200);
    const requestId = respuesta.headers.get('x-request-id') ?? '';
    expect(requestId).toMatch(UUID);
    const recibida = (await respuesta.json()) as Recibida;
    expect(recibida.url).toBe('/panel');
    expect(recibida.encabezados['x-request-id']).toBe(requestId);
    expect(recibida.encabezados.authorization).toBe(`Bearer ${token}`);

    const propio = crypto.randomUUID();
    const otra = await fetch(
      `${url}/api/viajes/panel`,
      conToken(token, { 'x-request-id': propio }),
    );
    expect(otra.headers.get('x-request-id')).toBe(propio);
    expect(((await otra.json()) as Recibida).encabezados['x-request-id']).toBe(propio);
  });

  it('roles: el analista solo entra a analítica (y a cerrar su sesión); el usuario no entra a analítica', async () => {
    const analista = await jwtUsuario({ roles: ['analista'] });
    const usuario = await jwtUsuario();
    expect((await fetch(`${url}/api/viajes/panel`, conToken(analista))).status).toBe(403);
    expect(
      (await fetch(`${url}/api/analitica/consultas/destinos`, conToken(analista))).status,
    ).toBe(200);
    expect((await fetch(`${url}/api/analitica/consultas/destinos`, conToken(usuario))).status).toBe(
      403,
    );
    const logout = await fetch(`${url}/api/autenticacion/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${analista}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tokenRenovacion: 'x' }),
    });
    expect(logout.status).toBe(200);
  });

  it('un token de servicio nunca pasa por el gateway: 403', async () => {
    const token = await firmarTokenServicio(r1, 'viajes');
    expect((await fetch(`${url}/api/viajes/panel`, conToken(token))).status).toBe(403);
    expect(rechazos.at(-1)).toMatchObject({ status: 403, motivo: 'sin-permiso' });
  });

  it('503 problem+json si el servicio no responde a tiempo o no está', async () => {
    const token = await jwtUsuario();
    const inicio = performance.now();
    const lenta = await fetch(`${url}/api/viajes/panel`, conToken(token, { 'x-demora': '2000' }));
    expect(lenta.status).toBe(503);
    expect(lenta.headers.get('content-type')).toContain('application/problem+json');
    expect(await lenta.json()).toMatchObject({
      status: 503,
      requestId: lenta.headers.get('x-request-id'),
    });
    expect(performance.now() - inicio).toBeLessThan(1500);

    const caida = await fetch(`${url}/api/correo/cuentas-correo`, conToken(token));
    expect(caida.status).toBe(503);
  });

  it('límite de tamaño del cuerpo: 413 problem+json', async () => {
    const respuesta = await fetch(`${url}/api/autenticacion/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ana@prueba.example', contrasena: 'x'.repeat(2048) }),
    });
    expect(respuesta.status).toBe(413);
    expect(respuesta.headers.get('content-type')).toContain('application/problem+json');
  });

  it('CORS solo para el origen de la web', async () => {
    const preflight = (origen: string) =>
      fetch(`${url}/api/viajes/panel`, {
        method: 'OPTIONS',
        headers: {
          origin: origen,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      });
    const web = await preflight(ORIGEN_WEB);
    expect(web.status).toBe(204);
    expect(web.headers.get('access-control-allow-origin')).toBe(ORIGEN_WEB);
    expect(web.headers.get('access-control-allow-headers')).toContain('Authorization');

    const otro = await preflight('https://malicioso.example');
    expect(otro.status).toBe(403);
    expect(otro.headers.get('access-control-allow-origin')).toBeNull();

    const token = await jwtUsuario();
    const simple = await fetch(`${url}/api/viajes/panel`, conToken(token, { origin: ORIGEN_WEB }));
    expect(simple.headers.get('access-control-allow-origin')).toBe(ORIGEN_WEB);
    expect(simple.headers.get('access-control-expose-headers')).toContain('X-Request-Id');
    const ajena = await fetch(`${url}/api/viajes/panel`, {
      ...conToken(token, { origin: 'https://malicioso.example' }),
    });
    expect(ajena.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('validación en el gateway y en cada servicio (ADR-005, defensa en profundidad)', () => {
  it('sin pasar por el gateway, el servicio también rechaza: 401 y lo registra', async () => {
    const respuesta = await fetch(`${urlKit}/perfil`);
    expect(respuesta.status).toBe(401);
    expect(rechazosKit.at(-1)).toMatchObject({
      servicio: 'usuarios',
      ruta: '/perfil',
      status: 401,
      motivo: 'sin-token',
    });
    const otraRegion = await firmarJwt(r2, { region: 'region-2' });
    expect((await fetch(`${urlKit}/perfil`, conToken(otraRegion))).status).not.toBe(200);
  });

  it('por el gateway, el servicio recibe el mismo JWT y lo vuelve a validar', async () => {
    const respuesta = await fetch(`${url}/api/usuarios/perfil`, conToken(await jwtUsuario()));
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toEqual({ usuarioId: USUARIO_PRUEBA });
  });
});

describe.skipIf(!hayDocker)('registro de accesos del gateway (QA-9)', () => {
  async function registrado(requestId: string): Promise<{ status: number; motivo: string }> {
    for (;;) {
      if (!pool) throw new Error('Falta la base');
      const { rows } = await pool.query<{ status: number; motivo: string }>(
        'SELECT status, motivo FROM accesos_rechazados WHERE request_id = $1',
        [requestId],
      );
      if (rows[0]) return rows[0];
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('el rechazo queda en accesos_rechazados en menos de 1 s', async () => {
    const inicio = performance.now();
    const respuesta = await fetch(`${url}/api/viajes/panel`);
    expect(respuesta.status).toBe(401);
    const fila = await registrado(respuesta.headers.get('x-request-id') ?? '');
    expect(performance.now() - inicio).toBeLessThan(1000);
    expect(fila).toEqual({ status: 401, motivo: 'sin-token' });
  });

  it('una ruta interna pedida desde afuera también queda registrada (404)', async () => {
    const inicio = performance.now();
    const respuesta = await fetch(`${url}/api/usuarios/interna/cuentas`, { method: 'POST' });
    expect(respuesta.status).toBe(404);
    const fila = await registrado(respuesta.headers.get('x-request-id') ?? '');
    expect(performance.now() - inicio).toBeLessThan(1000);
    expect(fila).toEqual({ status: 404, motivo: 'ruta-interna' });
  });
});
