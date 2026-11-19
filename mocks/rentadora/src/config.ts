import { z } from 'zod';

const booleano = z
  .enum(['true', 'false'])
  .default('true')
  .transform((v) => v === 'true');

export const esquemaConfig = z.object({
  PUERTO: z.coerce.number().int().min(1).max(65535).default(4005),
  NIVEL_LOG: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  API_KEY: z.string().min(8).default('cambiar-clave-api-rentadora'),
  SEMILLAS: booleano,
});

export type Config = ReturnType<typeof esquemaConfig.parse>;
