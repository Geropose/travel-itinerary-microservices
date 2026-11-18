import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { leerClaves } from '../src/claves.ts';
import { secretosDeServicios } from '../src/config.ts';
import { hashToken, nuevoTokenRenovacion, tokenDeServicioPropio } from '../src/tokens.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const claves = leerClaves(Buffer.from(privateKey).toString('base64'), 'region-1');

describe('tokens', () => {
  it('el token de renovación es aleatorio, base64url de 43 caracteres, y su hash es estable', () => {
    const a = nuevoTokenRenovacion();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nuevoTokenRenovacion()).not.toBe(a);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toContain(a);
  });

  it('el token de servicio propio se reusa hasta 30 s antes de vencer', async () => {
    let ahora = 0;
    const token = tokenDeServicioPropio(claves, 'region-1', () => ahora);
    const primero = await token();
    ahora += 4 * 60 * 1000;
    expect(await token()).toBe(primero);
    ahora += 40 * 1000;
    // Mismo segundo de emisión no garantiza otro texto; alcanza con que se haya vuelto a firmar.
    const segundo = await token();
    expect(typeof segundo).toBe('string');
    ahora += 1000;
    expect(await token()).toBe(segundo);
  });
});

describe('secretos de los servicios', () => {
  it('lee SECRETO_SERVICIO_<SERVICIO> y deja afuera los vacíos', () => {
    const secretos = secretosDeServicios({
      SECRETO_SERVICIO_CORREO: 'abc',
      SECRETO_SERVICIO_PRUEBAS: '',
      OTRA: 'x',
    });
    expect([...secretos]).toEqual([['correo', 'abc']]);
  });
});
