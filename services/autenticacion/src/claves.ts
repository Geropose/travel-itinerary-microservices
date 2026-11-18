// Claves RS256 del JWT de la región (ADR-014). La clave privada llega por entorno (JWT_CLAVE_PRIVADA,
// PEM en base64 de una sola línea, la genera npm run infra:secretos) y de ella sale la pública que se
// publica en GET /.well-known/jwks.json.
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import type { Region } from '@trotamundos/comun';

/** Clave pública en formato JWK (schema ClavePublica de specs/openapi/autenticacion.yaml). */
export interface ClavePublica {
  kty: 'RSA';
  use: 'sig';
  alg: 'RS256';
  kid: string;
  n: string;
  e: string;
}

export interface ClavesJwt {
  privada: KeyObject;
  /** JWKS con la clave pública, para GET /.well-known/jwks.json y para el validador propio. */
  jwks: { keys: ClavePublica[] };
}

/** Lee la clave privada (PEM en base64). Lanza un error claro si no es una clave RSA válida. */
export function leerClaves(pemBase64: string, region: Region): ClavesJwt {
  let privada: KeyObject;
  try {
    privada = createPrivateKey(Buffer.from(pemBase64, 'base64').toString('utf8'));
  } catch {
    throw new Error(
      'JWT_CLAVE_PRIVADA no es una clave privada PEM en base64 (npm run infra:secretos)',
    );
  }
  if (privada.asymmetricKeyType !== 'rsa') throw new Error('JWT_CLAVE_PRIVADA tiene que ser RSA');

  const { n, e } = createPublicKey(privada).export({ format: 'jwk' });
  if (!n || !e) throw new Error('No se pudo obtener la clave pública');
  // kid: huella de la clave (RFC 7638) con el prefijo de la región, por ejemplo r1-3f9a0c2b7d1e.
  const huella = createHash('sha256')
    .update(JSON.stringify({ e, kty: 'RSA', n }))
    .digest('base64url')
    .slice(0, 12);
  const kid = `r${region.slice(-1)}-${huella}`;
  return { privada, jwks: { keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', kid, n, e }] } };
}
