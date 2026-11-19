import { z } from 'zod';

export const esquemaConfig = z.object({
  PUERTO: z.coerce.number().int().min(1).max(65535).default(4006),
  NIVEL_LOG: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  API_KEY: z.string().min(8).default('cambiar-clave-api-agencia'),
});

export type Config = ReturnType<typeof esquemaConfig.parse>;
