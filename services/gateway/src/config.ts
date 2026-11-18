import { esquemaBase } from '@trotamundos/comun';
import { z } from 'zod';

/** Variables de entorno de gateway (ver .env.example). Si falta una, el servicio no arranca. */
export const esquemaConfig = esquemaBase.extend({
  /** Base registro_accesos de la región: accesos rechazados (Iteración 5, QA-8, QA-9). */
  URL_BASE: z.url(),
  /** RabbitMQ de la región (ADR-002). */
  URL_BROKER: z.url(),
  /** Clave pública del JWT: GET /.well-known/jwks.json de Autenticación de la región (ADR-014). */
  URL_JWKS: z.url(),
  /**
   * JWKS de Autenticación de la otra región. Con él, un JWT de la otra región se reconoce como
   * tal y se responde 403 (CONST-6) en lugar de 401 por firma desconocida.
   */
  URL_JWKS_OTRA_REGION: z.url(),
  /** Único origen al que se le permite CORS: la aplicación web. */
  ORIGEN_WEB: z.url().default('http://localhost:5173'),
  /** Tiempo máximo para que responda el servicio interno (CONVENCIONES 4.3: 2 s). */
  TIEMPO_MAXIMO_MS: z.coerce.number().int().positive().default(2000),
  /** Tamaño máximo del cuerpo de una solicitud (formato de body-parser: 1mb, 500kb...). */
  LIMITE_CUERPO: z
    .string()
    .regex(/^\d+(b|kb|mb)$/i, 'Tiene que ser un tamaño como 1mb o 500kb')
    .default('1mb'),
});

export type Config = ReturnType<typeof esquemaConfig.parse>;
