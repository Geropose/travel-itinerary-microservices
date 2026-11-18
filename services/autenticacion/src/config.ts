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
});

export type Config = ReturnType<typeof esquemaConfig.parse>;
