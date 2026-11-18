import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conContexto } from '../src/contexto.ts';
import { crearClienteHttp, ErrorRespuestaHttp, ErrorTiempoAgotado } from '../src/http.ts';

let servidor: Server;
let url: string;
let ultimos: IncomingHttpHeaders = {};

beforeAll(async () => {
  servidor = createServer((req, res) => {
    ultimos = req.headers;
    if (req.url?.startsWith('/lento')) {
      setTimeout(() => res.end('{}'), 300);
      return;
    }
    if (req.url?.startsWith('/no-existe')) {
      res.writeHead(404, { 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ status: 404, title: 'No encontrado' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: req.url }));
  });
  await new Promise<void>((r) => servidor.listen(0, r));
  url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

afterAll(() => {
  servidor.closeAllConnections();
  servidor.close();
});

describe('cliente http', () => {
  it('propaga el X-Request-Id y el JWT de la solicitud en curso', async () => {
    const cliente = crearClienteHttp({ urlBase: url });
    const respuesta = await conContexto(
      { requestId: '7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c', token: 'jwt-del-usuario' },
      () => cliente.get<{ url: string }>('/eco', { query: { usuarioId: 'u1', nada: undefined } }),
    );
    expect(respuesta.datos.url).toBe('/eco?usuarioId=u1');
    expect(ultimos['x-request-id']).toBe('7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c');
    expect(ultimos.authorization).toBe('Bearer jwt-del-usuario');
  });

  it('una URL base con prefijo lo conserva', async () => {
    for (const base of [`${url}/prefijo/servicio`, `${url}/prefijo/servicio/`]) {
      const cliente = crearClienteHttp({ urlBase: base });
      const respuesta = await cliente.get<{ url: string }>('/eco', { query: { a: 'b' } });
      expect(respuesta.datos.url).toBe('/prefijo/servicio/eco?a=b');
    }
  });

  it('un token explícito reemplaza al propagado y null no manda ninguno', async () => {
    const cliente = crearClienteHttp({ urlBase: url });
    await conContexto({ requestId: 'x', token: 'jwt' }, () =>
      cliente.post('/eco', { a: 1 }, { token: 'de-servicio' }),
    );
    expect(ultimos.authorization).toBe('Bearer de-servicio');
    await conContexto({ requestId: 'x', token: 'jwt' }, () => cliente.get('/eco', { token: null }));
    expect(ultimos.authorization).toBeUndefined();
  });

  it('corta al pasar el tiempo máximo con un error claro', async () => {
    const cliente = crearClienteHttp({ urlBase: url, tiempoMaximoMs: 50 });
    await expect(cliente.get('/lento')).rejects.toBeInstanceOf(ErrorTiempoAgotado);
    await expect(cliente.get('/lento')).rejects.toThrow(/no respondió en 50 ms/);
  });

  it('una respuesta de error lanza ErrorRespuestaHttp con status y cuerpo', async () => {
    const cliente = crearClienteHttp({ urlBase: url });
    const error = await cliente.get('/no-existe').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorRespuestaHttp);
    expect(error).toMatchObject({ status: 404, cuerpo: { title: 'No encontrado' } });
  });
});
