import type { Broker } from './broker.ts';
import { enTransaccion, type ClienteDb, type Pool } from './db.ts';
import { validadorEventos, type Sobre, type ValidadorEventos } from './eventos.ts';
import type { Logger } from './logger.ts';

/**
 * Guarda el evento en eventos_salientes con el cliente de la transacción del servicio, así el
 * cambio y su evento se guardan juntos (outbox, CONVENCIONES 4.5). Valida el evento antes: un
 * evento inválido hace fallar la transacción en vez de quedar trabado en la tabla.
 */
export async function guardarEnOutbox(
  cliente: ClienteDb,
  sobre: Sobre<unknown>,
  validador: ValidadorEventos = validadorEventos(),
): Promise<void> {
  validador.validar(sobre);
  await cliente.query('INSERT INTO eventos_salientes (event_id, tipo, sobre) VALUES ($1, $2, $3)', [
    sobre.eventId,
    sobre.tipo,
    JSON.stringify(sobre),
  ]);
}

export interface OpcionesPublicadorOutbox {
  pool: Pool;
  broker: Pick<Broker, 'publicar' | 'conectado'>;
  logger: Logger;
  /** Cada cuánto busca eventos pendientes (por defecto 500 ms). */
  intervaloMs?: number;
  /** Cuántos eventos envía como máximo por vuelta (por defecto 100). */
  lote?: number;
}

export interface PublicadorOutbox {
  /** Envía una vuelta de pendientes y devuelve cuántos envió. */
  publicarPendientes(): Promise<number>;
  detener(): Promise<void>;
}

/**
 * Publicador del outbox: cada 500 ms envía al broker los eventos pendientes, en orden, y los marca
 * como enviados. Si el broker falla a mitad de camino, marca los que llegó a enviar y el resto
 * queda para la vuelta siguiente. Con varias instancias, FOR UPDATE SKIP LOCKED evita que dos
 * envíen el mismo evento a la vez; si igual se repite, los consumidores lo ignoran.
 */
export function iniciarPublicadorOutbox(opciones: OpcionesPublicadorOutbox): PublicadorOutbox {
  const { pool, broker, logger, intervaloMs = 500, lote = 100 } = opciones;
  let temporizador: NodeJS.Timeout | undefined;
  let vueltaActual: Promise<unknown> = Promise.resolve();
  let detenido = false;

  async function publicarPendientes(): Promise<number> {
    if (!broker.conectado()) return 0;
    return enTransaccion(pool, async (cliente) => {
      const { rows } = await cliente.query<{ id: string; sobre: Sobre<unknown> }>(
        `SELECT id, sobre FROM eventos_salientes
          WHERE enviado_en IS NULL
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [lote],
      );
      const enviados: string[] = [];
      for (const fila of rows) {
        try {
          await broker.publicar(fila.sobre);
          enviados.push(fila.id);
        } catch (error) {
          logger.warn(
            { err: error, eventId: fila.sobre.eventId },
            'No se pudo publicar desde el outbox',
          );
          break;
        }
      }
      if (enviados.length > 0) {
        await cliente.query(
          'UPDATE eventos_salientes SET enviado_en = now() WHERE id = ANY($1::bigint[])',
          [enviados],
        );
      }
      return enviados.length;
    });
  }

  function programar() {
    if (detenido) return;
    temporizador = setTimeout(() => {
      vueltaActual = publicarPendientes()
        .catch((error: unknown) => logger.warn({ err: error }, 'Falló la vuelta del outbox'))
        .finally(programar);
    }, intervaloMs);
  }
  programar();

  return {
    publicarPendientes,
    async detener() {
      detenido = true;
      clearTimeout(temporizador);
      await vueltaActual;
    },
  };
}
