import type { Broker } from './broker.ts';
import type { ClienteDb, Pool } from './db.ts';
import type { Logger } from './logger.ts';

export type MotivoRechazo = 'sin-token' | 'token-invalido' | 'otra-region' | 'sin-permiso';

/** Un intento rechazado: los mismos campos que los datos del evento AccesoRechazado. */
export interface AccesoRechazado {
  servicio: string;
  metodo: string;
  ruta: string;
  status: 401 | 403;
  motivo: MotivoRechazo;
  usuarioId?: string;
  ip?: string;
  requestId: string;
}

/**
 * Registra un rechazo sin hacer esperar la respuesta (fire-and-forget, QA-9: menos de 1 s). Nunca
 * lanza: si el registro falla, queda en el log y la solicitud sigue.
 */
export type RegistrarRechazo = (rechazo: AccesoRechazado) => void;

/**
 * Registro de los microservicios: publica el evento AccesoRechazado, que el registro de accesos
 * del gateway guarda en accesos_rechazados (CONVENCIONES 4.5 y 4.6).
 */
export function registroPorEvento(
  broker: Pick<Broker, 'publicarEvento'>,
  logger: Logger,
): RegistrarRechazo {
  return (rechazo) => {
    broker.publicarEvento('AccesoRechazado', rechazo).catch((error: unknown) => {
      logger.warn({ err: error, rechazo }, 'No se pudo publicar AccesoRechazado');
    });
  };
}

/** Guarda un rechazo en accesos_rechazados (base registro_accesos). */
export async function guardarAccesoRechazado(
  db: Pool | ClienteDb,
  rechazo: AccesoRechazado,
  fecha: Date = new Date(),
): Promise<void> {
  await db.query(
    `INSERT INTO accesos_rechazados
       (fecha, servicio, metodo, ruta, status, motivo, usuario_id, ip, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      fecha,
      rechazo.servicio,
      rechazo.metodo,
      rechazo.ruta,
      rechazo.status,
      rechazo.motivo,
      rechazo.usuarioId ?? null,
      rechazo.ip ?? null,
      rechazo.requestId,
    ],
  );
}

/**
 * Registro del gateway: guarda sus propios rechazos directo en accesos_rechazados, sin pasar por
 * el broker. También sirve para el consumidor de AccesoRechazado (con guardarAccesoRechazado).
 */
export function registroEnBase(pool: Pool, logger: Logger): RegistrarRechazo {
  return (rechazo) => {
    guardarAccesoRechazado(pool, rechazo).catch((error: unknown) => {
      logger.warn({ err: error, rechazo }, 'No se pudo guardar el acceso rechazado');
    });
  };
}
