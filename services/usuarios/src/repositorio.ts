// Acceso a la base de Usuarios (migrations/001_usuarios.sql): cuentas y preferencias, filtros y
// whitelist, y permisos de itinerarios compartidos.
import type { ClienteDb, Pool, Region } from '@trotamundos/comun';

type Db = Pool | ClienteDb;

export interface CuentaNueva {
  usuarioId: string;
  email: string;
  nombre: string;
  region: Region;
  idioma: string;
}

export interface Perfil {
  usuarioId: string;
  email: string;
  nombre: string;
  region: Region;
  idioma: string;
  moneda: string;
  agenciaPreferida: string | null;
  creadoEn: string;
}

export interface CambiosPerfil {
  nombre?: string;
  idioma?: string;
  moneda?: string;
  agenciaPreferida?: string | null;
}

export interface Whitelist {
  usuarioId: string;
  remitentesPermitidos: string[];
  filtrosActivos: boolean;
  actualizadoEn: string | null;
}

export interface Designado {
  email: string;
  usuarioId: string | null;
  designadoEn: string;
}

interface FilaPerfil {
  usuarioId: string;
  email: string;
  nombre: string;
  region: Region;
  idioma: string;
  moneda: string;
  agenciaPreferida: string | null;
  creadoEn: Date | string;
}

interface FilaWhitelist {
  usuarioId: string;
  remitentesPermitidos: string[];
  filtrosActivos: boolean;
  actualizadoEn: Date | string | null;
}

interface FilaDesignado {
  email: string;
  usuarioId: string | null;
  designadoEn: Date | string;
}

/** Los emails y remitentes se guardan y buscan en minúsculas. */
export const normalizarEmail = (email: string): string => email.trim().toLowerCase();

const aIso = (fecha: Date | string): string =>
  fecha instanceof Date ? fecha.toISOString() : new Date(fecha).toISOString();

function aPerfil(fila: FilaPerfil): Perfil {
  return {
    usuarioId: fila.usuarioId,
    email: fila.email,
    nombre: fila.nombre,
    region: fila.region,
    idioma: fila.idioma,
    moneda: fila.moneda,
    agenciaPreferida: fila.agenciaPreferida ?? null,
    creadoEn: aIso(fila.creadoEn),
  };
}

function aWhitelist(fila: FilaWhitelist): Whitelist {
  return {
    usuarioId: fila.usuarioId,
    remitentesPermitidos: fila.remitentesPermitidos,
    filtrosActivos: fila.filtrosActivos,
    actualizadoEn: fila.actualizadoEn ? aIso(fila.actualizadoEn) : null,
  };
}

function aDesignado(fila: FilaDesignado): Designado {
  return {
    email: fila.email,
    usuarioId: fila.usuarioId ?? null,
    designadoEn: aIso(fila.designadoEn),
  };
}

// --- Cuentas y preferencias ---------------------------------------------------------------

/**
 * Crea la cuenta con moneda USD, sin agencia preferida y whitelist inicial vacía. Es idempotente si
 * ya existe exactamente con el mismo (usuarioId, email, region) ante reintentos de timeout, y
 * vincula designaciones previas donde este email había quedado con usuario_id NULL (lockeando el email).
 */
export async function crearCuenta(db: Db, cuenta: CuentaNueva): Promise<Perfil> {
  const email = normalizarEmail(cuenta.email);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`email:${email}`]);
  const existente = await db.query<FilaPerfil>(
    `SELECT usuario_id AS "usuarioId", email, nombre, region, idioma, moneda,
            agencia_preferida AS "agenciaPreferida", creado_en AS "creadoEn"
       FROM cuentas
      WHERE usuario_id = $1 AND email = $2 AND region = $3`,
    [cuenta.usuarioId, email, cuenta.region],
  );
  if (existente.rows[0]) {
    return aPerfil(existente.rows[0]);
  }
  const { rows } = await db.query<FilaPerfil>(
    `INSERT INTO cuentas (usuario_id, email, nombre, region, idioma)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING usuario_id AS "usuarioId", email, nombre, region, idioma, moneda,
               agencia_preferida AS "agenciaPreferida", creado_en AS "creadoEn"`,
    [cuenta.usuarioId, email, cuenta.nombre, cuenta.region, cuenta.idioma],
  );
  await db.query(
    `INSERT INTO whitelists (usuario_id, remitentes_permitidos, filtros_activos, actualizado_en)
     VALUES ($1, '{}', false, NULL)`,
    [cuenta.usuarioId],
  );
  await db.query(
    `UPDATE designados_itinerario
        SET usuario_id = $1
      WHERE email = $2 AND usuario_id IS NULL`,
    [cuenta.usuarioId, email],
  );
  const creada = rows[0];
  if (!creada) throw new Error('No se pudo leer la cuenta recién creada');
  return aPerfil(creada);
}

export async function existeCuenta(db: Db, usuarioId: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM cuentas WHERE usuario_id = $1', [usuarioId]);
  return (rowCount ?? 0) > 0;
}

export async function buscarPerfil(db: Db, usuarioId: string): Promise<Perfil | undefined> {
  const { rows } = await db.query<FilaPerfil>(
    `SELECT usuario_id AS "usuarioId", email, nombre, region, idioma, moneda,
            agencia_preferida AS "agenciaPreferida", creado_en AS "creadoEn"
       FROM cuentas
      WHERE usuario_id = $1`,
    [usuarioId],
  );
  return rows[0] ? aPerfil(rows[0]) : undefined;
}

export async function buscarPorEmail(
  db: Db,
  email: string,
): Promise<{ usuarioId: string; email: string } | undefined> {
  const { rows } = await db.query<{ usuarioId: string; email: string }>(
    'SELECT usuario_id AS "usuarioId", email FROM cuentas WHERE email = $1',
    [normalizarEmail(email)],
  );
  return rows[0];
}

export async function actualizarPerfil(
  db: Db,
  usuarioId: string,
  cambios: CambiosPerfil,
): Promise<Perfil | undefined> {
  const asignaciones: string[] = [];
  const valores: unknown[] = [];

  if (cambios.nombre !== undefined) {
    valores.push(cambios.nombre);
    asignaciones.push(`nombre = $${valores.length}`);
  }
  if (cambios.idioma !== undefined) {
    valores.push(cambios.idioma);
    asignaciones.push(`idioma = $${valores.length}`);
  }
  if (cambios.moneda !== undefined) {
    valores.push(cambios.moneda);
    asignaciones.push(`moneda = $${valores.length}`);
  }
  if (cambios.agenciaPreferida !== undefined) {
    valores.push(cambios.agenciaPreferida);
    asignaciones.push(`agencia_preferida = $${valores.length}`);
  }

  if (asignaciones.length === 0) return buscarPerfil(db, usuarioId);

  valores.push(usuarioId);
  const { rows } = await db.query<FilaPerfil>(
    `UPDATE cuentas
        SET ${asignaciones.join(', ')}
      WHERE usuario_id = $${valores.length}
     RETURNING usuario_id AS "usuarioId", email, nombre, region, idioma, moneda,
               agencia_preferida AS "agenciaPreferida", creado_en AS "creadoEn"`,
    valores,
  );
  return rows[0] ? aPerfil(rows[0]) : undefined;
}

export async function obtenerAgenciaPreferida(
  db: Db,
  usuarioId: string,
): Promise<{ usuarioId: string; agenciaPreferida: string | null } | undefined> {
  const { rows } = await db.query<{ usuarioId: string; agenciaPreferida: string | null }>(
    `SELECT usuario_id AS "usuarioId", agencia_preferida AS "agenciaPreferida"
       FROM cuentas
      WHERE usuario_id = $1`,
    [usuarioId],
  );
  const fila = rows[0];
  if (!fila) return undefined;
  return { usuarioId: fila.usuarioId, agenciaPreferida: fila.agenciaPreferida ?? null };
}

// --- Filtros y whitelist ------------------------------------------------------------------

export async function obtenerWhitelist(db: Db, usuarioId: string): Promise<Whitelist | undefined> {
  const { rows } = await db.query<FilaWhitelist>(
    `SELECT c.usuario_id AS "usuarioId",
            COALESCE(w.remitentes_permitidos, '{}') AS "remitentesPermitidos",
            COALESCE(w.filtros_activos, false) AS "filtrosActivos",
            w.actualizado_en AS "actualizadoEn"
       FROM cuentas c
       LEFT JOIN whitelists w USING (usuario_id)
      WHERE c.usuario_id = $1`,
    [usuarioId],
  );
  return rows[0] ? aWhitelist(rows[0]) : undefined;
}

export async function guardarWhitelist(
  db: Db,
  usuarioId: string,
  remitentesPermitidos: string[],
  filtrosActivos: boolean,
): Promise<Whitelist> {
  const { rows } = await db.query<FilaWhitelist>(
    `INSERT INTO whitelists (usuario_id, remitentes_permitidos, filtros_activos, actualizado_en)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (usuario_id) DO UPDATE
       SET remitentes_permitidos = EXCLUDED.remitentes_permitidos,
           filtros_activos = EXCLUDED.filtros_activos,
           actualizado_en = now()
     RETURNING usuario_id AS "usuarioId",
               remitentes_permitidos AS "remitentesPermitidos",
               filtros_activos AS "filtrosActivos",
               actualizado_en AS "actualizadoEn"`,
    [usuarioId, remitentesPermitidos, filtrosActivos],
  );
  const guardada = rows[0];
  if (!guardada) throw new Error('No se pudo guardar la whitelist');
  return aWhitelist(guardada);
}

// --- Permisos de itinerarios --------------------------------------------------------------

export async function listarDesignados(db: Db, viajeId: string): Promise<Designado[]> {
  const { rows } = await db.query<FilaDesignado>(
    `SELECT email, usuario_id AS "usuarioId", designado_en AS "designadoEn"
       FROM designados_itinerario
      WHERE viaje_id = $1
      ORDER BY designado_en ASC, email ASC`,
    [viajeId],
  );
  return rows.map(aDesignado);
}

/** Lanza el error 23505 de PostgreSQL si la persona ya está designada en el viaje. */
export async function designarPersona(
  db: Db,
  viajeId: string,
  email: string,
  usuarioId: string | null,
): Promise<Designado> {
  const { rows } = await db.query<FilaDesignado>(
    `INSERT INTO designados_itinerario (viaje_id, email, usuario_id)
     VALUES ($1, $2, $3)
     RETURNING email, usuario_id AS "usuarioId", designado_en AS "designadoEn"`,
    [viajeId, normalizarEmail(email), usuarioId],
  );
  const creado = rows[0];
  if (!creado) throw new Error('No se pudo guardar el designado');
  return aDesignado(creado);
}

export async function quitarDesignado(db: Db, viajeId: string, email: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM designados_itinerario
      WHERE viaje_id = $1 AND email = $2`,
    [viajeId, normalizarEmail(email)],
  );
  return (rowCount ?? 0) > 0;
}

export async function esDesignado(db: Db, viajeId: string, usuarioId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1
       FROM designados_itinerario
      WHERE viaje_id = $1 AND usuario_id = $2
      LIMIT 1`,
    [viajeId, usuarioId],
  );
  return (rowCount ?? 0) > 0;
}
