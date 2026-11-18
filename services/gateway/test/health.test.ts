import { loggerDePrueba } from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.ts';

let dependenciaSana = true;
const servidor = crearApp({
  region: 'region-1',
  puerto: 0,
  logger: loggerDePrueba('gateway').logger,
  manejarSenales: false,
  chequeos: {
    dependencia: async () => {
      if (!dependenciaSana) throw new Error('caída');
    },
  },
});
let url: string;

beforeAll(async () => {
  url = `http://127.0.0.1:${await servidor.iniciar()}`;
});

afterAll(() => servidor.detener());

describe('GET /health de gateway', () => {
  it('responde 200 {"estado":"ok"} si puede atender', async () => {
    const respuesta = await fetch(`${url}/health`);
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toEqual({ estado: 'ok' });
  });

  it('responde 503 problem+json si una dependencia falla', async () => {
    dependenciaSana = false;
    const respuesta = await fetch(`${url}/health`);
    dependenciaSana = true;
    expect(respuesta.status).toBe(503);
    expect(respuesta.headers.get('content-type')).toContain('application/problem+json');
  });
});
