// Persistencia de cuentas de correo y states OAuth en PostgreSQL (una base por servicio).
// Todos los tokens y secretos de suscripción se almacenan cifrados con AES-256-GCM.
import { randomUUID } from 'node:crypto';
import {
  guardarEnOutbox,
  type ClienteDb,
  type Pool,
  type Sobre,
  type ValidadorEventos,
} from '@trotamundos/comun';
import { desencriptarTexto, encriptarTexto } from './cifrado.ts';
import type { CredencialesOAuth, ProveedorCorreo, SuscripcionAvisos } from './adaptadores/tipos.ts';
import type { MotivoNoProcesado, ReservaDetectadaDatos } from './extractor.ts';

type Db = Pool | ClienteDb;

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

  const actualizarExistente = async (id: string) => {
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
        id,
        accessCifrado,
        refreshCifrado,
        datos.credenciales.expiraEn,
        datos.credenciales.scope,
        ahora,
      ],
    );
  };

  if (fila) {
    await actualizarExistente(fila.id);
    return { resultado: 'ok', cuentaId: fila.id };
  }

  const cuentaId = randomUUID();
  const insertada = await db.query<{ id: string }>(
    `INSERT INTO cuentas_correo (
       id, usuario_id, proveedor, email, estado,
       access_token_cifrado, refresh_token_cifrado, token_vence_en, scope_concedido,
       revision_prioritaria, proxima_revision, conectada_en, actualizado_en
     )
     VALUES ($1, $2, $3, $4, 'conectada', $5, $6, $7, $8, true, $9, $9, $9)
     ON CONFLICT (proveedor, email) DO NOTHING
     RETURNING id`,
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
  if (insertada.rows[0]) {
    return { resultado: 'ok', cuentaId: insertada.rows[0].id };
  }

  // Carrera concurrente al crear la fila: re-leemos con FOR UPDATE.
  const enCarrera = await db.query<{ id: string; usuario_id: string }>(
    `SELECT id, usuario_id
     FROM cuentas_correo
     WHERE proveedor = $1 AND email = $2
     FOR UPDATE`,
    [datos.proveedor, datos.email],
  );
  const filaCarrera = enCarrera.rows[0];
  if (!filaCarrera) {
    throw new Error('La cuenta de correo desapareció tras conflicto de inserción.');
  }
  if (filaCarrera.usuario_id !== datos.usuarioId) {
    return { resultado: 'cuenta-de-otro-usuario' };
  }
  await actualizarExistente(filaCarrera.id);
  return { resultado: 'ok', cuentaId: filaCarrera.id };
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
  suscripcionVenceEn?: Date | null;
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
    suscripcion_vence_en: Date | null;
    revision_prioritaria: boolean;
    proxima_revision: Date;
    ultimo_encolado: Date | null;
    intentos_429: number;
  }>(
    `SELECT id, usuario_id, proveedor, email, suscripcion_id, suscripcion_vence_en,
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
    suscripcionVenceEn: r.suscripcion_vence_en,
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
  opciones: { limpiarPrioridad?: boolean } = {},
): Promise<void> {
  if (cuentaIds.length === 0) return;
  const limpiarPrioridad = opciones.limpiarPrioridad ?? true;
  await db.query(
    `UPDATE cuentas_correo
     SET revision_prioritaria = CASE WHEN $3::boolean THEN false ELSE revision_prioritaria END,
         ultimo_encolado = $2,
         actualizado_en = $2
     WHERE id = ANY($1::uuid[])`,
    [cuentaIds, ahora, limpiarPrioridad],
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

// --- Procesadores, Filtro de remitentes y No Procesados (P2.B6) -----------------------------------

export interface FiltroRemitentesUsuario {
  remitentesPermitidos: string[];
  filtrosActivos: boolean;
}

export interface CuentaParaProcesar {
  id: string;
  usuarioId: string;
  proveedor: ProveedorCorreo;
  email: string;
  estado: EstadoCuentaCorreo;
  ultimoCursor: string | null;
  ultimaRevision: Date | null;
}

export interface NoProcesadoPublico {
  id: string;
  cuentaId: string;
  proveedorCorreo: ProveedorCorreo;
  correoId: string;
  remitente: string;
  asunto?: string;
  recibidoEn: string;
  registradoEn: string;
  motivo: MotivoNoProcesado;
  detalle?: string;
}

export async function guardarFiltroRemitentes(
  db: Db,
  datos: {
    usuarioId: string;
    remitentesPermitidos: string[];
    filtrosActivos: boolean;
    actualizadoEn: Date;
  },
): Promise<void> {
  const normalizados = datos.remitentesPermitidos
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  await db.query(
    `INSERT INTO filtros_remitentes (usuario_id, remitentes_permitidos, filtros_activos, actualizado_en)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (usuario_id) DO UPDATE
       SET remitentes_permitidos = EXCLUDED.remitentes_permitidos,
           filtros_activos = EXCLUDED.filtros_activos,
           actualizado_en = EXCLUDED.actualizado_en
       WHERE filtros_remitentes.actualizado_en <= EXCLUDED.actualizado_en`,
    [datos.usuarioId, normalizados, datos.filtrosActivos, datos.actualizadoEn],
  );
}

export async function obtenerFiltroRemitentes(
  db: Db,
  usuarioId: string,
): Promise<FiltroRemitentesUsuario | null> {
  const res = await db.query<{
    remitentes_permitidos: string[];
    filtros_activos: boolean;
  }>(
    `SELECT remitentes_permitidos, filtros_activos
     FROM filtros_remitentes
     WHERE usuario_id = $1`,
    [usuarioId],
  );
  const fila = res.rows[0];
  if (!fila) return null;
  return {
    remitentesPermitidos: fila.remitentes_permitidos,
    filtrosActivos: fila.filtros_activos,
  };
}

export async function obtenerCuentaParaProcesar(
  db: Db,
  cuentaId: string,
): Promise<CuentaParaProcesar | null> {
  const res = await db.query<{
    id: string;
    usuario_id: string;
    proveedor: string;
    email: string;
    estado: EstadoCuentaCorreo;
    ultimo_cursor: string | null;
    ultima_revision: Date | null;
  }>(
    `SELECT id, usuario_id, proveedor, email, estado, ultimo_cursor, ultima_revision
     FROM cuentas_correo
     WHERE id = $1`,
    [cuentaId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    usuarioId: r.usuario_id,
    proveedor: r.proveedor,
    email: r.email,
    estado: r.estado,
    ultimoCursor: r.ultimo_cursor,
    ultimaRevision: r.ultima_revision,
  };
}

/** Devuelve únicamente los correoId que todavía no figuran en correos_procesados para la cuenta. */
export async function filtrarCorreosPendientes(
  db: Db,
  cuentaId: string,
  correoIds: string[],
): Promise<string[]> {
  if (correoIds.length === 0) return [];
  const res = await db.query<{ correo_id: string }>(
    `SELECT correo_id
     FROM correos_procesados
     WHERE cuenta_id = $1 AND correo_id = ANY($2::text[])`,
    [cuentaId, correoIds],
  );
  const yaVistos = new Set(res.rows.map((r) => r.correo_id));
  return correoIds.filter((id) => !yaVistos.has(id));
}

export interface ResultadoCorreoProcesado {
  cuentaId: string;
  usuarioId: string;
  proveedorCorreo: ProveedorCorreo;
  correoId: string;
  remitente: string;
  asunto: string;
  recibidoEn: Date;
  ahora: Date;
  evento?: Sobre<ReservaDetectadaDatos>;
  validador?: ValidadorEventos;
  noProcesado?: { motivo: MotivoNoProcesado; detalle: string };
}

const REGEX_EMAIL_BASICO = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function normalizarRemitenteNoProcesado(remitente: string): string {
  const limpio = remitente.trim();
  const entreAngulos = /<([^<>]+)>/.exec(limpio);
  const candidato = (entreAngulos?.[1] ?? limpio).trim().toLowerCase();
  return REGEX_EMAIL_BASICO.test(candidato) ? candidato : 'desconocido@remitente.invalid';
}

/**
 * Registra en lote y de forma atómica los correos procesados y guarda (en la misma transacción)
 * sus eventos `ReservaDetectada` en el outbox o sus metadatos en `no_procesados`. Devuelve los
 * `correoId` efectivamente reclamados por esta transacción para garantizar exactamente-una vez.
 */
export async function guardarResultadosCorreosProcesados(
  db: ClienteDb,
  resultados: readonly ResultadoCorreoProcesado[],
): Promise<string[]> {
  if (resultados.length === 0) return [];

  const vistos = new Set<string>();
  const unicos: ResultadoCorreoProcesado[] = [];
  for (const item of resultados) {
    const clave = `${item.cuentaId}\0${item.correoId}`;
    if (!vistos.has(clave)) {
      vistos.add(clave);
      unicos.push(item);
    }
  }

  const marca = await db.query<{ cuenta_id: string; correo_id: string }>(
    `INSERT INTO correos_procesados (cuenta_id, correo_id, procesado_en)
     SELECT u.cuenta_id, u.correo_id, u.procesado_en
     FROM unnest($1::uuid[], $2::text[], $3::timestamptz[])
       AS u(cuenta_id, correo_id, procesado_en)
     ON CONFLICT (cuenta_id, correo_id) DO NOTHING
     RETURNING cuenta_id, correo_id`,
    [unicos.map((r) => r.cuentaId), unicos.map((r) => r.correoId), unicos.map((r) => r.ahora)],
  );
  if (marca.rows.length === 0) return [];

  const recienMarcados = new Set(marca.rows.map((r) => `${r.cuenta_id}\0${r.correo_id}`));
  const nuevos = unicos.filter((r) => recienMarcados.has(`${r.cuentaId}\0${r.correoId}`));

  const noProcesados = nuevos.flatMap((r) =>
    r.noProcesado ? [{ item: r, detalle: r.noProcesado }] : [],
  );
  if (noProcesados.length > 0) {
    await db.query(
      `INSERT INTO no_procesados (
         id, cuenta_id, usuario_id, proveedor_correo, correo_id,
         remitente, asunto, recibido_en, registrado_en, motivo, detalle
       )
       SELECT u.id, u.cuenta_id, u.usuario_id, u.proveedor_correo, u.correo_id,
              u.remitente, u.asunto, u.recibido_en, u.registrado_en, u.motivo, u.detalle
       FROM unnest(
         $1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[],
         $6::text[], $7::text[], $8::timestamptz[], $9::timestamptz[], $10::text[], $11::text[]
       ) AS u(
         id, cuenta_id, usuario_id, proveedor_correo, correo_id,
         remitente, asunto, recibido_en, registrado_en, motivo, detalle
       )
       ON CONFLICT (cuenta_id, correo_id) DO NOTHING`,
      [
        noProcesados.map(() => randomUUID()),
        noProcesados.map(({ item }) => item.cuentaId),
        noProcesados.map(({ item }) => item.usuarioId),
        noProcesados.map(({ item }) => item.proveedorCorreo),
        noProcesados.map(({ item }) => item.correoId),
        noProcesados.map(({ item }) => normalizarRemitenteNoProcesado(item.remitente)),
        noProcesados.map(({ item }) => item.asunto || null),
        noProcesados.map(({ item }) => item.recibidoEn),
        noProcesados.map(({ item }) => item.ahora),
        noProcesados.map(({ detalle }) => detalle.motivo),
        noProcesados.map(({ detalle }) => detalle.detalle || null),
      ],
    );
  }

  for (const item of nuevos) {
    if (item.evento) {
      await guardarEnOutbox(db, item.evento, item.validador);
    }
  }

  return nuevos.map((r) => r.correoId);
}

/**
 * Registra de forma atómica el correo como procesado y guarda (en la misma transacción) o bien
 * el evento ReservaDetectada en el outbox, o bien sus metadatos en no_procesados, o nada si es
 * ignorado. Garantiza que el mismo correo nunca publique dos eventos.
 */
export async function guardarResultadoCorreoProcesado(
  db: ClienteDb,
  datos: ResultadoCorreoProcesado,
): Promise<boolean> {
  const reclamados = await guardarResultadosCorreosProcesados(db, [datos]);
  return reclamados.length > 0;
}

function esCursorNuevoMayor(actual: string | null, nuevo: string): boolean {
  if (!actual) return true;
  if (/^\d+$/.test(actual) && /^\d+$/.test(nuevo)) {
    return BigInt(nuevo) > BigInt(actual);
  }
  const tActual = Date.parse(actual);
  const tNuevo = Date.parse(nuevo);
  if (!Number.isNaN(tActual) && !Number.isNaN(tNuevo)) {
    return tNuevo > tActual;
  }
  return nuevo !== actual;
}

export async function actualizarCursorRevision(
  db: Db,
  datos: {
    cuentaId: string;
    nuevoCursor?: string;
    cursorExpirado?: boolean;
    ahora: Date;
  },
): Promise<void> {
  const res = await db.query<{ ultimo_cursor: string | null; ultima_revision: Date | null }>(
    `SELECT ultimo_cursor, ultima_revision
     FROM cuentas_correo
     WHERE id = $1
     FOR UPDATE`,
    [datos.cuentaId],
  );
  const fila = res.rows[0];
  if (!fila) return;

  const ultimaRevision =
    !fila.ultima_revision || datos.ahora.getTime() > fila.ultima_revision.getTime()
      ? datos.ahora
      : fila.ultima_revision;

  let cursorFinal = fila.ultimo_cursor;
  if (datos.nuevoCursor) {
    if (datos.cursorExpirado || esCursorNuevoMayor(fila.ultimo_cursor, datos.nuevoCursor)) {
      cursorFinal = datos.nuevoCursor;
    }
  }

  await db.query(
    `UPDATE cuentas_correo
     SET ultima_revision = $2,
         ultimo_cursor = $3,
         actualizado_en = $4
     WHERE id = $1`,
    [datos.cuentaId, ultimaRevision, cursorFinal, datos.ahora],
  );
}

export async function listarNoProcesados(
  db: Db,
  filtros: {
    usuarioId: string;
    desde?: Date;
    cuentaId?: string;
    limite: number;
  },
): Promise<{ total: number; noProcesados: NoProcesadoPublico[] }> {
  const condiciones = ['usuario_id = $1'];
  const valores: unknown[] = [filtros.usuarioId];

  if (filtros.desde) {
    valores.push(filtros.desde);
    condiciones.push(`registrado_en >= $${valores.length}`);
  }
  if (filtros.cuentaId) {
    valores.push(filtros.cuentaId);
    condiciones.push(`cuenta_id = $${valores.length}`);
  }

  const where = condiciones.join(' AND ');
  const conteo = await db.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM no_procesados WHERE ${where}`,
    valores,
  );
  const total = Number(conteo.rows[0]?.total ?? 0);

  const valoresLista = [...valores, filtros.limite];
  const lista = await db.query<{
    id: string;
    cuenta_id: string;
    proveedor_correo: string;
    correo_id: string;
    remitente: string;
    asunto: string | null;
    recibido_en: Date;
    registrado_en: Date;
    motivo: MotivoNoProcesado;
    detalle: string | null;
  }>(
    `SELECT id, cuenta_id, proveedor_correo, correo_id, remitente, asunto,
            recibido_en, registrado_en, motivo, detalle
     FROM no_procesados
     WHERE ${where}
     ORDER BY registrado_en DESC, id DESC
     LIMIT $${valoresLista.length}`,
    valoresLista,
  );

  return {
    total,
    noProcesados: lista.rows.map((r) => ({
      id: r.id,
      cuentaId: r.cuenta_id,
      proveedorCorreo: r.proveedor_correo,
      correoId: r.correo_id,
      remitente: r.remitente,
      ...(r.asunto !== null ? { asunto: r.asunto } : {}),
      recibidoEn: r.recibido_en.toISOString(),
      registradoEn: r.registrado_en.toISOString(),
      motivo: r.motivo,
      ...(r.detalle !== null ? { detalle: r.detalle } : {}),
    })),
  };
}
