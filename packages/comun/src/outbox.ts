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
 * Publicador del outbox: cada 500 ms envía al broker los eventos pendientes y los marca como
 * enviados. Los de una vuelta salen todos juntos, en el orden de la tabla, y después se espera la
 * confirmación de cada uno (esperarlas de a una limitaba el outbox a unos 43 eventos por segundo,
 * docs/mediciones.md, QA-5). Solo se marcan los confirmados: si el broker falla con alguno, ese
 * queda para la vuelta siguiente (y puede llegar después de otros más nuevos). Si la vuelta vino
 * llena, la siguiente empieza enseguida, sin esperar los 500 ms. Con varias instancias, FOR UPDATE
 * SKIP LOCKED evita que dos envíen el mismo evento a la vez; si igual se repite, los consumidores
 * lo ignoran.
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
      const resultados = await Promise.allSettled(rows.map((fila) => broker.publicar(fila.sobre)));
      const enviados: string[] = [];
      const fallidos: { eventId: string; error: unknown }[] = [];
      resultados.forEach((resultado, i) => {
        const fila = rows[i];
        if (!fila) return;
        if (resultado.status === 'fulfilled') enviados.push(fila.id);
        else fallidos.push({ eventId: fila.sobre.eventId, error: resultado.reason });
      });
      if (fallidos[0]) {
        logger.warn(
          { err: fallidos[0].error, eventId: fallidos[0].eventId, cantidad: fallidos.length },
          'No se pudo publicar desde el outbox',
        );
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

  function programar(esperaMs: number) {
    if (detenido) return;
    temporizador = setTimeout(() => {
      vueltaActual = publicarPendientes()
        // Vuelta llena: puede haber más pendientes, se sigue sin esperar.
        .then((enviados) => (enviados >= lote ? 0 : intervaloMs))
        .catch((error: unknown) => {
          logger.warn({ err: error }, 'Falló la vuelta del outbox');
          return intervaloMs;
        })
        .then(programar);
    }, esperaMs);
  }
  programar(intervaloMs);

  return {
    publicarPendientes,
    async detener() {
      detenido = true;
      clearTimeout(temporizador);
      await vueltaActual;
    },
  };
}
