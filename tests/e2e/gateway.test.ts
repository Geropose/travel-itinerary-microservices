// API Gateway con las dos regiones levantadas (P1.5, ADR-005): se le habla al nginx de cada
// región, como lo hará el enrutador global (P1.7). Prueba el camino completo: nginx → gateway
// (Validador de Intercepción) → servicio (que vuelve a validar) y el registro de accesos.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cargarSpec } from '@trotamundos/comun';
import { describe, expect, it } from 'vitest';
import { leerEnv } from '../../infra/scripts/entorno.ts';

const env = leerEnv(readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8'));
const r1 = `http://localhost:${env.PUERTO_NGINX_REGION_1}`;
const r2 = `http://localhost:${env.PUERTO_NGINX_REGION_2}`;

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

const arriba = (proyecto: string) =>
  docker('ps', '-q', '--filter', `name=^${proyecto}-gateway-1$`) !== '';

async function login(base: string): Promise<string> {
  const respuesta = await fetch(`${base}/api/autenticacion/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'analista@trotamundos.example',
      contrasena: env.CONTRASENA_ANALISTA,
    }),
  });
  expect(respuesta.status).toBe(200);
  return ((await respuesta.json()) as { jwt: string }).jwt;
}

/** Fila del registro de accesos de r1 con ese requestId, esperando hasta 1 s (QA-9). */
async function registrado(requestId: string): Promise<string> {
  const limite = Date.now() + 1000;
  for (;;) {
    const fila = docker(
      'exec',
      'r1-postgres-1',
      'psql',
      '-U',
      'admin',
      '-d',
      'registro_accesos',
      '-tAc',
      `SELECT servicio || ' ' || status || ' ' || motivo FROM accesos_rechazados
       WHERE request_id = '${requestId}'`,
    );
    if (fila || Date.now() > limite) return fila;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!arriba('r1') || !arriba('r2'))('API Gateway con dos regiones', () => {
  it('ruta pública sin token: 200 (JWKS y login)', async () => {
    const jwks = await fetch(`${r1}/api/autenticacion/.well-known/jwks.json`);
    expect(jwks.status).toBe(200);
    expect(jwks.headers.get('x-request-id')).toBeTruthy();
    await login(r1);
  });

  it('ruta protegida sin token: 401 y queda en el registro de accesos en menos de 1 s', async () => {
    const respuesta = await fetch(`${r1}/api/usuarios/perfil`);
    expect(respuesta.status).toBe(401);
    expect(respuesta.headers.get('content-type')).toContain('application/problem+json');
    expect(await registrado(respuesta.headers.get('x-request-id') ?? '')).toBe(
      'gateway 401 sin-token',
    );
  });

  it('JWT de la otra región: 403', async () => {
    const deR2 = await login(r2);
    const respuesta = await fetch(`${r1}/api/usuarios/perfil`, {
      headers: { authorization: `Bearer ${deR2}` },
    });
    expect(respuesta.status).toBe(403);
    expect(await registrado(respuesta.headers.get('x-request-id') ?? '')).toBe(
      'gateway 403 otra-region',
    );
  });

  it('ruta interna desde afuera: 404 y queda registrada', async () => {
    const respuesta = await fetch(
      `${r1}/api/autenticacion/interna/cuentas/existe?email=analista%40trotamundos.example`,
    );
    expect(respuesta.status).toBe(404);
    expect(await registrado(respuesta.headers.get('x-request-id') ?? '')).toBe(
      'gateway 404 ruta-interna',
    );
  });

  it('el JWT llega al servicio, que lo vuelve a validar: el analista cierra su sesión', async () => {
    const respuesta = await fetch(`${r1}/api/autenticacion/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'analista@trotamundos.example',
        contrasena: env.CONTRASENA_ANALISTA,
      }),
    });
    const { jwt, tokenRenovacion } = (await respuesta.json()) as {
      jwt: string;
      tokenRenovacion: string;
    };
    const logout = await fetch(`${r1}/api/autenticacion/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tokenRenovacion }),
    });
    expect(logout.status).toBe(204);
  });

  it('sin pasar por el gateway, cada servicio también rechaza sin token: 401', () => {
    // Desde adentro de la región (el gateway), directo a una ruta protegida de cada servicio.
    const servicios = {
      autenticacion: 3001,
      usuarios: 3002,
      correo: 3003,
      viajes: 3004,
      integraciones: 3005,
      analitica: 3006,
      asistente: 3007,
    };
    for (const [servicio, puerto] of Object.entries(servicios)) {
      const spec = cargarSpec(
        fileURLToPath(new URL(`../../specs/openapi/${servicio}.yaml`, import.meta.url)),
      );
      const op = spec.operaciones.find(
        (o) => o.seguridad.includes('bearerJWT') && !o.ruta.includes('{'),
      );
      if (!op) throw new Error(`${servicio} no tiene rutas protegidas`);
      const codigo = `fetch(process.argv[1], { method: process.argv[2] })
        .then((r) => console.log(r.status))`;
      const status = docker(
        'exec',
        'r1-gateway-1',
        'node',
        '-e',
        codigo,
        `http://${servicio}:${puerto}${op.ruta}`,
        op.metodo,
      );
      expect(`${servicio} ${op.metodo} ${op.ruta} → ${status}`).toBe(
        `${servicio} ${op.metodo} ${op.ruta} → 401`,
      );
    }
  });
});
