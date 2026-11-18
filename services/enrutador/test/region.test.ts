import { describe, expect, it } from 'vitest';
import { elegirRegion, quitarPrefijo, regionDelJwt } from '../src/region.ts';

const b64 = (datos: unknown) => Buffer.from(JSON.stringify(datos)).toString('base64url');
const jwt = (claims: unknown) => `Bearer ${b64({ alg: 'RS256' })}.${b64(claims)}.firma`;

describe('regionDelJwt', () => {
  it('lee el claim region sin verificar la firma', () => {
    expect(regionDelJwt(jwt({ sub: 'u', region: 'region-2' }))).toBe('region-2');
    expect(regionDelJwt(jwt({ region: 'region-1' }))).toBe('region-1');
  });

  it('un token que no se puede leer o sin una región válida se ignora', () => {
    expect(regionDelJwt(undefined)).toBeUndefined();
    expect(regionDelJwt('Basic dXN1YXJpbzpjbGF2ZQ==')).toBeUndefined();
    expect(regionDelJwt('Bearer basura')).toBeUndefined();
    expect(regionDelJwt(`Bearer ${b64({})}.no-es-json.firma`)).toBeUndefined();
    expect(regionDelJwt(jwt({ region: 'region-3' }))).toBeUndefined();
    expect(regionDelJwt(jwt(['region-1']))).toBeUndefined();
  });
});

describe('quitarPrefijo', () => {
  it('quita /region-1 o /region-2 y deja el resto de la URL', () => {
    expect(quitarPrefijo('/region-2/api/correo/oauth/callback?code=x')).toEqual({
      region: 'region-2',
      url: '/api/correo/oauth/callback?code=x',
    });
    expect(quitarPrefijo('/region-1')).toEqual({ region: 'region-1', url: '/' });
    expect(quitarPrefijo('/region-1?x=1')).toEqual({ region: 'region-1', url: '/?x=1' });
  });

  it('sin prefijo (o con uno parecido) no cambia la URL', () => {
    expect(quitarPrefijo('/api/viajes')).toEqual({ url: '/api/viajes' });
    expect(quitarPrefijo('/region-10/api')).toEqual({ url: '/region-10/api' });
    expect(quitarPrefijo('/api/region-1')).toEqual({ url: '/api/region-1' });
  });
});

describe('elegirRegion (gateway.yaml, Enrutador global)', () => {
  it('JWT antes que todo: un JWT de r2 va a r2 aunque traiga prefijo y X-Region de r1', () => {
    expect(
      elegirRegion(
        {
          url: '/region-1/api/viajes',
          authorization: jwt({ region: 'region-2' }),
          xRegion: 'region-1',
        },
        'region-1',
      ),
    ).toEqual({ region: 'region-2', motivo: 'jwt', url: '/api/viajes' });
  });

  it('sin JWT: prefijo, después X-Region y al final la región por defecto', () => {
    expect(elegirRegion({ url: '/region-2/x', xRegion: 'region-1' }, 'region-1')).toMatchObject({
      region: 'region-2',
      motivo: 'prefijo',
    });
    expect(elegirRegion({ url: '/x', xRegion: 'region-2' }, 'region-1')).toMatchObject({
      region: 'region-2',
      motivo: 'x-region',
    });
    expect(elegirRegion({ url: '/x' }, 'region-2')).toMatchObject({
      region: 'region-2',
      motivo: 'por-defecto',
    });
  });

  it('un X-Region inválido o repetido se ignora', () => {
    expect(elegirRegion({ url: '/x', xRegion: 'marte' }, 'region-1').motivo).toBe('por-defecto');
    expect(elegirRegion({ url: '/x', xRegion: ['region-2'] }, 'region-1').motivo).toBe(
      'por-defecto',
    );
  });
});
