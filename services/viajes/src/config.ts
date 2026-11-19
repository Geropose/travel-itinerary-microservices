import { esquemaBase } from '@trotamundos/comun';
import { z } from 'zod';
import { esCronValido } from './archivado.ts';

/** Variables de entorno de viajes (ver .env.example). Si falta una, el servicio no arranca. */
export const esquemaConfig = esquemaBase.extend({
  /** Base propia del servicio (una base por servicio, ADR-001). */
  URL_BASE: z.url(),
  /** Read replica para lecturas del panel (ADR-012). Si falta, lee de URL_BASE. */
  URL_BASE_LECTURA: z.url().optional(),
  /** Cache Redis distribuida para el panel (ADR-011). Si falta, opera sin cache. */
  URL_CACHE: z.url().optional(),
  /** TTL de la cache del panel en segundos (por defecto 600 s = 10 min). */
  TTL_CACHE_PANEL_S: z.coerce.number().int().min(1).default(600),
  /** Timeout por operación contra Redis antes de degradar a la réplica, en ms. */
  TIMEOUT_CACHE_MS: z.coerce.number().int().min(50).default(500),
  /** RabbitMQ de la región (ADR-002). */
  URL_BROKER: z.url(),
  /** Clave pública del JWT: GET /.well-known/jwks.json de Autenticación de la región (ADR-014). */
  URL_JWKS: z.url(),
  /** Servicio de Usuarios de la región para validar designados de itinerarios compartidos (ADR-005). */
  URL_USUARIOS: z.url().default('http://usuarios:3002'),
  /** Servicio de Integraciones de la región para publicar itinerarios en redes sociales (Iteración 3). */
  URL_INTEGRACIONES: z.url().default('http://integraciones:3005'),
  /** Expresión cron (5 campos en UTC) de la tarea nocturna de archivado (Iteración 2, UC-5). */
  CRON_ARCHIVADO: z
    .string()
    .refine(esCronValido, 'CRON_ARCHIVADO debe ser una expresión cron válida de 5 campos.')
    .default('0 3 * * *'),
  /** Cantidad de consumidores en paralelo por cola de eventos (ADR-009). */
  CANTIDAD_CONSUMIDORES: z.coerce.number().int().min(1).max(100).default(4),
  /** Mensajes en vuelo por consumidor en RabbitMQ. */
  PREFETCH_CONSUMIDORES: z.coerce.number().int().min(1).max(100).default(5),
  /** Ventana de agrupación de reservas en un mismo viaje, en horas (por defecto 48 h = 2 días). */
  MARGEN_AGRUPACION_HORAS: z.coerce.number().positive().default(48),
});

export type Config = ReturnType<typeof esquemaConfig.parse>;
