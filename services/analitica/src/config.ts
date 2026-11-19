import { esquemaBase } from '@trotamundos/comun';
import { z } from 'zod';

/** Variables de entorno de analitica (ver .env.example). Si falta una, el servicio no arranca. */
export const esquemaConfig = esquemaBase.extend({
  /** Base regional del servicio (idempotencia de eventos consumidos de su región, ADR-001). */
  URL_BASE: z.url(),
  /** Base global de analítica (histórico anonimizado particionado de todas las regiones, ADR-016). */
  URL_BASE_ANALITICA: z.url().optional(),
  /** Secreto regional para HMAC-SHA256(numeroReserva, SECRETO_ANALITICA). Nunca sale de la región. */
  SECRETO_ANALITICA: z.string().min(16),
  /** RabbitMQ de la región (ADR-002). */
  URL_BROKER: z.url(),
  /** Clave pública del JWT: GET /.well-known/jwks.json de Autenticación de la región (ADR-014). */
  URL_JWKS: z.url(),
  /** Cantidad de consumidores en paralelo del anonimizador sobre ViajeActualizado. */
  CANTIDAD_CONSUMIDORES: z.coerce.number().int().min(1).max(50).default(2),
  /** Mensajes en vuelo por consumidor en RabbitMQ. */
  PREFETCH_CONSUMIDORES: z.coerce.number().int().min(1).max(100).default(10),
});

export type Config = ReturnType<typeof esquemaConfig.parse>;
