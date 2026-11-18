// Persistencia de cuentas de correo y states OAuth en PostgreSQL (una base por servicio).
// Todos los tokens y secretos de suscripción se almacenan cifrados con AES-256-GCM.
import { randomUUID } from 'node:crypto';
import type { ClienteDb, Pool } from '@trotamundos/comun';

type Db = Pool | ClienteDb;
import { desencriptarTexto, encriptarTexto } from './cifrado.ts';
import type { CredencialesOAuth, ProveedorCorreo, SuscripcionAvisos } from './adaptadores/tipos.ts';

export type EstadoCuentaCorreo = 'conectada' | 'sin-permiso';

/** Representación pública devuelta por GET /cuentas-correo (nunca incluye tokens). */
export interface CuentaCorreoPublica {
  id: string;
  proveedorCorreo: ProveedorCorreo;
  email: string;
  estado: EstadoCuentaCorreo;
  conectadaEn: string;
  ultimaRevision: string | null;
}

export interface RegistroCuentaInterna {
  id: string;
  usuarioId: string;
  proveedor: ProveedorCorreo;
  email: string;
  estado: EstadoCuentaCorreo;
  accessTokenCifrado: string;
  refreshTokenCifrado: string;
  tokenVenceEn: Date;
  suscripcionId: string | null;
}

interface FilaCuentaPublica {
  id: string;
  proveedor: string;
  email: string;
  estado: EstadoCuentaCorreo;
  conectada_en: Date;
  ultima_revision: Date | null;
}

interface FilaCuentaToken {
  id: string;
  usuario_id: string;
  proveedor: string;
  email: string;
  estado: EstadoCuentaCorreo;
  access_token_cifrado: string;
  refresh_token_cifrado: string;
  token_vence_en: Date;
  suscripcion_id: string | null;
}

function mapearCuentaPublica(fila: FilaCuentaPublica): CuentaCorreoPublica {
  return {
    id: fila.id,
    proveedorCorreo: fila.proveedor,
    email: fila.email,
    estado: fila.estado,
    conectadaEn: fila.conectada_en.toISOString(),
    ultimaRevision: fila.ultima_revision ? fila.ultima_revision.toISOString() : null,
  };
}

export async function crearStateOAuth(
  db: Db,
  datos: { nonce: string; usuarioId: string; proveedor: string; venceEn: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO oauth_states (nonce, usuario_id, proveedor, vence_en)
     VALUES ($1, $2, $3, $4)`,
    [datos.nonce, datos.usuarioId, datos.proveedor, datos.venceEn],
  );
}

/** Marca el nonce como usado de forma atómica; devuelve false si no existe, venció o ya se usó. */
export async function consumirStateOAuth(
  db: Db,
  datos: { nonce: string; usuarioId: string; proveedor: string; ahora?: Date },
): Promise<boolean> {
  const ahora = datos.ahora ?? new Date();
  const res = await db.query<{ nonce: string }>(
    `UPDATE oauth_states
     SET usado_en = $4
     WHERE nonce = $1
       AND usuario_id = $2
       AND proveedor = $3
       AND usado_en IS NULL
       AND vence_en > $4
     RETURNING nonce`,
    [datos.nonce, datos.usuarioId, datos.proveedor, ahora],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listarCuentasUsuario(
  db: Db,
  usuarioId: string,
): Promise<CuentaCorreoPublica[]> {
  const res = await db.query<FilaCuentaPublica>(
    `SELECT id, proveedor, email, estado, conectada_en, ultima_revision
     FROM cuentas_correo
     WHERE usuario_id = $1
     ORDER BY conectada_en ASC, id ASC`,
    [usuarioId],
  );
  return res.rows.map(mapearCuentaPublica);
}

export async function guardarCuentaConectada(
  db: Db,
  claveTokens: Buffer,
  datos: {
    usuarioId: string;
    proveedor: ProveedorCorreo;
    email: string;
    credenciales: CredencialesOAuth;
    ahora?: Date;
  },
): Promise<{ resultado: 'ok'; cuentaId: string } | { resultado: 'cuenta-de-otro-usuario' }> {
  const ahora = datos.ahora ?? new Date();
  const refreshToken = datos.credenciales.refreshToken;
  if (!refreshToken) {
    throw new Error('Falta refreshToken al guardar cuenta conectada.');
  }

  const existente = await db.query<{ id: string; usuario_id: string }>(
    `SELECT id, usuario_id
     FROM cuentas_correo
     WHERE proveedor = $1 AND email = $2
     FOR UPDATE`,
    [datos.proveedor, datos.email],
  );

  const fila = existente.rows[0];
  if (fila && fila.usuario_id !== datos.usuarioId) {
    return { resultado: 'cuenta-de-otro-usuario' };
  }

  // Vinculamos los textos cifrados al usuarioId mediante AAD para evitar intercambio entre filas.
  const accessCifrado = encriptarTexto(
    claveTokens,
    datos.credenciales.accessToken,
    datos.usuarioId,
  );
  const refreshCifrado = encriptarTexto(claveTokens, refreshToken, datos.usuarioId);

  if (fila) {
    await db.query(
      `UPDATE cuentas_correo
       SET estado = 'conectada',
           access_token_cifrado = $2,
           refresh_token_cifrado = $3,
           token_vence_en = $4,
           scope_concedido = $5,
           revision_prioritaria = true,
           proxima_revision = $6,
           conectada_en = $6,
           actualizado_en = $6
       WHERE id = $1`,
      [
        fila.id,
        accessCifrado,
        refreshCifrado,
        datos.credenciales.expiraEn,
        datos.credenciales.scope,
        ahora,
      ],
    );
    return { resultado: 'ok', cuentaId: fila.id };
  }

  const cuentaId = randomUUID();
  await db.query(
    `INSERT INTO cuentas_correo (
       id, usuario_id, proveedor, email, estado,
       access_token_cifrado, refresh_token_cifrado, token_vence_en, scope_concedido,
       revision_prioritaria, proxima_revision, conectada_en, actualizado_en
     )
     VALUES ($1, $2, $3, $4, 'conectada', $5, $6, $7, $8, true, $9, $9, $9)`,
    [
      cuentaId,
      datos.usuarioId,
      datos.proveedor,
      datos.email,
      accessCifrado,
      refreshCifrado,
      datos.credenciales.expiraEn,
      datos.credenciales.scope,
      ahora,
    ],
  );
  return { resultado: 'ok', cuentaId };
}

export async function guardarSuscripcionCuenta(
  db: Db,
  claveTokens: Buffer,
  datos: {
    cuentaId: string;
    usuarioId: string;
    suscripcion: SuscripcionAvisos;
    ahora?: Date;
  },
): Promise<void> {
  const ahora = datos.ahora ?? new Date();
  const secretoCifrado = datos.suscripcion.secreto
    ? encriptarTexto(claveTokens, datos.suscripcion.secreto, datos.usuarioId)
    : null;
  await db.query(
    `UPDATE cuentas_correo
     SET suscripcion_id = $2,
         suscripcion_secreto_cifrado = $3,
         suscripcion_vence_en = $4,
         actualizado_en = $5
     WHERE id = $1 AND usuario_id = $6`,
    [
      datos.cuentaId,
      datos.suscripcion.suscripcionId,
      secretoCifrado,
      datos.suscripcion.venceEn,
      ahora,
      datos.usuarioId,
    ],
  );
}

export async function buscarCuentaParaDesconectar(
  db: Db,
  cuentaId: string,
  usuarioId: string,
): Promise<{
  id: string;
  proveedor: ProveedorCorreo;
  suscripcionId: string | null;
} | null> {
  const res = await db.query<{
    id: string;
    proveedor: string;
    suscripcion_id: string | null;
  }>(
    `SELECT id, proveedor, suscripcion_id
     FROM cuentas_correo
     WHERE id = $1 AND usuario_id = $2`,
    [cuentaId, usuarioId],
  );
  const fila = res.rows[0];
  if (!fila) return null;
  return {
    id: fila.id,
    proveedor: fila.proveedor,
    suscripcionId: fila.suscripcion_id,
  };
}

export async function eliminarCuentaUsuario(
  db: Db,
  cuentaId: string,
  usuarioId: string,
): Promise<boolean> {
  const res = await db.query<{ id: string }>(
    `DELETE FROM cuentas_correo
     WHERE id = $1 AND usuario_id = $2
     RETURNING id`,
    [cuentaId, usuarioId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function bloquearCuentaParaToken(
  db: Db,
  cuentaId: string,
): Promise<RegistroCuentaInterna | null> {
  const res = await db.query<FilaCuentaToken>(
    `SELECT id, usuario_id, proveedor, email, estado,
            access_token_cifrado, refresh_token_cifrado, token_vence_en, suscripcion_id
     FROM cuentas_correo
     WHERE id = $1
     FOR UPDATE`,
    [cuentaId],
  );
  const fila = res.rows[0];
  if (!fila) return null;
  return {
    id: fila.id,
    usuarioId: fila.usuario_id,
    proveedor: fila.proveedor,
    email: fila.email,
    estado: fila.estado,
    accessTokenCifrado: fila.access_token_cifrado,
    refreshTokenCifrado: fila.refresh_token_cifrado,
    tokenVenceEn: fila.token_vence_en,
    suscripcionId: fila.suscripcion_id,
  };
}

export async function actualizarTokensCuenta(
  db: Db,
  claveTokens: Buffer,
  datos: {
    cuentaId: string;
    usuarioId: string;
    credenciales: CredencialesOAuth;
    ahora?: Date;
  },
): Promise<void> {
  const ahora = datos.ahora ?? new Date();
  const accessCifrado = encriptarTexto(
    claveTokens,
    datos.credenciales.accessToken,
    datos.usuarioId,
  );
  if (datos.credenciales.refreshToken) {
    const refreshCifrado = encriptarTexto(
      claveTokens,
      datos.credenciales.refreshToken,
      datos.usuarioId,
    );
    await db.query(
      `UPDATE cuentas_correo
       SET access_token_cifrado = $2,
           refresh_token_cifrado = $3,
           token_vence_en = $4,
           scope_concedido = $5,
           actualizado_en = $6
       WHERE id = $1`,
      [
        datos.cuentaId,
        accessCifrado,
        refreshCifrado,
        datos.credenciales.expiraEn,
        datos.credenciales.scope,
        ahora,
      ],
    );
    return;
  }

  await db.query(
    `UPDATE cuentas_correo
     SET access_token_cifrado = $2,
         token_vence_en = $3,
         scope_concedido = $4,
         actualizado_en = $5
     WHERE id = $1`,
    [datos.cuentaId, accessCifrado, datos.credenciales.expiraEn, datos.credenciales.scope, ahora],
  );
}

export async function marcarCuentaSinPermiso(
  db: Db,
  cuentaId: string,
  ahora: Date = new Date(),
): Promise<void> {
  await db.query(
    `UPDATE cuentas_correo
     SET estado = 'sin-permiso',
         revision_prioritaria = false,
         actualizado_en = $2
     WHERE id = $1`,
    [cuentaId, ahora],
  );
}

/** Devuelve cuentas conectadas con prioridad máxima vencida (para revisión en el primer minuto). */
export async function buscarCuentasPrioritariasPendientes(
  db: Db,
  ahora: Date = new Date(),
): Promise<{ id: string; usuarioId: string; proveedor: ProveedorCorreo; email: string }[]> {
  const res = await db.query<{
    id: string;
    usuario_id: string;
    proveedor: string;
    email: string;
  }>(
    `SELECT id, usuario_id, proveedor, email
     FROM cuentas_correo
     WHERE estado = 'conectada'
       AND revision_prioritaria = true
       AND proxima_revision <= $1
     ORDER BY proxima_revision ASC`,
    [ahora],
  );
  return res.rows.map((r) => ({
    id: r.id,
    usuarioId: r.usuario_id,
    proveedor: r.proveedor,
    email: r.email,
  }));
}

export interface CuentaCandidataExaminador {
  id: string;
  usuarioId: string;
  proveedor: ProveedorCorreo;
  email: string;
  suscripcionId: string | null;
  revisionPrioritaria: boolean;
  proximaRevision: Date;
  ultimoEncolado: Date | null;
  intentos429: number;
}

export interface CuentaPushGmail {
  id: string;
  usuarioId: string;
  proveedor: ProveedorCorreo;
  email: string;
  bloqueadoHasta: Date | null;
}

export interface CuentaPushSuscripcion {
  id: string;
  usuarioId: string;
  proveedor: ProveedorCorreo;
  email: string;
  secretoSuscripcion: string | null;
  bloqueadoHasta: Date | null;
}

/** Calcula la espera exponencial respetando `Retry-After` del proveedor y el tope máximo. */
export function calcularEsperaExponencialMs(
  intento: number,
  baseMs: number,
  maxMs: number,
  retryAfterSeg?: number,
): number {
  const exponente = Math.min(Math.max(intento - 1, 0), 30);
  const exponencial = Math.min(baseMs * 2 ** exponente, maxMs);
  const encabezado = retryAfterSeg !== undefined && retryAfterSeg > 0 ? retryAfterSeg * 1000 : 0;
  return Math.max(exponencial, encabezado);
}

/**
 * Bloquea con FOR UPDATE SKIP LOCKED las cuentas activas sin backoff vigente para evitar que
 * múltiples instancias de correo encolen el mismo buzón a la vez.
 */
export async function obtenerCuentasParaExaminar(
  db: Db,
  ahora: Date,
): Promise<CuentaCandidataExaminador[]> {
  const res = await db.query<{
    id: string;
    usuario_id: string;
    proveedor: string;
    email: string;
    suscripcion_id: string | null;
    revision_prioritaria: boolean;
    proxima_revision: Date;
    ultimo_encolado: Date | null;
    intentos_429: number;
  }>(
    `SELECT id, usuario_id, proveedor, email, suscripcion_id,
            revision_prioritaria, proxima_revision, ultimo_encolado, intentos_429
     FROM cuentas_correo
     WHERE estado = 'conectada'
       AND (bloqueado_hasta IS NULL OR bloqueado_hasta <= $1)
     FOR UPDATE OF cuentas_correo SKIP LOCKED`,
    [ahora],
  );
  return res.rows.map((r) => ({
    id: r.id,
    usuarioId: r.usuario_id,
    proveedor: r.proveedor,
    email: r.email,
    suscripcionId: r.suscripcion_id,
    revisionPrioritaria: r.revision_prioritaria,
    proximaRevision: r.proxima_revision,
    ultimoEncolado: r.ultimo_encolado,
    intentos429: r.intentos_429,
  }));
}

export async function marcarCuentasEncoladas(
  db: Db,
  cuentaIds: string[],
  ahora: Date,
): Promise<void> {
  if (cuentaIds.length === 0) return;
  await db.query(
    `UPDATE cuentas_correo
     SET revision_prioritaria = false,
         ultimo_encolado = $2,
         actualizado_en = $2
     WHERE id = ANY($1::uuid[])`,
    [cuentaIds, ahora],
  );
}

export async function programarRevisionDiferida(
  db: Db,
  cuentaId: string,
  cuando: Date,
  ahora: Date,
): Promise<void> {
  await db.query(
    `UPDATE cuentas_correo
     SET revision_prioritaria = true,
         proxima_revision = $2,
         actualizado_en = $3
     WHERE id = $1 AND estado = 'conectada'`,
    [cuentaId, cuando, ahora],
  );
}

export async function registrarBackoff429(
  db: Db,
  datos: {
    cuentaId: string;
    baseMs: number;
    maxMs: number;
    retryAfterSeg?: number;
    ahora?: Date;
  },
): Promise<{ intentos: number; esperaMs: number; bloqueadoHasta: Date } | null> {
  const ahora = datos.ahora ?? new Date();
  const actual = await db.query<{ intentos_429: number }>(
    `SELECT intentos_429 FROM cuentas_correo WHERE id = $1 FOR UPDATE`,
    [datos.cuentaId],
  );
  const fila = actual.rows[0];
  if (!fila) return null;

  const intentos = fila.intentos_429 + 1;
  const esperaMs = calcularEsperaExponencialMs(
    intentos,
    datos.baseMs,
    datos.maxMs,
    datos.retryAfterSeg,
  );
  const bloqueadoHasta = new Date(ahora.getTime() + esperaMs);

  await db.query(
    `UPDATE cuentas_correo
     SET intentos_429 = $2,
         bloqueado_hasta = $3,
         actualizado_en = $4
     WHERE id = $1`,
    [datos.cuentaId, intentos, bloqueadoHasta, ahora],
  );
  return { intentos, esperaMs, bloqueadoHasta };
}

export async function limpiarBackoff429(
  db: Db,
  cuentaId: string,
  ahora: Date = new Date(),
): Promise<void> {
  await db.query(
    `UPDATE cuentas_correo
     SET intentos_429 = 0,
         bloqueado_hasta = NULL,
         actualizado_en = $2
     WHERE id = $1
       AND (intentos_429 > 0 OR bloqueado_hasta IS NOT NULL)`,
    [cuentaId, ahora],
  );
}

export async function buscarCuentaPorEmail(
  db: Db,
  proveedor: ProveedorCorreo,
  email: string,
): Promise<CuentaPushGmail | null> {
  const res = await db.query<{
    id: string;
    usuario_id: string;
    proveedor: string;
    email: string;
    bloqueado_hasta: Date | null;
  }>(
    `SELECT id, usuario_id, proveedor, email, bloqueado_hasta
     FROM cuentas_correo
     WHERE proveedor = $1
       AND email = $2
       AND estado = 'conectada'`,
    [proveedor, email.trim().toLowerCase()],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    usuarioId: r.usuario_id,
    proveedor: r.proveedor,
    email: r.email,
    bloqueadoHasta: r.bloqueado_hasta,
  };
}

export async function buscarCuentaPorSuscripcion(
  db: Db,
  claveTokens: Buffer,
  proveedor: ProveedorCorreo,
  suscripcionId: string,
): Promise<CuentaPushSuscripcion | null> {
  const res = await db.query<{
    id: string;
    usuario_id: string;
    proveedor: string;
    email: string;
    suscripcion_secreto_cifrado: string | null;
    bloqueado_hasta: Date | null;
  }>(
    `SELECT id, usuario_id, proveedor, email, suscripcion_secreto_cifrado, bloqueado_hasta
     FROM cuentas_correo
     WHERE proveedor = $1
       AND suscripcion_id = $2
       AND estado = 'conectada'`,
    [proveedor, suscripcionId],
  );
  const r = res.rows[0];
  if (!r) return null;
  const secretoSuscripcion = r.suscripcion_secreto_cifrado
    ? desencriptarTexto(claveTokens, r.suscripcion_secreto_cifrado, r.usuario_id)
    : null;
  return {
    id: r.id,
    usuarioId: r.usuario_id,
    proveedor: r.proveedor,
    email: r.email,
    secretoSuscripcion,
    bloqueadoHasta: r.bloqueado_hasta,
  };
}

export async function registrarAvisoPushVisto(
  db: Db,
  proveedor: ProveedorCorreo,
  avisoId: string,
  ahora: Date = new Date(),
): Promise<boolean> {
  const res = await db.query<{ aviso_id: string }>(
    `INSERT INTO avisos_push_vistos (proveedor, aviso_id, visto_en)
     VALUES ($1, $2, $3)
     ON CONFLICT (proveedor, aviso_id) DO NOTHING
     RETURNING aviso_id`,
    [proveedor, avisoId, ahora],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function eliminarAvisoPushVisto(
  db: Db,
  proveedor: ProveedorCorreo,
  avisoId: string,
): Promise<void> {
  await db.query(`DELETE FROM avisos_push_vistos WHERE proveedor = $1 AND aviso_id = $2`, [
    proveedor,
    avisoId,
  ]);
}
