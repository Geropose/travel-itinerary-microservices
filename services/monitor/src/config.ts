import { esquemaBase } from '@trotamundos/comun';
import { z } from 'zod';

/** Variables de entorno de monitor (ver .env.example). Si falta una, el servicio no arranca. */
export const esquemaConfig = esquemaBase.extend({
  /** Proyecto de docker compose de la región (r1 o r2): sus contenedores son los que vigila. */
  PROYECTO_DOCKER: z.string().min(1),
  /** Socket de la API de Docker, montado en el contenedor. */
  SOCKET_DOCKER: z.string().min(1).default('/var/run/docker.sock'),
  /** Cada cuánto hace el ping a cada instancia (ADR-007: 5 s). */
  INTERVALO_PING_MS: z.coerce.number().int().positive().default(5000),
  /** Pings seguidos sin respuesta para marcar caída una instancia (ADR-007: 3, o sea 15 s). */
  FALLAS_PARA_CAIDA: z.coerce.number().int().positive().default(3),
  /** Tiempo máximo de cada ping. */
  TIEMPO_PING_MS: z.coerce.number().int().positive().default(2000),
  /** Tiempo que se le da a una instancia reiniciada para arrancar antes de volver a contar fallas. */
  GRACIA_REINICIO_MS: z.coerce.number().int().positive().default(60_000),
});

export type Config = ReturnType<typeof esquemaConfig.parse>;
