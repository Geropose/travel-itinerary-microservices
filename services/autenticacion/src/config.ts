import { esquemaBase } from '@trotamundos/comun';
import { z } from 'zod';

/** Variables de entorno de autenticacion (ver .env.example). Si falta una, el servicio no arranca. */
export const esquemaConfig = esquemaBase.extend({
  /** Base propia del servicio (una base por servicio, ADR-001). */
  URL_BASE: z.url(),
  /** RabbitMQ de la región (ADR-002). */
  URL_BROKER: z.url(),
  /** Clave privada RS256 del JWT de la región, PEM en base64 (ADR-014; npm run infra:secretos). */
  JWT_CLAVE_PRIVADA: z.string().min(1),
  /** Servicio de Usuarios de la región: POST /interna/cuentas en el registro. */
  URL_USUARIOS: z.url(),
  /**
   * Autenticación de la otra región, para GET /interna/cuentas/existe en el login desde un
   * dispositivo nuevo y en el registro (ADR-017).
   */
  URL_OTRA_REGION: z.url(),
  /** JWKS de la otra región: valida los tokens de servicio que manda su Autenticación. */
  URL_JWKS_OTRA_REGION: z.url(),
  /** URL pública de la otra región, para el Location de las respuestas 307. */
  URL_PUBLICA_OTRA_REGION: z.url(),
  /** Límite de intentos de login fallidos por email (QA-8). */
  LOGIN_MAX_INTENTOS: z.coerce.number().int().positive().default(5),
  LOGIN_VENTANA_MINUTOS: z.coerce.number().int().positive().default(15),
});

export type Config = ReturnType<typeof esquemaConfig.parse>;

/**
 * Secretos de los servicios que pueden pedir un token de servicio (SECRETO_SERVICIO_<SERVICIO>,
 * docs/CONVENCIONES.md 4.4). El servicio "pruebas" solo existe si está su variable.
 */
export function secretosDeServicios(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const secretos = new Map<string, string>();
  for (const [clave, valor] of Object.entries(env)) {
    const encontrada = /^SECRETO_SERVICIO_([A-Z]+)$/.exec(clave);
    if (encontrada?.[1] && valor) secretos.set(encontrada[1].toLowerCase(), valor);
  }
  return secretos;
}
