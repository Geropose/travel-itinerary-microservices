import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  firmarJwt,
  firmarTokenServicio,
  generarClaves,
  loggerDePrueba,
  USUARIO_PRUEBA,
  type ClavesPrueba,
} from '../src/pruebas/index.ts';
import type { AccesoRechazado } from '../src/registro-accesos.ts';
import { crearServidor, type Servidor } from '../src/servidor.ts';
import { cargarSpec } from '../src/spec.ts';
import {
  autenticacion,
  crearValidador,
  ErrorTokenInvalido,
  type Validador,
} from '../src/validador.ts';

const rutaSpec = fileURLToPath(new URL('./fixtures/prueba.yaml', import.meta.url));
const VIAJE = '9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e';
const DESIGNADO = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const OTRO = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';

let claves: ClavesPrueba;
let clavesRegion2: ClavesPrueba;
let validador: Validador;
let servidor: Servidor;
let url: string;
let jwksServidor: Server;
let usuariosServidor: Server;
let descargasJwks = 0;
let demoraUsuarios = 0;
let rechazos: AccesoRechazado[] = [];
const { logger } = loggerDePrueba();

async function escuchar(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  claves = await generarClaves('r1');
  clavesRegion2 = await generarClaves('r2');
  // JWKS de Autenticación servido por HTTP, para contar cuántas veces se descarga.
  jwksServidor = createServer((_req, res) => {
    descargasJwks++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(claves.jwks));
  });
  const urlJwks = await escuchar(jwksServidor);
  // Servicio de Usuarios falso: GET /interna/permisos/itinerarios/{viajeId}?usuarioId=
  usuariosServidor = createServer((req, res) => {
    const consulta = new URL(req.url ?? '/', 'http://x');
    const usuarioId = consulta.searchParams.get('usuarioId');
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          viajeId: VIAJE,
          usuarioId,
          puedeVer: usuarioId === DESIGNADO,
          motivo: 'designado',
        }),
      );
    }, demoraUsuarios);
  });
  const urlUsuarios = await escuchar(usuariosServidor);

  validador = crearValidador({
    servicio: 'viajes',
    region: 'region-1',
    logger,
    claves: {
      'region-1': { url: `${urlJwks}/.well-known/jwks.json` },
      'region-2': { claves: clavesRegion2.jwks },
    },
    registrar: (r) => rechazos.push(r),
    reglas: {
      'POST /interna/tarea': { servicios: ['correo', 'pruebas'] },
      'GET /interna/cuentas/existe': {
        servicios: ['autenticacion'],
        regiones: ['region-1', 'region-2'],
      },
      'GET /analitica': { roles: ['analista'] },
    },
  });
  servidor = crearServidor({
    servicio: 'viajes',
    rutaSpec,
    region: 'region-1',
    puerto: 0,
    logger,
    validador,
    manejarSenales: false,
  });
  const ok = (texto: string) => ({ texto });
  servidor.app.get('/privada', (req, res) => {
    res.json(ok(autenticacion(req).sub));
  });
  servidor.app.post('/interna/tarea', (req, res) => {
    res.json(ok(autenticacion(req).sub));
  });
  servidor.app.get('/interna/cuentas/existe', (req, res) => {
    res.json(ok(autenticacion(req).region));
  });
  servidor.app.get('/analitica', (_req, res) => {
    res.json(ok('analitica'));
  });
  const dueno = () => USUARIO_PRUEBA;
  servidor.app.get(
    '/viajes/:viajeId',
    validador.duenoODesignado({
      obtenerDueno: dueno,
      viajeId: (req) => String(req.params.viajeId),
      urlUsuarios,
    }),
    (_req, res) => {
      res.json(ok('viaje'));
    },
  );
  servidor.app.delete('/viajes/:viajeId', validador.soloDueno(dueno), (_req, res) => {
    res.json(ok('borrado'));
  });
  url = `http://127.0.0.1:${await servidor.iniciar()}`;
});

afterAll(async () => {
  await servidor.detener();
  jwksServidor.closeAllConnections();
  jwksServidor.close();
  usuariosServidor.closeAllConnections();
  usuariosServidor.close();
});

beforeEach(() => {
  rechazos = [];
  demoraUsuarios = 0;
});

function pedir(ruta: string, token?: string, metodo = 'GET') {
  return fetch(`${url}${ruta}`, {
    method: metodo,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

/** El registro es asíncrono: espera a que llegue el rechazo. */
async function ultimoRechazo(): Promise<AccesoRechazado | undefined> {
  for (let i = 0; i < 20 && rechazos.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  return rechazos.at(-1);
}

describe('verificarToken', () => {
  it('acepta un JWT válido de la región', async () => {
    const auth = await validador.verificarToken(await firmarJwt(claves));
    expect(auth).toMatchObject({
      sub: USUARIO_PRUEBA,
      region: 'region-1',
      roles: ['usuario'],
      esServicio: false,
    });
  });

  it('JWT vencido: token-invalido', async () => {
    const token = await firmarJwt(claves, { venceEnSegundos: -10 });
    await expect(validador.verificarToken(token)).rejects.toMatchObject({
      motivo: 'token-invalido',
    });
  });

  it('firma inválida: token-invalido', async () => {
    const intruso = await generarClaves('r1');
    const token = await firmarJwt(intruso);
    await expect(validador.verificarToken(token)).rejects.toBeInstanceOf(ErrorTokenInvalido);
    const [cabecera, cuerpo] = (await firmarJwt(claves)).split('.');
    const alterado = `${cabecera}.${cuerpo}.${'A'.repeat(342)}`;
    await expect(validador.verificarToken(alterado)).rejects.toMatchObject({
      motivo: 'token-invalido',
    });
  });

  it('región equivocada: otra-region', async () => {
    const deRegion2 = await firmarJwt(clavesRegion2, { region: 'region-2' });
    await expect(validador.verificarToken(deRegion2)).rejects.toMatchObject({
      motivo: 'otra-region',
    });
    const mismaClaveOtraRegion = await firmarJwt(claves, { region: 'region-2' });
    await expect(validador.verificarToken(mismaClaveOtraRegion)).rejects.toMatchObject({
      motivo: 'otra-region',
    });
  });

  it('un token sin roles o con una región que no existe es inválido', async () => {
    await expect(
      validador.verificarToken(await firmarJwt(claves, { region: 'region-9' })),
    ).rejects.toMatchObject({
      motivo: 'token-invalido',
    });
    await expect(validador.verificarToken('no.es.jwt')).rejects.toMatchObject({
      motivo: 'token-invalido',
    });
  });

  it('validar un JWT tarda menos de 5 ms (sin usar la red)', async () => {
    const token = await firmarJwt(claves);
    const descargasAntes = descargasJwks;
    for (let i = 0; i < 20; i++) await validador.verificarToken(token);
    const veces = 200;
    const inicio = performance.now();
    for (let i = 0; i < veces; i++) await validador.verificarToken(token);
    const promedio = (performance.now() - inicio) / veces;
    expect(promedio).toBeLessThan(5);
    expect(descargasJwks).toBe(descargasAntes);
  });

  it('el JWKS se descargó una sola vez al arrancar', () => {
    expect(descargasJwks).toBe(1);
  });
});

describe('middleware del Validador de Intercepción', () => {
  it('las rutas públicas pasan sin token', async () => {
    expect((await pedir('/health')).status).toBe(200);
  });

  it('sin token: 401 y registra sin-token', async () => {
    const respuesta = await pedir('/privada');
    expect(respuesta.status).toBe(401);
    expect(respuesta.headers.get('content-type')).toContain('application/problem+json');
    expect(await ultimoRechazo()).toMatchObject({
      servicio: 'viajes',
      metodo: 'GET',
      ruta: '/privada',
      status: 401,
      motivo: 'sin-token',
    });
  });

  it('JWT vencido: 401 y registra token-invalido', async () => {
    const respuesta = await pedir('/privada', await firmarJwt(claves, { venceEnSegundos: -1 }));
    expect(respuesta.status).toBe(401);
    expect(await ultimoRechazo()).toMatchObject({ status: 401, motivo: 'token-invalido' });
    expect(rechazos.at(-1)).not.toHaveProperty('usuarioId');
  });

  it('token de otra región: 403 otra-region', async () => {
    const respuesta = await pedir(
      '/privada',
      await firmarJwt(clavesRegion2, { region: 'region-2' }),
    );
    expect(respuesta.status).toBe(403);
    expect(await ultimoRechazo()).toMatchObject({ status: 403, motivo: 'otra-region' });
  });

  it('usuario válido: pasa y la ruta ve quién es', async () => {
    const respuesta = await pedir('/privada', await firmarJwt(claves));
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toEqual({ texto: USUARIO_PRUEBA });
    expect(rechazos).toEqual([]);
  });

  it('el rol de la ruta: el analista solo entra a la suya y el usuario no entra a la del analista', async () => {
    const analista = await firmarJwt(claves, { sub: OTRO, roles: ['analista'] });
    expect((await pedir('/privada', analista)).status).toBe(403);
    expect(await ultimoRechazo()).toMatchObject({ motivo: 'sin-permiso', usuarioId: OTRO });
    expect((await pedir('/analitica', analista)).status).toBe(200);
    expect((await pedir('/analitica', await firmarJwt(claves))).status).toBe(403);
  });

  it('token de servicio: solo en las rutas internas que lo piden y para los servicios permitidos', async () => {
    const correo = await firmarTokenServicio(claves, 'correo');
    const tarea = await pedir('/interna/tarea', correo, 'POST');
    expect(tarea.status).toBe(200);
    expect(await tarea.json()).toEqual({ texto: 'correo' });
    expect(
      (await pedir('/interna/tarea', await firmarTokenServicio(claves, 'asistente'), 'POST'))
        .status,
    ).toBe(403);
    expect((await pedir('/privada', correo)).status).toBe(403);
    expect(await ultimoRechazo()).toMatchObject({ motivo: 'sin-permiso' });
    expect(rechazos.at(-1)).not.toHaveProperty('usuarioId');
    expect((await pedir('/interna/tarea', await firmarJwt(claves), 'POST')).status).toBe(403);
  });

  it('una ruta que acepta la otra región valida con las claves de esa región', async () => {
    const deRegion2 = await firmarTokenServicio(clavesRegion2, 'autenticacion', 'region-2');
    const respuesta = await pedir('/interna/cuentas/existe', deRegion2);
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toEqual({ texto: 'region-2' });
  });

  it('solo el dueño: el dueño pasa y otro usuario recibe 403', async () => {
    expect((await pedir(`/viajes/${VIAJE}`, await firmarJwt(claves), 'DELETE')).status).toBe(200);
    expect(
      (await pedir(`/viajes/${VIAJE}`, await firmarJwt(claves, { sub: DESIGNADO }), 'DELETE'))
        .status,
    ).toBe(403);
    expect(await ultimoRechazo()).toMatchObject({
      motivo: 'sin-permiso',
      usuarioId: DESIGNADO,
      ruta: `/viajes/${VIAJE}`,
    });
  });

  it('dueño o designado: pasan el dueño y el designado; otro usuario recibe 403', async () => {
    expect((await pedir(`/viajes/${VIAJE}`, await firmarJwt(claves))).status).toBe(200);
    expect(
      (await pedir(`/viajes/${VIAJE}`, await firmarJwt(claves, { sub: DESIGNADO }))).status,
    ).toBe(200);
    expect((await pedir(`/viajes/${VIAJE}`, await firmarJwt(claves, { sub: OTRO }))).status).toBe(
      403,
    );
    expect(await ultimoRechazo()).toMatchObject({ motivo: 'sin-permiso', usuarioId: OTRO });
  });

  it('dueño o designado: si Usuarios no contesta en 2 s responde 503 sin mostrar el itinerario', async () => {
    demoraUsuarios = 2500;
    const inicio = performance.now();
    const respuesta = await pedir(`/viajes/${VIAJE}`, await firmarJwt(claves, { sub: DESIGNADO }));
    expect(respuesta.status).toBe(503);
    expect(performance.now() - inicio).toBeLessThan(2400);
  });
});

describe('claves de la otra región', () => {
  it('si la otra región no responde, arranca igual con las propias y rechaza sus tokens', async () => {
    const propias = await generarClaves();
    const deOtra = await generarClaves('otra');
    const { logger } = loggerDePrueba();
    const validador = crearValidador({
      servicio: 'prueba',
      region: 'region-1',
      logger,
      claves: {
        'region-1': { claves: propias.jwks },
        // Un puerto donde no escucha nadie: la descarga falla siempre.
        'region-2': { url: 'http://127.0.0.1:1/.well-known/jwks.json' },
      },
      registrar: () => undefined,
    });
    await validador.iniciar();
    await expect(validador.verificarToken(await firmarJwt(propias))).resolves.toMatchObject({
      region: 'region-1',
    });
    await expect(
      validador.verificarToken(await firmarJwt(deOtra, { region: 'region-2' }), [
        'region-1',
        'region-2',
      ]),
    ).rejects.toBeInstanceOf(ErrorTokenInvalido);
    validador.detener();
  });
});

describe('middleware con el contrato de otro servicio (gateway)', () => {
  it('usa las reglas y los roles de los ajustes, y registra la ruta completa', async () => {
    const propias = await generarClaves();
    const registrados: AccesoRechazado[] = [];
    const v = crearValidador({
      servicio: 'gateway',
      region: 'region-1',
      logger,
      claves: { 'region-1': { claves: propias.jwks } },
      registrar: (r) => registrados.push(r),
    });
    await v.iniciar();
    const app = express();
    app.use(
      '/api/prueba',
      v.middleware(cargarSpec(rutaSpec), { rolesPorDefecto: ['analista'] }),
      (_req, res) => {
        res.json({ paso: true });
      },
    );
    const s = createServer(app);
    const base = await escuchar(s);
    const pedir = async (roles: string[]) =>
      (
        await fetch(`${base}/api/prueba/privada`, {
          headers: { authorization: `Bearer ${await firmarJwt(propias, { roles })}` },
        })
      ).status;
    expect(await pedir(['analista'])).toBe(200);
    expect(await pedir(['usuario'])).toBe(403);
    expect(registrados.at(-1)).toMatchObject({
      servicio: 'gateway',
      ruta: '/api/prueba/privada',
      status: 403,
      motivo: 'sin-permiso',
    });
    s.close();
    v.detener();
  });

  it('una regla de los ajustes que no está en ese contrato no arranca', () => {
    expect(() =>
      validador.middleware(cargarSpec(rutaSpec), { reglas: { 'GET /no-existe': {} } }),
    ).toThrow(/no corresponde/);
  });
});
