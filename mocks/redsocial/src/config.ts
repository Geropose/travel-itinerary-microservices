import { z } from 'zod';

export const esquemaConfig = z.object({
  PUERTO: z.coerce.number().int().min(1).max(65535).default(4007),
  NIVEL_LOG: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  API_TOKEN: z.string().min(8).default('cambiar-token-redsocial'),
  URL_PUBLICA: z.url().default('https://redsocial.example'),
  CUENTA: z.string().min(1).default('trotamundos'),
});

export type Config = ReturnType<typeof esquemaConfig.parse>;
