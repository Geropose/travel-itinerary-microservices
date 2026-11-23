// Acceso a la base de Autenticación (migrations/001_credenciales.sql).
import type { ClienteDb, Pool } from '@trotamundos/comun';

type Db = Pool | ClienteDb;

export interface Credencial {
  usuarioId: string;
  email: string;
  hashContrasena: string;
  roles: string[];
  idioma: string;
}

/** Los emails se guardan y se buscan en minúsculas. */
export const normalizarEmail = (email: string) => email.trim().toLowerCase();

export async function buscarPorEmail(db: Db, email: string): Promise<Credencial | undefined> {
  const { rows } = await db.query<Credencial>(
    `SELECT usuario_id AS "usuarioId", email, hash_contrasena AS "hashContrasena", roles, idioma
       FROM credenciales WHERE email = $1`,
    [normalizarEmail(email)],
  );
  return rows[0];
}

/** Guarda el idioma nuevo de la cuenta (evento IdiomaActualizado de Usuarios). */
export async function actualizarIdioma(db: Db, usuarioId: string, idioma: string): Promise<void> {
  await db.query('UPDATE credenciales SET idioma = $1 WHERE usuario_id = $2', [idioma, usuarioId]);
}

export async function existeEmail(db: Db, email: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM credenciales WHERE email = $1', [
    normalizarEmail(email),
  ]);
  return (rowCount ?? 0) > 0;
}

/** Lanza el error 23505 de PostgreSQL si el email ya existe. */
export async function crearCredencial(db: Db, credencial: Credencial): Promise<void> {
  await db.query(
    `INSERT INTO credenciales (usuario_id, email, hash_contrasena, roles, idioma)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      credencial.usuarioId,
      normalizarEmail(credencial.email),
      credencial.hashContrasena,
      credencial.roles,
      credencial.idioma,
    ],
  );
}

/** Crea la credencial o, si el email ya existe, le cambia la contraseña y los roles (semillas). */
export async function guardarCredencial(db: Db, credencial: Credencial): Promise<string> {
  const { rows } = await db.query<{ usuarioId: string }>(
    `INSERT INTO credenciales (usuario_id, email, hash_contrasena, roles, idioma)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE
       SET hash_contrasena = EXCLUDED.hash_contrasena, roles = EXCLUDED.roles
     RETURNING usuario_id AS "usuarioId"`,
    [
      credencial.usuarioId,
      normalizarEmail(credencial.email),
      credencial.hashContrasena,
      credencial.roles,
      credencial.idioma,
    ],
  );
  return rows[0]?.usuarioId ?? credencial.usuarioId;
}

// --- Tokens de renovación -----------------------------------------------------------------

export async function guardarTokenRenovacion(
  db: Db,
  hash: string,
  usuarioId: string,
  duracionSeg: number,
): Promise<void> {
  await db.query(
    `INSERT INTO tokens_renovacion (hash, usuario_id, vence_en)
     VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [hash, usuarioId, duracionSeg],
  );
}

/** Credencial dueña de un token de renovación vigente (no vencido ni revocado). */
export async function credencialDeTokenVigente(
  db: Db,
  hash: string,
): Promise<Credencial | undefined> {
  const { rows } = await db.query<Credencial>(
    `SELECT c.usuario_id AS "usuarioId", c.email, c.hash_contrasena AS "hashContrasena",
            c.roles, c.idioma
       FROM tokens_renovacion t JOIN credenciales c USING (usuario_id)
      WHERE t.hash = $1 AND t.revocado_en IS NULL AND t.vence_en > now()`,
    [hash],
  );
  return rows[0];
}

export async function duenoDeToken(db: Db, hash: string): Promise<string | undefined> {
  const { rows } = await db.query<{ usuarioId: string }>(
    'SELECT usuario_id AS "usuarioId" FROM tokens_renovacion WHERE hash = $1',
    [hash],
  );
  return rows[0]?.usuarioId;
}

export async function revocarToken(db: Db, hash: string): Promise<void> {
  await db.query(
    'UPDATE tokens_renovacion SET revocado_en = now() WHERE hash = $1 AND revocado_en IS NULL',
    [hash],
  );
}

// --- Límite de intentos -------------------------------------------------------------------

export type ResultadoReservaIntento =
  { permitido: true; intentoId: number } | { permitido: false; liberaEnSeg: number };

/**
 * Comprueba y reserva atómicamente un intento de login por email usando advisory lock transaccional
 * antes de correr argon2id, evitando carreras multi-instancia contra el límite de 5 intentos.
 */
export async function reservarIntentoLogin(
  pool: Pool,
  email: string,
  maxIntentos: number,
  ventanaMinutos: number,
): Promise<ResultadoReservaIntento> {
  const normalizado = normalizarEmail(email);
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`login:${normalizado}`]);
    await cliente.query(
      'DELETE FROM intentos_fallidos WHERE email = $1 AND fecha <= now() - make_interval(mins => $2)',
      [normalizado, ventanaMinutos],
    );
    const { rows } = await cliente.query<{ cantidad: string; libera: number | null }>(
      `SELECT count(*) AS cantidad,
              extract(epoch FROM min(fecha) + make_interval(mins => $2) - now())::int AS libera
         FROM intentos_fallidos
        WHERE email = $1 AND fecha > now() - make_interval(mins => $2)`,
      [normalizado, ventanaMinutos],
    );
    const cantidad = Number(rows[0]?.cantidad ?? 0);
    if (cantidad >= maxIntentos) {
      await cliente.query('COMMIT');
      return { permitido: false, liberaEnSeg: Math.max(1, rows[0]?.libera ?? 1) };
    }
    const insertado = await cliente.query<{ id: string | number }>(
      'INSERT INTO intentos_fallidos (email) VALUES ($1) RETURNING id',
      [normalizado],
    );
    await cliente.query('COMMIT');
    return { permitido: true, intentoId: Number(insertado.rows[0]?.id ?? 0) };
  } catch (error) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    cliente.release();
  }
}

/** Elimina únicamente la marca tentativa cuando /login deriva hacia la otra región. */
export async function borrarIntentoPorId(db: Db, intentoId: number): Promise<void> {
  if (!Number.isInteger(intentoId) || intentoId <= 0) return;
  await db.query('DELETE FROM intentos_fallidos WHERE id = $1', [intentoId]);
}

/**
 * Intentos fallidos del email dentro de la ventana y cuándo se libera el primero (para
 * Retry-After).
 */
export async function intentosRecientes(
  db: Db,
  email: string,
  ventanaMinutos: number,
): Promise<{ cantidad: number; liberaEnSeg: number }> {
  const { rows } = await db.query<{ cantidad: string; libera: number | null }>(
    `SELECT count(*) AS cantidad,
            extract(epoch FROM min(fecha) + make_interval(mins => $2) - now())::int AS libera
       FROM intentos_fallidos
      WHERE email = $1 AND fecha > now() - make_interval(mins => $2)`,
    [normalizarEmail(email), ventanaMinutos],
  );
  return {
    cantidad: Number(rows[0]?.cantidad ?? 0),
    liberaEnSeg: Math.max(1, rows[0]?.libera ?? 1),
  };
}

/** Guarda un intento fallido y borra los que ya quedaron fuera de la ventana. */
export async function registrarIntentoFallido(
  db: Db,
  email: string,
  ventanaMinutos: number,
): Promise<void> {
  const normalizado = normalizarEmail(email);
  await db.query('INSERT INTO intentos_fallidos (email) VALUES ($1)', [normalizado]);
  await db.query(
    'DELETE FROM intentos_fallidos WHERE email = $1 AND fecha <= now() - make_interval(mins => $2)',
    [normalizado, ventanaMinutos],
  );
}

/** Después de un login correcto se empieza de cero. */
export async function borrarIntentos(db: Db, email: string): Promise<void> {
  await db.query('DELETE FROM intentos_fallidos WHERE email = $1', [normalizarEmail(email)]);
}
