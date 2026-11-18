// Prueba de contrato: recorre todas las rutas de specs/openapi/integraciones.yaml y comprueba que las
// protegidas responden 401 sin token y registran el rechazo (QA-8: el 100 % de los accesos no
// autorizados se bloquea y se registra). Las públicas no piden token.
import { randomUUID } from 'node:crypto';
import { crearValidador, type AccesoRechazado } from '@trotamundos/comun';
import { generarClaves, loggerDePrueba } from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp, SERVICIO } from '../src/app.ts';

const { logger } = loggerDePrueba(SERVICIO);
const claves = await generarClaves();
const rechazos: AccesoRechazado[] = [];
const servidor = crearApp({
  region: 'region-1',
  puerto: 0,
  logger,
  manejarSenales: false,
  validador: crearValidador({
    servicio: SERVICIO,
    region: 'region-1',
    logger,
    claves: { 'region-1': { claves: claves.jwks } },
    registrar: (rechazo) => rechazos.push(rechazo),
  }),
});
const protegidas = servidor.spec.operaciones.filter((o) => o.seguridad.length > 0);
let url: string;

/** Ruta concreta: cada parámetro {x} se reemplaza por un UUID. */
const concreta = (ruta: string) => ruta.replace(/\{[^}]+\}/g, () => randomUUID());

beforeAll(async () => {
  url = `http://127.0.0.1:${await servidor.iniciar()}`;
});

afterAll(() => servidor.detener());

describe(`contrato de ${SERVICIO}: rutas sin token`, () => {
  it.each(protegidas.map((o) => [o.metodo, o.ruta] as const))(
    '%s %s responde 401 sin token',
    async (metodo, ruta) => {
      const antes = rechazos.length;
      const respuesta = await fetch(`${url}${concreta(ruta)}`, { method: metodo });
      expect(respuesta.status).toBe(401);
      expect(respuesta.headers.get('content-type')).toContain('application/problem+json');
      expect(rechazos.slice(antes)).toMatchObject([
        { servicio: SERVICIO, status: 401, motivo: 'sin-token' },
      ]);
    },
  );

  it('GET /health es pública y no pide token', async () => {
    const salud = servidor.spec.buscar('GET', '/health');
    expect(salud?.seguridad).toEqual([]);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });
});
