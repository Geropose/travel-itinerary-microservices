// Tokens que emite Autenticación (ADR-014, docs/CONVENCIONES.md 4.4):
// - JWT RS256 de 15 minutos con sub, region, roles e idioma;
// - token de servicio de 5 minutos (sub = servicio, roles = ["servicio"]);
// - token de renovación opaco de 7 días, del que se guarda solo el hash.
import { createHash, randomBytes } from 'node:crypto';
import type { Region } from '@trotamundos/comun';
import { SignJWT } from 'jose';
import type { ClavesJwt } from './claves.ts';

export const DURACION_JWT_SEG = 15 * 60;
export const DURACION_TOKEN_SERVICIO_SEG = 5 * 60;
export const DURACION_RENOVACION_SEG = 7 * 24 * 60 * 60;

export interface ClaimsUsuario {
  usuarioId: string;
  region: Region;
  roles: string[];
  idioma: string;
}

function firmar(claves: ClavesJwt, claims: Record<string, unknown>, sub: string, segundos: number) {
  const kid = claves.jwks.keys[0]?.kid ?? '';
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(`${segundos}s`)
    .sign(claves.privada);
}

/** JWT del usuario (15 minutos). */
export function firmarJwtUsuario(claves: ClavesJwt, usuario: ClaimsUsuario): Promise<string> {
  const { usuarioId, region, roles, idioma } = usuario;
  return firmar(claves, { region, roles, idioma }, usuarioId, DURACION_JWT_SEG);
}

/** Token de servicio (5 minutos). */
export function firmarTokenDeServicio(
  claves: ClavesJwt,
  servicio: string,
  region: Region,
): Promise<string> {
  return firmar(claves, { region, roles: ['servicio'] }, servicio, DURACION_TOKEN_SERVICIO_SEG);
}

/** Token de renovación nuevo: 32 bytes al azar en base64url (43 caracteres). */
export function nuevoTokenRenovacion(): string {
  return randomBytes(32).toString('base64url');
}

/** Hash con el que se guarda y se busca un token de renovación. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Token de servicio propio para llamar a Usuarios y a la otra región. Autenticación no se lo pide a
 * nadie: lo firma ella misma y lo reusa hasta 30 s antes de que venza.
 */
export function tokenDeServicioPropio(
  claves: ClavesJwt,
  region: Region,
  ahora: () => number = Date.now,
): () => Promise<string> {
  let actual: { token: string; venceEn: number } | undefined;
  return async () => {
    if (!actual || actual.venceEn - 30_000 < ahora()) {
      const token = await firmarTokenDeServicio(claves, 'autenticacion', region);
      actual = { token, venceEn: ahora() + DURACION_TOKEN_SERVICIO_SEG * 1000 };
    }
    return actual.token;
  };
}
