import { esquemaBase } from '@trotamundos/comun';
// dependencias:inicio
import { z } from 'zod';
// dependencias:fin

/** Variables de entorno de __NOMBRE__ (ver .env.example). Si falta una, el servicio no arranca. */
export const esquemaConfig = esquemaBase.extend({
  // dependencias:inicio
  /** Base propia del servicio (una base por servicio, ADR-001). */
  URL_BASE: z.url(),
  /** RabbitMQ de la región (ADR-002). */
  URL_BROKER: z.url(),
  /** Clave pública del JWT: GET /.well-known/jwks.json de Autenticación de la región (ADR-014). */
  URL_JWKS: z.url(),
  // dependencias:fin
});

export type Config = ReturnType<typeof esquemaConfig.parse>;
