import { esquemaBase, REGIONES } from '@trotamundos/comun';
import { z } from 'zod';

/**
 * Variables de entorno del enrutador global (ver .env.example). No es de ninguna región, así que
 * no lleva REGION. Si falta una, no arranca.
 */
export const esquemaConfig = esquemaBase.omit({ REGION: true }).extend({
  PUERTO: z.coerce.number().int().min(1).max(65535).default(8000),
  /** nginx de cada región, por la red global (Iteración 6). */
  URL_REGION_1: z.url(),
  URL_REGION_2: z.url(),
  /** Región para las solicitudes sin JWT ni X-Region (en la wiki, la más cercana). */
  REGION_POR_DEFECTO: z.enum(REGIONES).default('region-1'),
  /** Tiempo máximo para que responda la región. Más que el del gateway (2 s, asistente 5 s). */
  TIEMPO_MAXIMO_MS: z.coerce.number().int().positive().default(10_000),
  /** Tamaño máximo del cuerpo del login y el registro, que se leen enteros para reenviar el 307. */
  LIMITE_CUERPO: z
    .string()
    .regex(/^\d+(b|kb|mb)$/i, 'Tiene que ser un tamaño como 1mb o 500kb')
    .default('1mb'),
});

export type Config = ReturnType<typeof esquemaConfig.parse>;
