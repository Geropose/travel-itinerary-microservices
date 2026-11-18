// Usuario analista de prueba (rol "analista", ADR-005): entra solo a /api/analitica/..., nunca a
// datos personales. Lo crea el script de semillas (semillas.ts).
import { randomUUID } from 'node:crypto';
import type { Pool } from '@trotamundos/comun';
import { hashContrasena } from './contrasenas.ts';
import { guardarCredencial } from './repositorio.ts';

export const EMAIL_ANALISTA = 'analista@trotamundos.example';

/** Crea el analista o, si ya existe, le pone esta contraseña. Devuelve su usuarioId. */
export async function sembrarAnalista(
  pool: Pool,
  contrasena: string,
  email: string = EMAIL_ANALISTA,
): Promise<string> {
  return guardarCredencial(pool, {
    usuarioId: randomUUID(),
    email,
    hashContrasena: await hashContrasena(contrasena),
    roles: ['analista'],
    idioma: 'es',
  });
}
