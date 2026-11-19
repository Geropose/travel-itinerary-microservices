import { esquemaBase } from '@trotamundos/comun';
import { z } from 'zod';

/** Variables de entorno de asistente (ver .env.example). Si falta una, el servicio no arranca. */
export const esquemaConfig = esquemaBase.extend({
  /** Base propia del servicio (una base por servicio, ADR-001). */
  URL_BASE: z.url(),
  /** RabbitMQ de la región (ADR-002). */
  URL_BROKER: z.url(),
  /** Clave pública del JWT: GET /.well-known/jwks.json de Autenticación de la región (ADR-014). */
  URL_JWKS: z.url(),
  /** Servicios internos de la región usados por los plug-ins (ADR-018, ADR-019). */
  URL_VIAJES: z.url().default('http://viajes:3004'),
  URL_USUARIOS: z.url().default('http://usuarios:3002'),
  URL_INTEGRACIONES: z.url().default('http://integraciones:3005'),
  /** Carpeta de reglas YAML (por defecto services/asistente/config). */
  DIR_REGLAS: z.string().min(1).optional(),
  /** Timeout de servicios internos para degradación controlada (ms; ADR-019: 2 s). */
  TIMEOUT_SERVICIOS_MS: z.coerce.number().int().positive().default(2000),
  /** Umbral de respuesta lenta de reprogramación antes de responder 202 consultando (ms; QA-12: 3 s). */
  UMBRAL_RESPUESTA_LENTA_MS: z.coerce.number().int().positive().default(3000),
  /** Timeout máximo para llamadas de reprogramación hacia proveedores en segundo plano (ms). */
  TIMEOUT_PROVEEDOR_MS: z.coerce.number().int().positive().default(15_000),
});

export type Config = ReturnType<typeof esquemaConfig.parse>;
