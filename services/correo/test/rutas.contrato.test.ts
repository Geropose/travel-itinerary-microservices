// Prueba de contrato: recorre todas las rutas de specs/openapi/correo.yaml y comprueba que las
// protegidas responden 401 sin token, 403 con rol o región indebida y registran el rechazo
// (QA-8: el 100 % de los accesos no autorizados se bloquea y se registra). Las públicas no piden token.
import { randomUUID } from 'node:crypto';
import { crearValidador, type AccesoRechazado } from '@trotamundos/comun';
import { firmarJwt, generarClaves, loggerDePrueba } from '@trotamundos/comun/pruebas';
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

/** Ruta concreta: cada parámetro {x} se reemplaza por un valor válido según el contrato. */
const concreta = (ruta: string) =>
  ruta.replace('{proveedorCorreo}', 'gmail').replace(/\{[^}]+\}/g, () => randomUUID());

beforeAll(async () => {
  url = `http://127.0.0.1:${await servidor.iniciar()}`;
});

afterAll(() => servidor.detener());

describe(`contrato de ${SERVICIO}: rutas sin token y reglas de acceso`, () => {
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

  it.each(protegidas.map((o) => [o.metodo, o.ruta] as const))(
    '%s %s rechaza al rol analista con 403 y lo registra',
    async (metodo, ruta) => {
      const tokenAnalista = await firmarJwt(claves, { roles: ['analista'] });
      const antes = rechazos.length;
      const respuesta = await fetch(`${url}${concreta(ruta)}`, {
        method: metodo,
        headers: { authorization: `Bearer ${tokenAnalista}` },
      });
      expect(respuesta.status).toBe(403);
      expect(rechazos.slice(antes)).toMatchObject([
        { servicio: SERVICIO, status: 403, motivo: 'sin-permiso' },
      ]);
    },
  );

  it.each(protegidas.map((o) => [o.metodo, o.ruta] as const))(
    '%s %s rechaza un token de la otra región con 403',
    async (metodo, ruta) => {
      const tokenR2 = await firmarJwt(claves, { region: 'region-2' });
      const antes = rechazos.length;
      const respuesta = await fetch(`${url}${concreta(ruta)}`, {
        method: metodo,
        headers: { authorization: `Bearer ${tokenR2}` },
      });
      expect(respuesta.status).toBe(403);
      expect(rechazos.slice(antes)).toMatchObject([
        { servicio: SERVICIO, status: 403, motivo: 'otra-region' },
      ]);
    },
  );

  it('GET /health y rutas de avisos push / callback son públicas en el contrato', async () => {
    const salud = servidor.spec.buscar('GET', '/health');
    expect(salud?.seguridad).toEqual([]);
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect(servidor.spec.buscar('GET', '/oauth/callback')?.seguridad).toEqual([]);
    expect(servidor.spec.buscar('POST', '/notificaciones/gmail')?.seguridad).toEqual([]);
    expect(servidor.spec.buscar('POST', '/notificaciones/outlook')?.seguridad).toEqual([]);
  });
});
