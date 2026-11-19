import { z } from 'zod';

const booleano = z
  .enum(['true', 'false'])
  .default('true')
  .transform((v) => v === 'true');

export const esquemaConfig = z.object({
  PUERTO: z.coerce.number().int().min(1).max(65535).default(4003),
  NIVEL_LOG: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  API_KEY: z.string().min(8).default('cambiar-clave-api-aerolinea'),
  WEBHOOK_SECRET: z.string().min(8).default('cambiar-secreto-webhook-aerolinea'),
  /** Lista separada por comas de URLs destino de webhooks (por ejemplo, r1 y r2). */
  WEBHOOK_URLS: z.string().default(''),
  SEMILLAS: booleano,
});

export type Config = ReturnType<typeof esquemaConfig.parse>;

export function leerUrlsWebhook(lista: string): string[] {
  return lista
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
}
