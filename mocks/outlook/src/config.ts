import { esquemaBase } from '@trotamundos/comun';
import { z } from 'zod';

/**
 * Variables de entorno del mock de Outlook (ver .env.example). No es de ninguna región: lo usan las
 * dos, como Microsoft Graph.
 */
export const esquemaConfig = esquemaBase.omit({ REGION: true }).extend({
  PUERTO: z.coerce.number().int().min(1).max(65535).default(4002),
  /** Aplicación registrada (en Microsoft, la de Microsoft Entra). */
  CLIENT_ID: z.string().min(1).default('11112222-bbbb-3333-cccc-4444dddd5555'),
  CLIENT_SECRET: z.string().min(8),
  /** redirect_uri registrados, separados por coma: uno por región, con su prefijo. */
  REDIRECT_URIS: z
    .string()
    .default(
      'http://localhost:8000/region-1/api/correo/oauth/callback,http://localhost:8000/region-2/api/correo/oauth/callback',
    ),
  /** Vida del access token en segundos (Microsoft: alrededor de una hora). */
  VIDA_TOKEN_S: z.coerce.number().int().positive().default(3599),
  /** Solicitudes a Graph por buzón en cada ventana (Outlook: 10.000 cada 10 minutos). */
  LIMITE_SOLICITUDES: z.coerce.number().int().positive().default(10_000),
  VENTANA_LIMITE_S: z.coerce.number().int().positive().default(600),
  /** Si es true, arranca con los 20 buzones de prueba. */
  SEMILLAS: z.stringbool().default(true),
});

export type Config = ReturnType<typeof esquemaConfig.parse>;
