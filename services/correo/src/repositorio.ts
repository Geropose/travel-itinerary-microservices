// Persistencia de cuentas de correo y states OAuth en PostgreSQL (una base por servicio).
// Todos los tokens y secretos de suscripción se almacenan cifrados con AES-256-GCM.
import { randomUUID } from 'node:crypto';
import type { ClienteDb, Pool } from '@trotamundos/comun';

type Db = Pool | ClienteDb;
import { encriptarTexto } from './cifrado.ts';
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
