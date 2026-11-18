import { z } from 'zod';

export const REGIONES = ['region-1', 'region-2'] as const;
export type Region = (typeof REGIONES)[number];

/** Variables que tienen todos los servicios (CONVENCIONES 4.3). Cada servicio le suma las suyas. */
export const esquemaBase = z.object({
  REGION: z.enum(REGIONES),
  PUERTO: z.coerce.number().int().min(1).max(65535),
  NIVEL_LOG: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface OpcionesCargarConfig {
  /** Variables de donde leer (por defecto process.env). */
  env?: Record<string, string | undefined>;
  /** Qué hacer si la configuración es inválida (por defecto termina el proceso con código 1). */
  salir?: (codigo: number) => never;
  /** Dónde escribir el error (por defecto la salida de errores). */
  escribir?: (texto: string) => void;
}

/**
 * Lee y valida la configuración al arrancar. Si falta una variable o tiene un valor inválido,
 * escribe un error claro con todas las variables mal configuradas y el proceso termina: un
 * servicio mal configurado no arranca.
 */
export function cargarConfig<E extends z.ZodType>(
  esquema: E,
  opciones: OpcionesCargarConfig = {},
): z.infer<E> {
  const {
    env = process.env,
    salir = (codigo: number) => process.exit(codigo),
    escribir = (texto: string) => {
      process.stderr.write(texto);
    },
  } = opciones;
  const resultado = esquema.safeParse(env);
  if (resultado.success) return resultado.data;
  const lineas = resultado.error.issues.map((p) => {
    const variable = p.path.join('.') || '(general)';
    return `  - ${variable}: ${p.message}`;
  });
  escribir(`Configuración inválida, el servicio no arranca:\n${lineas.join('\n')}\n`);
  return salir(1);
}
