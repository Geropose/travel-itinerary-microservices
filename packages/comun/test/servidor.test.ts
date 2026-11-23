import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errores } from '../src/errores.ts';
import { generarClaves, loggerDePrueba } from '../src/pruebas/index.ts';
import { crearServidor, type Servidor } from '../src/servidor.ts';
import { crearValidador } from '../src/validador.ts';

const rutaSpec = fileURLToPath(new URL('./fixtures/prueba.yaml', import.meta.url));
const REQUEST_ID = '7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c';

let servidor: Servidor;
let url: string;
let baseSana = true;
const { logger, lineas } = loggerDePrueba();

beforeAll(async () => {
  const claves = await generarClaves();
  servidor = crearServidor({
    servicio: 'prueba',
    rutaSpec,
    region: 'region-1',
    puerto: 0,
    logger,
    manejarSenales: false,
    tiempoChequeoMs: 100,
    validador: crearValidador({
      servicio: 'prueba',
      region: 'region-1',
      logger,
      claves: { 'region-1': { claves: claves.jwks } },
      registrar: () => undefined,
    }),
  });
  servidor.registrarChequeo('base', async () => {
    if (!baseSana) throw new Error('sin conexión');
  });
  // Un broker que no contesta nunca: el chequeo tiene que cortar por tiempo.
  servidor.registrarChequeo('broker', () => new Promise<void>(() => undefined));
  servidor.app.get('/publica', (_req, res) => {
    res.json({ texto: 'hola' });
  });
  servidor.app.get('/mal-respondida', (_req, res) => {
    res.json({ texto: 1 });
  });
  servidor.app.get('/falla', () => {
    throw new Error('detalle interno secreto');
  });
  servidor.app.post('/mensajes', (req, res) => {
    if ((req.body as { texto: string }).texto === 'repetido') throw errores.conflicto('Ya existe.');
    res.status(201).json(req.body);
  });
  url = `http://127.0.0.1:${await servidor.iniciar()}`;
});

afterAll(async () => {
  await servidor.detener();
});

describe('crearServidor', () => {
  it('GET /health responde 503 si un chequeo no contesta a tiempo, con problem+json', async () => {
    const respuesta = await fetch(`${url}/health`);
    expect(respuesta.status).toBe(503);
    expect(respuesta.headers.get('content-type')).toContain('application/problem+json');
    expect(await respuesta.json()).toMatchObject({ status: 503, detail: 'Falla: broker.' });
  });

  it('GET /health responde 200 {"estado":"ok"} cuando todos los chequeos pasan', async () => {
    servidor.registrarChequeo('broker', async () => undefined);
    const respuesta = await fetch(`${url}/health`);
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toEqual({ estado: 'ok' });
    baseSana = false;
    expect((await fetch(`${url}/health`)).status).toBe(503);
    baseSana = true;
  });

  it('usa el X-Request-Id que llega o crea uno, y lo loguea', async () => {
    const respuesta = await fetch(`${url}/publica`, { headers: { 'x-request-id': REQUEST_ID } });
    expect(respuesta.headers.get('x-request-id')).toBe(REQUEST_ID);
    expect(
      lineas.some((l) => l.requestId === REQUEST_ID && l.ruta === '/publica' && l.status === 200),
    ).toBe(true);
    const otra = await fetch(`${url}/publica`, { headers: { 'x-request-id': 'no-es-uuid' } });
    expect(otra.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('valida la solicitud contra el contrato: 400 problem+json con los campos', async () => {
    const respuesta = await fetch(`${url}/mensajes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ otro: 1 }),
    });
    expect(respuesta.status).toBe(400);
    const cuerpo = (await respuesta.json()) as {
      type: string;
      errores: unknown[];
      requestId: string;
    };
    expect(cuerpo.type).toBe('https://trotamundos.example/errores/solicitud-invalida');
    expect(cuerpo.errores.length).toBeGreaterThan(0);
    expect(cuerpo.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('un ErrorHttp se responde con su status y title', async () => {
    const respuesta = await fetch(`${url}/mensajes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texto: 'repetido' }),
    });
    expect(respuesta.status).toBe(409);
    expect(await respuesta.json()).toMatchObject({ title: 'Conflicto', detail: 'Ya existe.' });
  });

  it('valida la respuesta: si no cumple el contrato responde 500', async () => {
    expect((await fetch(`${url}/mal-respondida`)).status).toBe(500);
  });

  it('un error no esperado responde 500 sin filtrar detalles internos', async () => {
    const respuesta = await fetch(`${url}/falla`);
    expect(respuesta.status).toBe(500);
    const texto = await respuesta.text();
    expect(texto).not.toContain('secreto');
    expect(JSON.parse(texto)).toMatchObject({ title: 'Error interno', status: 500 });
    expect(lineas.some((l) => l.nivel === 'error' && JSON.stringify(l).includes('secreto'))).toBe(
      true,
    );
  });

  it('una ruta que no está en el contrato responde 404 problem+json', async () => {
    const respuesta = await fetch(`${url}/no-existe`);
    expect(respuesta.status).toBe(404);
    expect(respuesta.headers.get('content-type')).toContain('application/problem+json');
  });

  it('apagado ordenado: deja de aceptar solicitudes y corre las tareas de apagado', async () => {
    const otro = crearServidor({
      servicio: 'prueba',
      rutaSpec,
      region: 'region-1',
      puerto: 0,
      logger,
      manejarSenales: false,
    });
    const orden: string[] = [];
    otro.alApagar(async () => orden.push('pool'));
    otro.alApagar(async () => orden.push('broker'));
    const puerto = await otro.iniciar();
    await otro.detener();
    expect(orden).toEqual(['broker', 'pool']);
    await expect(fetch(`http://127.0.0.1:${puerto}/health`)).rejects.toThrow();
  });
});

describe('crearServidor sin validador', () => {
  it('las rutas protegidas responden 401 y las públicas atienden', async () => {
    const sinValidador = crearServidor({
      servicio: 'prueba',
      rutaSpec,
      region: 'region-1',
      puerto: 0,
      logger,
      manejarSenales: false,
    });
    sinValidador.app.get('/publica', (_req, res) => {
      res.json({ texto: 'hola' });
    });
    sinValidador.app.get('/privada', (_req, res) => {
      res.json({ texto: 'no tendría que llegar acá' });
    });
    const base = `http://127.0.0.1:${await sinValidador.iniciar()}`;
    const privada = await fetch(`${base}/privada`, { headers: { 'x-request-id': REQUEST_ID } });
    expect(privada.status).toBe(401);
    expect(privada.headers.get('content-type')).toContain('application/problem+json');
    expect(await privada.json()).toMatchObject({ requestId: REQUEST_ID });
    expect((await fetch(`${base}/PRIVADA`)).status).toBe(401);
    expect((await fetch(`${base}/publica`)).status).toBe(200);
    expect((await fetch(`${base}/no-existe`)).status).toBe(404);
    await sinValidador.detener();
  });

  it('tapa emails en los logs de solicitudes atendidas', async () => {
    const res = await fetch(
      `${url}/itinerarios/7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c/designados/ana%40correo.example`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(404);
    expect(
      lineas.some(
        (l) => l.ruta === '/itinerarios/7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c/designados/:email',
      ),
    ).toBe(true);
    expect(JSON.stringify(lineas)).not.toContain('ana@correo.example');
    expect(JSON.stringify(lineas)).not.toContain('ana%40correo.example');
  });
});
