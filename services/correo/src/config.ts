import { esquemaBase } from '@trotamundos/comun';
import { z } from 'zod';
import { validarClaveTokensBase64 } from './cifrado.ts';

/** Variables de entorno de correo (ver .env.example). Si falta una, el servicio no arranca. */
export const esquemaConfig = esquemaBase.extend({
  /** Base propia del servicio (una base por servicio, ADR-001). */
  URL_BASE: z.url(),
  /** RabbitMQ de la región (ADR-002). */
  URL_BROKER: z.url(),
  /** Clave pública del JWT: GET /.well-known/jwks.json de Autenticación de la región (ADR-014). */
  URL_JWKS: z.url(),
  /** Clave AES-256 en base64 (32 bytes) para cifrar tokens de correo en la base (ADR-015). */
  CLAVE_TOKENS_CORREO: z
    .string()
    .refine(
      validarClaveTokensBase64,
      'Debe ser una clave AES-256 válida de 32 bytes codificada en base64',
    ),
  /** Origen público de la aplicación web, destino del redirect después de /oauth/callback. */
  URL_WEB: z.url().default('http://localhost:5173'),
  /** redirect_uri enviado en OAuth; por defecto usa la ruta del enrutador global para la región. */
  URL_CALLBACK_OAUTH: z.url().optional(),
  /** URL base de la API del proveedor Gmail (en Docker, http://mock-gmail:4001). */
  URL_GMAIL: z.url().default('http://mock-gmail:4001'),
  /** URL pública para abrir la pantalla de permiso de Gmail desde el navegador. */
  URL_PUBLICA_GMAIL: z.url().optional(),
  ID_CLIENTE_GMAIL: z.string().min(1).default('trotamundos-local.apps.googleusercontent.com'),
  SECRETO_CLIENTE_GMAIL: z.string().min(1).default('cambiar-secreto-cliente-gmail'),
  /** Tópico Pub/Sub para users.watch; por defecto usa el tópico configurado para la región. */
  TOPICO_GMAIL: z.string().min(1).optional(),
  /** Secreto compartido en la URL ?token= de Pub/Sub hacia POST /notificaciones/gmail. */
  SECRETO_AVISOS_GMAIL: z.string().min(16).default('cambiar-secreto-avisos-gmail'),
  /** Nombre esperado del campo `subscription` en el cuerpo de avisos Pub/Sub de Gmail. */
  SUSCRIPCION_GMAIL: z.string().min(1).optional(),
  /** URL base de la API del proveedor Outlook (en Docker, http://mock-outlook:4002). */
  URL_OUTLOOK: z.url().default('http://mock-outlook:4002'),
  /** URL pública para abrir la pantalla de permiso de Outlook desde el navegador. */
  URL_PUBLICA_OUTLOOK: z.url().optional(),
  ID_CLIENTE_OUTLOOK: z.string().min(1).default('11112222-bbbb-3333-cccc-4444dddd5555'),
  SECRETO_CLIENTE_OUTLOOK: z.string().min(1).default('cambiar-secreto-cliente-outlook'),
  /** URL donde Microsoft Graph valida la suscripción y entrega change notifications. */
  URL_AVISOS_OUTLOOK: z.url().optional(),
  /** Segundos de anticipación antes del vencimiento para renovar el access token. */
  MARGEN_RENOVACION_SEG: z.coerce.number().int().min(0).default(300),
  /** Servicios internos de la región para token de servicio y consulta de viajes próximos. */
  URL_AUTENTICACION: z.url().default('http://autenticacion:3001'),
  URL_VIAJES: z.url().default('http://viajes:3004'),
  SECRETO_SERVICIO_CORREO: z.string().min(1).default('cambiar-secreto-correo'),
  /** Configuración del Examinador (Iteración 2, ADR-010). */
  INTERVALO_EXAMINADOR_SEG: z.coerce.number().int().positive().default(30),
  INTERVALO_VIAJE_PROXIMO_MIN: z.coerce.number().int().positive().default(5),
  INTERVALO_NORMAL_MIN: z.coerce.number().int().positive().default(60),
  DIAS_VIAJE_PROXIMO: z.coerce.number().int().min(1).max(60).default(7),
  CACHE_VIAJES_MIN: z.coerce.number().int().positive().default(10),
  BACKOFF_429_INICIAL_SEG: z.coerce.number().int().positive().default(30),
  BACKOFF_429_MAX_SEG: z.coerce.number().int().positive().default(900),
});

export type Config = ReturnType<typeof esquemaConfig.parse>;

export interface ConfigResueltaAdaptadores {
  urlCallbackOAuth: string;
  suscripcionGmail: string;
  gmail: {
    urlApi: string;
    urlPublica: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    topicoWatch: string;
  };
  outlook: {
    urlApi: string;
    urlPublica: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    urlAvisos: string;
  };
}

/** Resuelve URLs por región y URLs públicas para el navegador a partir de Config. */
export function resolverConfigAdaptadores(config: Config): ConfigResueltaAdaptadores {
  const urlCallbackOAuth =
    config.URL_CALLBACK_OAUTH ?? `http://localhost:8000/${config.REGION}/api/correo/oauth/callback`;
  const urlPublicaGmail =
    config.URL_PUBLICA_GMAIL ??
    (config.URL_GMAIL === 'http://mock-gmail:4001' ? 'http://localhost:4001' : config.URL_GMAIL);
  const urlPublicaOutlook =
    config.URL_PUBLICA_OUTLOOK ??
    (config.URL_OUTLOOK === 'http://mock-outlook:4002'
      ? 'http://localhost:4002'
      : config.URL_OUTLOOK);
  const topicoWatch =
    config.TOPICO_GMAIL ?? `projects/trotamundos/topics/gmail-avisos-${config.REGION}`;
  const suscripcionGmail =
    config.SUSCRIPCION_GMAIL ?? `${topicoWatch.replace('/topics/', '/subscriptions/')}-push`;

  return {
    urlCallbackOAuth,
    suscripcionGmail,
    gmail: {
      urlApi: config.URL_GMAIL,
      urlPublica: urlPublicaGmail,
      clientId: config.ID_CLIENTE_GMAIL,
      clientSecret: config.SECRETO_CLIENTE_GMAIL,
      redirectUri: urlCallbackOAuth,
      topicoWatch,
    },
    outlook: {
      urlApi: config.URL_OUTLOOK,
      urlPublica: urlPublicaOutlook,
      clientId: config.ID_CLIENTE_OUTLOOK,
      clientSecret: config.SECRETO_CLIENTE_OUTLOOK,
      redirectUri: urlCallbackOAuth,
      urlAvisos:
        config.URL_AVISOS_OUTLOOK ??
        `http://enrutador:8000/${config.REGION}/api/correo/notificaciones/outlook`,
    },
  };
}
