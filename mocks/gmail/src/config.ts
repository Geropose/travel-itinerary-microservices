import { esquemaBase } from '@trotamundos/comun';
import { z } from 'zod';

/**
 * Variables de entorno del mock de Gmail (ver .env.example). No es de ninguna región: lo usan las
 * dos, como el Gmail real.
 */
export const esquemaConfig = esquemaBase.omit({ REGION: true }).extend({
  PUERTO: z.coerce.number().int().min(1).max(65535).default(4001),
  /** Cliente OAuth registrado (en Google, el de la consola de Cloud). */
  CLIENT_ID: z.string().min(1).default('trotamundos-local.apps.googleusercontent.com'),
  CLIENT_SECRET: z.string().min(8),
  /** redirect_uri registrados, separados por coma: uno por región, con su prefijo. */
  REDIRECT_URIS: z
    .string()
    .default(
      'http://localhost:8000/region-1/api/correo/oauth/callback,http://localhost:8000/region-2/api/correo/oauth/callback',
    ),
  /** Vida del access token en segundos (Google: alrededor de una hora). */
  VIDA_TOKEN_S: z.coerce.number().int().positive().default(3599),
  /** Unidades por minuto por usuario (Gmail: 6.000). */
  CUOTA_POR_MINUTO: z.coerce.number().int().positive().default(6000),
  /**
   * Suscripciones push de Pub/Sub: "tópico=url" separados por coma. Cada región usa su tópico en
   * users.watch y su URL de avisos (con el prefijo de región y el ?token= secreto).
   */
  SUSCRIPCIONES_PUSH: z.string().default(''),
  /** Si es true, arranca con los 20 buzones de prueba. */
  SEMILLAS: z.stringbool().default(true),
});

export type Config = ReturnType<typeof esquemaConfig.parse>;
