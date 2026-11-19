import { esquemaBase } from '@trotamundos/comun';
import { z } from 'zod';

/** Variables de entorno de integraciones (ver .env.example). Si falta una, el servicio no arranca. */
export const esquemaConfig = esquemaBase.extend({
  /** Base propia del servicio (una base por servicio, ADR-001). */
  URL_BASE: z.url(),
  /** RabbitMQ de la región (ADR-002). */
  URL_BROKER: z.url(),
  /** Clave pública del JWT: GET /.well-known/jwks.json de Autenticación de la región (ADR-014). */
  URL_JWKS: z.url(),
  /** Ruta opcional al archivo YAML de proveedores (por defecto config/proveedores.yaml). */
  RUTA_CONFIG_PROVEEDORES: z.string().min(1).optional(),
  /** Intervalo global de consulta para proveedores sin aviso (segundos; por defecto 120 s). */
  INTERVALO_CONSULTA_PROVEEDORES_SEG: z.coerce.number().positive().default(120),
  /** Ventana hacia atrás al inicializar el cursor de un proveedor de consulta (segundos). */
  VENTANA_INICIAL_CONSULTA_SEG: z.coerce.number().nonnegative().default(300),
  /** Proveedores externos: defaults pensados para Docker (red global) y desarrollo local. */
  URL_AEROLINEA: z.url().default('http://mock-aerolinea:4003'),
  CLAVE_API_AEROLINEA: z.string().min(1).default('cambiar-clave-api-aerolinea'),
  SECRETO_WEBHOOK_AEROLINEA: z.string().min(1).default('cambiar-secreto-webhook-aerolinea'),
  URL_HOTEL: z.url().default('http://mock-hotel:4004'),
  CLAVE_API_HOTEL: z.string().min(1).default('cambiar-clave-api-hotel'),
  INTERVALO_CONSULTA_HOTEL_SEG: z.coerce.number().positive().optional(),
  URL_RENTADORA: z.url().default('http://mock-rentadora:4005'),
  CLAVE_API_RENTADORA: z.string().min(1).default('cambiar-clave-api-rentadora'),
  INTERVALO_CONSULTA_RENTADORA_SEG: z.coerce.number().positive().optional(),
  URL_AGENCIA: z.url().default('http://mock-agencia:4006'),
  CLAVE_API_AGENCIA: z.string().min(1).default('cambiar-clave-api-agencia'),
  URL_REDSOCIAL: z.url().default('http://mock-redsocial:4007'),
  TOKEN_REDSOCIAL: z.string().min(1).default('cambiar-token-redsocial'),
});

export type Config = ReturnType<typeof esquemaConfig.parse>;
