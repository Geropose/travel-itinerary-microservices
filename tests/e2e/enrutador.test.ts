// Enrutador global con las dos regiones levantadas (P1.7, Iteración 6, ADR-017). Todo entra por
// http://localhost:8000, como la web: enrutador → nginx de la región → gateway → Autenticación.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { leerEnv } from '../../infra/scripts/entorno.ts';

const env = leerEnv(readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8'));
const enrutador = `http://localhost:${env.PUERTO_ENRUTADOR ?? '8000'}`;

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

const arriba = (contenedor: string) =>
  docker('ps', '-q', '--filter', `name=^${contenedor}$`) !== '';

/** Crea una cuenta solo en una región con el script de semillas (Usuarios todavía no existe). */
function cuentaSoloEn(proyecto: string, email: string, contrasena: string): void {
  docker(
    'exec',
    '-e',
    `EMAIL_ANALISTA=${email}`,
    '-e',
    `CONTRASENA_ANALISTA=${contrasena}`,
    `${proyecto}-autenticacion-1`,
    'node',
    'services/autenticacion/src/semillas.ts',
  );
}

interface Sesion {
  jwt: string;
  tokenRenovacion: string;
  region: string;
}

async function login(email: string, contrasena: string, xRegion?: string) {
  return fetch(`${enrutador}/api/autenticacion/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(xRegion ? { 'x-region': xRegion } : {}) },
    body: JSON.stringify({ email, contrasena }),
    redirect: 'manual',
  });
}

const email = (nombre: string) => `${nombre}-${randomUUID().slice(0, 8)}@prueba.example`;
const contrasena = 'contrasena-de-prueba-enrutador';
// Una cuenta en cada región, para todas las pruebas.
const hayTodo =
  arriba('global-enrutador-1') && arriba('r1-autenticacion-1') && arriba('r2-autenticacion-1');
const deR1 = email('de-r1');
const deR2 = email('de-r2');
if (hayTodo) {
  cuentaSoloEn('r1', deR1, contrasena);
  cuentaSoloEn('r2', deR2, contrasena);
}

describe.skipIf(!hayTodo)('Enrutador global con dos regiones', () => {
  it('usuario de r1 y usuario de r2: cada uno inicia sesión en su región', async () => {
    for (const [cuenta, region] of [
      [deR1, 'region-1'],
      [deR2, 'region-2'],
    ] as const) {
      const respuesta = await login(cuenta, contrasena, region);
      expect(respuesta.status).toBe(200);
      expect(await respuesta.json()).toMatchObject({ region });
    }
  });

  it('login desde un dispositivo nuevo en la región equivocada: 200 de la región de la cuenta', async () => {
    // Sin X-Region va a la región por defecto (r1), que responde 307; el enrutador sigue a r2.
    const respuesta = await login(deR2, contrasena);
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toMatchObject({ region: 'region-2' });

    // r1 no guardó nada de esa cuenta: los datos solo pasaron (ADR-017).
    const guardado = docker(
      'exec',
      'r1-postgres-1',
      'psql',
      '-U',
      'admin',
      '-d',
      'autenticacion',
      '-tAc',
      `SELECT (SELECT count(*) FROM credenciales WHERE email = '${deR2}') +
              (SELECT count(*) FROM intentos_fallidos WHERE email = '${deR2}')`,
    );
    expect(guardado).toBe('0');
  });

  it('un JWT de r2 nunca llega a r1: con prefijo y X-Region de r1, igual lo atiende r2', async () => {
    const sesion = (await (await login(deR2, contrasena, 'region-2')).json()) as Sesion;
    const requestId = randomUUID();
    // POST /logout exige el JWT: el gateway de r1 respondería 403; el de r2, 204.
    const respuesta = await fetch(`${enrutador}/region-1/api/autenticacion/logout`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sesion.jwt}`,
        'content-type': 'application/json',
        'x-region': 'region-1',
        'x-request-id': requestId,
      },
      body: JSON.stringify({ tokenRenovacion: sesion.tokenRenovacion }),
    });
    expect(respuesta.status).toBe(204);
    // El gateway de r1 no lo vio: no hay ningún rechazo con ese requestId en su registro.
    const enR1 = docker(
      'exec',
      'r1-postgres-1',
      'psql',
      '-U',
      'admin',
      '-d',
      'registro_accesos',
      '-tAc',
      `SELECT count(*) FROM accesos_rechazados WHERE request_id = '${requestId}'`,
    );
    expect(enR1).toBe('0');
  });

  it('el JWT de r1 va a r1', async () => {
    const sesion = (await (await login(deR1, contrasena)).json()) as Sesion;
    expect(sesion.region).toBe('region-1');
    const respuesta = await fetch(`${enrutador}/api/autenticacion/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sesion.jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tokenRenovacion: sesion.tokenRenovacion }),
    });
    expect(respuesta.status).toBe(204);
  });

  it('el log del enrutador no tiene emails, contraseñas ni JWT', async () => {
    const logs = docker('logs', '--since', '5m', 'global-enrutador-1');
    expect(logs).toContain('Solicitud enrutada');
    for (const prohibido of [deR1, deR2, contrasena, 'eyJ']) {
      expect(logs).not.toContain(prohibido);
    }
  });
});
