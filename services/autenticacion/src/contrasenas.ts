// Contraseñas con hash argon2id (ADR-014, QA-8): nunca se guardan en texto ni encriptadas de forma
// reversible. Parámetros de OWASP para argon2id: 19 MiB de memoria, 2 pasadas, 1 hilo.
import { hash, verify } from '@node-rs/argon2';

// El algoritmo por defecto de @node-rs/argon2 es argon2id (las pruebas lo comprueban en el hash).
const PARAMETROS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export function hashContrasena(contrasena: string): Promise<string> {
  return hash(contrasena, PARAMETROS);
}

export async function verificarContrasena(
  hashGuardado: string,
  contrasena: string,
): Promise<boolean> {
  try {
    return await verify(hashGuardado, contrasena);
  } catch {
    return false;
  }
}

/**
 * Hash de una contraseña que nadie tiene. Cuando el email no existe se verifica contra este, así el
 * login tarda lo mismo y no deja adivinar qué emails tienen cuenta.
 */
export const HASH_FALSO = hashContrasena('contrasena-que-nadie-tiene');
