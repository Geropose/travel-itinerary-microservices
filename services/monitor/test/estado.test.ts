// GET /estado contra el contrato (el servidor valida las respuestas con specs/openapi/monitor.yaml).
import { loggerDePrueba } from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.ts';
import { crearVigilante } from '../src/vigilante.ts';

const { logger } = loggerDePrueba('monitor');
const vigilante = crearVigilante({
  logger,
  ping: async (url) => url.endsWith(':3000'),
  docker: {
    listar: async () => [
      {
        id: 'a',
        nombre: 'r1-gateway-1',
        servicio: 'gateway',
        corriendo: true,
        url: 'http://x:3000',
      },
      { id: 'b', nombre: 'r1-viajes-1', servicio: 'viajes', corriendo: true, url: 'http://y:3004' },
    ],
    reiniciar: async () => undefined,
  },
});
const servidor = crearApp({
  region: 'region-1',
  puerto: 0,
  logger,
  vigilante,
  manejarSenales: false,
});
let url: string;

beforeAll(async () => {
  url = `http://127.0.0.1:${await servidor.iniciar()}`;
});
afterAll(() => servidor.detener());

describe('GET /estado del monitor', () => {
  it('antes del primer ciclo responde sin instancias', async () => {
    const respuesta = await fetch(`${url}/estado`);
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toEqual({
      region: 'region-1',
      actualizadoEn: null,
      intervaloMs: 5000,
      instancias: [],
    });
  });

  it('muestra el estado de cada instancia, y cumple el contrato', async () => {
    await vigilante.ciclo();
    const respuesta = await fetch(`${url}/estado`);
    expect(respuesta.status).toBe(200);
    const cuerpo = (await respuesta.json()) as { instancias: unknown[] };
    expect(cuerpo.instancias).toMatchObject([
      { nombre: 'r1-gateway-1', servicio: 'gateway', estado: 'sana', fallasSeguidas: 0 },
      { nombre: 'r1-viajes-1', servicio: 'viajes', estado: 'sin-respuesta', fallasSeguidas: 1 },
    ]);
  });
});
