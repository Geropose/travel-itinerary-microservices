import { pino, type DestinationStream, type Logger, type LevelWithSilent } from 'pino';
import { contextoActual } from './contexto.ts';

export type { Logger } from 'pino';

export interface OpcionesLogger {
  servicio: string;
  region: string;
  nivel?: LevelWithSilent;
  /** Destino de las líneas (por defecto la salida estándar). Las pruebas pasan uno propio. */
  destino?: DestinationStream;
}

/**
 * Logger JSON (pino). Cada línea lleva servicio, region y, dentro de una solicitud, su requestId
 * (CONVENCIONES 4.3). Nunca escribe el token: el encabezado Authorization se oculta.
 */
export function crearLogger({ servicio, region, nivel = 'info', destino }: OpcionesLogger): Logger {
  const opciones = {
    level: nivel,
    base: { servicio, region },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'mensaje',
    formatters: { level: (etiqueta: string) => ({ nivel: etiqueta }) },
    mixin: () => {
      const contexto = contextoActual();
      return contexto ? { requestId: contexto.requestId } : {};
    },
    redact: ['token', 'headers.authorization', '*.headers.authorization'],
  };
  return destino ? pino(opciones, destino) : pino(opciones);
}
