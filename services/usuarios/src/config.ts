import { esquemaBase } from '@trotamundos/comun';
import { z } from 'zod';

/** Variables de entorno de usuarios (ver .env.example). Si falta una, el servicio no arranca. */
export const esquemaConfig = esquemaBase.extend({
  /** Base propia del servicio (una base por servicio, ADR-001). */
  URL_BASE: z.url(),
  /** RabbitMQ de la región (ADR-002). */
  URL_BROKER: z.url(),
  /** Clave pública del JWT: GET /.well-known/jwks.json de Autenticación de la región (ADR-014). */
  URL_JWKS: z.url(),
  /** Servicio de Viajes de la región, para verificar el dueño de un itinerario. */
  URL_VIAJES: z.url().default('http://viajes:3004'),
  /** Lista separada por comas de identificadores de agencias configuradas en Integraciones. */
  AGENCIAS_CONFIGURADAS: z.string().default('viajes-del-plata'),
});

export type Config = ReturnType<typeof esquemaConfig.parse>;

/** Parsea la lista separada por comas de agencias configuradas. */
export function parsearAgencias(lista: string): Set<string> {
  return new Set(
    lista
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
  );
}
