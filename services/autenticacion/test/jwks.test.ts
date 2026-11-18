// GET /.well-known/jwks.json: publica la clave pública que sale de JWT_CLAVE_PRIVADA, y un JWT
// firmado con la privada se verifica con ella (ADR-014).
import { generateKeyPairSync } from 'node:crypto';
import { crearValidador } from '@trotamundos/comun';
import { loggerDePrueba } from '@trotamundos/comun/pruebas';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.ts';
import { leerClaves } from '../src/claves.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const claves = leerClaves(Buffer.from(privateKey).toString('base64'), 'region-1');
const { logger } = loggerDePrueba('autenticacion');
const servidor = crearApp({
  region: 'region-1',
  puerto: 0,
  logger,
  manejarSenales: false,
  jwks: claves.jwks,
});
let url: string;

beforeAll(async () => {
  url = `http://127.0.0.1:${await servidor.iniciar()}`;
});

afterAll(() => servidor.detener());

describe('claves del JWT', () => {
  it('rechaza una clave privada que no es PEM en base64', () => {
    expect(() => leerClaves('no-es-una-clave', 'region-1')).toThrow(/JWT_CLAVE_PRIVADA/);
  });

  it('el kid lleva el prefijo de la región', () => {
    expect(claves.jwks.keys[0]?.kid).toMatch(/^r1-[\w-]{12}$/);
    const otra = leerClaves(Buffer.from(privateKey).toString('base64'), 'region-2');
    expect(otra.jwks.keys[0]?.kid).toMatch(/^r2-/);
  });
});

describe('GET /.well-known/jwks.json', () => {
  it('es pública y responde las claves con Cache-Control', async () => {
    const respuesta = await fetch(`${url}/.well-known/jwks.json`);
    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get('cache-control')).toBe('public, max-age=3600');
    const cuerpo = (await respuesta.json()) as { keys: { kty: string; d?: string }[] };
    expect(cuerpo.keys).toHaveLength(1);
    expect(cuerpo.keys[0]).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'RS256' });
    // Nunca la parte privada.
    expect(cuerpo.keys[0]?.d).toBeUndefined();
  });

  it('un validador que descarga el JWKS acepta un JWT firmado con la clave privada', async () => {
    const validador = crearValidador({
      servicio: 'usuarios',
      region: 'region-1',
      logger,
      claves: { 'region-1': { url: `${url}/.well-known/jwks.json` } },
      registrar: () => undefined,
    });
    await validador.iniciar();
    const token = await new SignJWT({ region: 'region-1', roles: ['usuario'], idioma: 'es' })
      .setProtectedHeader({ alg: 'RS256', kid: claves.jwks.keys[0]?.kid ?? '' })
      .setSubject('6c1e8a2f-4b3d-4e5f-9a0b-1c2d3e4f5a6b')
      .setExpirationTime('15m')
      .sign(claves.privada);
    await expect(validador.verificarToken(token)).resolves.toMatchObject({ region: 'region-1' });
    validador.detener();
  });

  it('sin claves responde 503', async () => {
    const sinClaves = crearApp({ region: 'region-1', puerto: 0, logger, manejarSenales: false });
    const base = `http://127.0.0.1:${await sinClaves.iniciar()}`;
    expect((await fetch(`${base}/.well-known/jwks.json`)).status).toBe(503);
    await sinClaves.detener();
  });
});
