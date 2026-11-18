// Autenticación con las dos regiones levantadas (P1.4). Todavía no hay gateway que enrute (P1.5)
// ni enrutador global (P1.7), así que se le habla a Autenticación desde adentro de su contenedor.
// Prueba el camino entre regiones: login desde un dispositivo nuevo en la región equivocada.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { leerEnv } from '../../infra/scripts/entorno.ts';

const env = leerEnv(readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8'));

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

const arriba = (proyecto: string) =>
  docker('ps', '-q', '--filter', `name=^${proyecto}-autenticacion-1$`) !== '';

interface Respuesta {
  status: number;
  location: string | null;
  cuerpo: unknown;
}

/** POST a Autenticación de una región, desde su propio contenedor. */
function post(proyecto: string, ruta: string, cuerpo: unknown): Respuesta {
  const codigo = `
    fetch('http://127.0.0.1:3001' + process.argv[1], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: process.argv[2],
      redirect: 'manual',
    }).then(async (r) => console.log(JSON.stringify({
      status: r.status, location: r.headers.get('location'), cuerpo: await r.json(),
    })));`;
  return JSON.parse(
    docker(
      'exec',
      `${proyecto}-autenticacion-1`,
      'node',
      '-e',
      codigo,
      ruta,
      JSON.stringify(cuerpo),
    ),
  ) as Respuesta;
}

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

describe.skipIf(!arriba('r1') || !arriba('r2'))('Autenticación con dos regiones', () => {
  it('el analista de prueba de las semillas inicia sesión en cada región', () => {
    for (const [proyecto, region] of [
      ['r1', 'region-1'],
      ['r2', 'region-2'],
    ] as const) {
      const respuesta = post(proyecto, '/login', {
        email: 'analista@trotamundos.example',
        contrasena: env.CONTRASENA_ANALISTA,
      });
      expect(respuesta.status).toBe(200);
      expect(respuesta.cuerpo).toMatchObject({ region });
    }
  });

  it('login en la región equivocada: 307 hacia la región de la cuenta, que sí lo acepta', () => {
    const email = `viajera-${randomUUID().slice(0, 8)}@prueba.example`;
    const contrasena = 'contrasena-de-prueba-r2';
    cuentaSoloEn('r2', email, contrasena);

    // r1 no tiene la cuenta: le pregunta a r2 por la puerta entre regiones y responde 307.
    const enR1 = post('r1', '/login', { email, contrasena });
    expect(enR1.status).toBe(307);
    expect(enR1.cuerpo).toEqual({ region: 'region-2' });
    expect(enR1.location).toBe(
      `http://localhost:${env.PUERTO_NGINX_REGION_2}/api/autenticacion/login`,
    );

    const enR2 = post('r2', '/login', { email, contrasena });
    expect(enR2.status).toBe(200);
    expect(enR2.cuerpo).toMatchObject({ region: 'region-2' });

    // r1 no guardó nada de esa cuenta (ADR-017).
    const guardado = docker(
      'exec',
      'r1-postgres-1',
      'psql',
      '-U',
      'admin',
      '-d',
      'autenticacion',
      '-tAc',
      `SELECT (SELECT count(*) FROM credenciales WHERE email = '${email}') +
              (SELECT count(*) FROM intentos_fallidos WHERE email = '${email}')`,
    );
    expect(guardado).toBe('0');
  });

  it('un email que no está en ninguna región: 401', () => {
    const respuesta = post('r1', '/login', {
      email: `nadie-${randomUUID().slice(0, 8)}@prueba.example`,
      contrasena: 'no-importa-cual',
    });
    expect(respuesta.status).toBe(401);
  });
});
