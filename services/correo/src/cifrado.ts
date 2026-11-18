// Cifrado autenticado AES-256-GCM para tokens de correo y firma HMAC-SHA256 del parámetro state
// de OAuth (QA-8, ADR-015).
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { Region } from '@trotamundos/comun';

const PREFIJO_VERSION = 'v1';
const BYTES_CLAVE = 32;
const BYTES_IV = 12;
const BYTES_TAG = 16;
const CONTEXTO_HKDF_STATE = Buffer.from('trotamundos-correo-oauth-state-v1');
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Comprueba que el valor sea una clave de exactamente 32 bytes codificada en base64 válido. */
export function validarClaveTokensBase64(valor: string): boolean {
  const limpio = valor.trim();
  if (!limpio || !BASE64_REGEX.test(limpio)) return false;
  return Buffer.from(limpio, 'base64').length === BYTES_CLAVE;
}

/** Decodifica la clave maestra AES-256 (32 bytes) desde base64; falla si es inválida. */
export function leerClaveTokens(claveBase64: string): Buffer {
  const limpio = claveBase64.trim();
  if (!validarClaveTokensBase64(limpio)) {
    throw new Error('CLAVE_TOKENS_CORREO debe ser una clave AES-256 de 32 bytes en base64.');
  }
  return Buffer.from(limpio, 'base64');
}

/** Deriva una clave dedicada de 32 bytes para firmar `state` OAuth sin reutilizar la clave AES. */
export function derivarClaveState(claveMaestra: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', claveMaestra, Buffer.alloc(0), CONTEXTO_HKDF_STATE, BYTES_CLAVE),
  );
}

/**
 * Cifra un texto con AES-256-GCM usando un IV aleatorio de 96 bits por operación.
 * El `aad` autentica el contexto (por ejemplo usuarioId) para impedir intercambio entre filas.
 */
export function encriptarTexto(clave: Buffer, textoPlano: string, aad?: string): string {
  if (clave.length !== BYTES_CLAVE) throw new Error('La clave AES-256-GCM debe medir 32 bytes.');
  const iv = randomBytes(BYTES_IV);
  const cipher = createCipheriv('aes-256-gcm', clave, iv, { authTagLength: BYTES_TAG });
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const cifrado = Buffer.concat([cipher.update(textoPlano, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIJO_VERSION}.${iv.toString('base64url')}.${tag.toString('base64url')}.${cifrado.toString('base64url')}`;
}

/** Descifra un texto cifrado con `encriptarTexto` y verifica integridad + `aad`. */
export function desencriptarTexto(clave: Buffer, paquete: string, aad?: string): string {
  if (clave.length !== BYTES_CLAVE) throw new Error('La clave AES-256-GCM debe medir 32 bytes.');
  const partes = paquete.split('.');
  if (partes.length !== 4 || partes[0] !== PREFIJO_VERSION) {
    throw new Error('Formato de token cifrado inválido.');
  }
  const [, ivB64, tagB64, cifradoB64] = partes;
  if (!ivB64 || !tagB64 || !cifradoB64) throw new Error('Token cifrado incompleto.');
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const cifrado = Buffer.from(cifradoB64, 'base64url');
  if (iv.length !== BYTES_IV || tag.length !== BYTES_TAG) {
    throw new Error('IV o tag de autenticación inválidos.');
  }
  const decipher = createDecipheriv('aes-256-gcm', clave, iv, { authTagLength: BYTES_TAG });
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cifrado), decipher.final()]).toString('utf8');
}

export interface DatosStateOAuth {
  nonce: string;
  usuarioId: string;
  region: Region;
  proveedor: string;
  venceEn: number;
}

/** Firma un `state` OAuth con HMAC-SHA256 para prevenir CSRF y alteraciones. */
export function firmarState(claveState: Buffer, datos: DatosStateOAuth): string {
  const carga = Buffer.from(JSON.stringify(datos), 'utf8').toString('base64url');
  const firma = createHmac('sha256', claveState).update(carga).digest('base64url');
  return `${carga}.${firma}`;
}

/**
 * Verifica firma HMAC-SHA256, región y expiración de un `state` OAuth.
 * Devuelve null si fue alterado, es de otra región o venció.
 */
export function verificarState(
  claveState: Buffer,
  state: string,
  regionEsperada: Region,
  ahoraMs: number = Date.now(),
): DatosStateOAuth | null {
  const partes = state.split('.');
  if (partes.length !== 2) return null;
  const [carga, firmaRecibida] = partes;
  if (!carga || !firmaRecibida) return null;

  const firmaEsperada = createHmac('sha256', claveState).update(carga).digest();
  const recibida = Buffer.from(firmaRecibida, 'base64url');
  if (recibida.length !== firmaEsperada.length || !timingSafeEqual(recibida, firmaEsperada)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(carga, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const d = parsed as Record<string, unknown>;
  if (
    typeof d.nonce !== 'string' ||
    !d.nonce ||
    typeof d.usuarioId !== 'string' ||
    !d.usuarioId ||
    d.region !== regionEsperada ||
    typeof d.proveedor !== 'string' ||
    !d.proveedor ||
    typeof d.venceEn !== 'number' ||
    !Number.isFinite(d.venceEn) ||
    d.venceEn <= ahoraMs
  ) {
    return null;
  }

  return {
    nonce: d.nonce,
    usuarioId: d.usuarioId,
    region: regionEsperada,
    proveedor: d.proveedor,
    venceEn: d.venceEn,
  };
}
