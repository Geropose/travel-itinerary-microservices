import {
  connect,
  type Channel,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
} from 'amqplib';
import type { Region } from './config.ts';
import { conContexto } from './contexto.ts';
import { enTransaccion, type ClienteDb, type Pool } from './db.ts';
import {
  crearEvento,
  ErrorEventoInvalido,
  validadorEventos,
  type Sobre,
  type TipoEvento,
  type ValidadorEventos,
} from './eventos.ts';
import type { Logger } from './logger.ts';

/** Exchange topic de todos los eventos; la routing key es el nombre del evento (CONVENCIONES 4.5). */
export const EXCHANGE = 'trotamundos.eventos';

/** No hay conexión con el broker en este momento (se está reconectando). */
export class ErrorBrokerNoDisponible extends Error {
  constructor() {
    super('El broker no está disponible');
    this.name = 'ErrorBrokerNoDisponible';
  }
}

export interface OpcionesBroker {
  /** amqp://usuario:clave@rabbitmq:5672 */
  url: string;
  servicio: string;
  region: Region;
  logger: Logger;
  validador?: ValidadorEventos;
  /** Espera inicial y máxima entre intentos de reconexión (por defecto 200 ms y 5 s). */
  reconexion?: { esperaInicialMs?: number; esperaMaximaMs?: number; intentosAlArrancar?: number };
}

export type EfectoPostCommit = () => Promise<void> | void;

export interface OpcionesConsumidor<D> {
  tipo: TipoEvento;
  /** Base del servicio: ahí está eventos_procesados y ahí se aplica el cambio. */
  pool: Pool;
  /**
   * Aplica el evento. Corre dentro de la transacción que guarda el eventId en eventos_procesados:
   * usar el cliente que recibe para que el cambio y la marca se guarden juntos.
   * Si se registra un efecto vía `alConfirmar`, se ejecuta recién después del `COMMIT` (sin bloquear el ack).
   */
  manejar: (
    evento: Sobre<D>,
    cliente: ClienteDb,
    alConfirmar?: (efecto: EfectoPostCommit) => void,
  ) => Promise<void>;
  /** Nombre de la cola (por defecto <servicio>.<tipo>, por ejemplo viajes.ReservaDetectada). */
  cola?: string;
  /** Cuántos mensajes sin confirmar puede tener a la vez (por defecto 10). */
  prefetch?: number;
  /** Esperas antes de cada reintento; después del último va a la DLQ (por defecto 3: 500, 1000 y 2000 ms). */
  esperasReintentoMs?: number[];
}

export interface Broker {
  /** Valida el sobre con ajv y lo publica con confirmación del broker. */
  publicar(sobre: Sobre<unknown>): Promise<void>;
  /** Arma el sobre (eventId, fecha, región del servicio) y lo publica. */
  publicarEvento<D>(tipo: TipoEvento, datos: D): Promise<Sobre<D>>;
  /** Empieza a consumir; se vuelve a suscribir sola después de cada reconexión. */
  consumir<D>(opciones: OpcionesConsumidor<D>): Promise<void>;
  conectado(): boolean;
  /** Para chequeos de /health. Lanza si no hay conexión. */
  verificar(): Promise<void>;
  cerrar(): Promise<void>;
}

const esperar = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));

/** Ejecuta un mensaje de consumidor: valida, corre transacción idempotente, aplica efectos post-commit y confirma. */
export async function procesarMensajeConsumidor<D>(
  canal: Pick<Channel, 'ack' | 'nack'>,
  cola: string,
  mensaje: ConsumeMessage,
  c: OpcionesConsumidor<D>,
  validador: ValidadorEventos,
  logger: Logger,
): Promise<void> {
  const confirmar = (ok: boolean) => {
    try {
      if (ok) canal.ack(mensaje);
      else canal.nack(mensaje, false, false);
    } catch {
      // El canal se cerró (broker caído): el mensaje vuelve a llegar y la idempotencia lo cubre.
    }
  };
  let evento: Sobre<D>;
  try {
    evento = validador.validar<D>(JSON.parse(mensaje.content.toString('utf8')));
    if (evento.tipo !== c.tipo) throw new ErrorEventoInvalido([`se esperaba ${c.tipo}`]);
  } catch (error) {
    logger.error({ err: error, cola }, 'Evento inválido: va a la DLQ sin reintentos');
    confirmar(false);
    return;
  }

  const esperas = c.esperasReintentoMs ?? [500, 1000, 2000];
  for (let intento = 0; ; intento++) {
    const efectosPostCommit: EfectoPostCommit[] = [];
    let repetido: boolean;
    try {
      repetido = await conContexto({ requestId: evento.eventId }, () =>
        enTransaccion(c.pool, async (cliente) => {
          const marca = await cliente.query(
            'INSERT INTO eventos_procesados (event_id, cola) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [evento.eventId, cola],
          );
          if (marca.rowCount === 0) return true;
          await c.manejar(evento, cliente, (efecto) => {
            efectosPostCommit.push(efecto);
          });
          return false;
        }),
      );
    } catch (error) {
      const espera = esperas[intento];
      if (espera === undefined) {
        logger.error(
          { err: error, eventId: evento.eventId, cola, intentos: intento + 1 },
          'El evento falló en todos los intentos: va a la DLQ',
        );
        confirmar(false);
        return;
      }
      logger.warn({ err: error, eventId: evento.eventId, cola, intento: intento + 1 }, 'Reintento');
      await esperar(espera);
      continue;
    }

    if (repetido) {
      logger.info({ eventId: evento.eventId, cola }, 'Evento repetido: se ignora');
    } else if (efectosPostCommit.length > 0) {
      await conContexto({ requestId: evento.eventId }, async () => {
        for (const efecto of efectosPostCommit) {
          try {
            await efecto();
          } catch (errorPostCommit) {
            logger.warn(
              { err: errorPostCommit, eventId: evento.eventId, cola },
              'Falló el efecto posterior al commit (el evento ya quedó confirmado)',
            );
          }
        }
      });
    }
    confirmar(true);
    return;
  }
}

/**
 * Conecta con RabbitMQ (amqplib) con reconexión automática: si se cae el broker, reintenta con
 * espera creciente y, al volver, recrea el exchange, las colas y los consumidores.
 */
export async function conectarBroker(opciones: OpcionesBroker): Promise<Broker> {
  const { url, servicio, region, logger } = opciones;
  const validador = opciones.validador ?? validadorEventos();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cada consumidor tiene su propio tipo de datos
  const consumidores: OpcionesConsumidor<any>[] = [];
  let canalPublicar: ConfirmChannel | undefined;
  let estaConectado = false;
  let cerrando = false;

  async function prepararConsumidor<D>(modelo: ChannelModel, c: OpcionesConsumidor<D>) {
    const cola = c.cola ?? `${servicio}.${c.tipo}`;
    const dlq = `${cola}.dlq`;
    const canal = await modelo.createChannel();
    canal.on('error', (error: Error) => logger.warn({ err: error, cola }, 'Error en el canal'));
    await canal.assertExchange(EXCHANGE, 'topic', { durable: true });
    await canal.assertQueue(dlq, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
    await canal.assertQueue(cola, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        // Lo que se rechaza sin reencolar va a la cola de fallidos.
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': dlq,
      },
    });
    await canal.bindQueue(cola, EXCHANGE, c.tipo);
    await canal.prefetch(c.prefetch ?? 10);
    await canal.consume(cola, (mensaje) => {
      if (mensaje) void procesarMensajeConsumidor(canal, cola, mensaje, c, validador, logger);
    });
  }

  const reconexion = opciones.reconexion ?? {};
  const conexion = await connect(url, {
    recovery: {
      initialDelay: reconexion.esperaInicialMs ?? 200,
      maxDelay: reconexion.esperaMaximaMs ?? 5000,
      maxRetries: Infinity,
      initialMaxRetries: reconexion.intentosAlArrancar ?? 10,
      setup: async (modelo: ChannelModel) => {
        const canal = await modelo.createConfirmChannel();
        canal.on('error', (error: Error) => logger.warn({ err: error }, 'Error en el canal'));
        await canal.assertExchange(EXCHANGE, 'topic', { durable: true });
        for (const c of consumidores) await prepararConsumidor(modelo, c);
        canalPublicar = canal;
      },
    },
  });
  estaConectado = true;
  conexion.on('connect', () => {
    estaConectado = true;
    logger.info('Conectado al broker');
  });
  conexion.on('disconnect', (error: Error) => {
    estaConectado = false;
    canalPublicar = undefined;
    if (!cerrando) logger.warn({ err: error }, 'Se perdió la conexión con el broker: reconectando');
  });
  conexion.on('error', (error: Error) => logger.warn({ err: error }, 'Error en la conexión'));
  conexion.on('reconnect-failed', (error: Error) =>
    logger.error({ err: error }, 'No se pudo reconectar al broker'),
  );

  async function publicar(sobre: Sobre<unknown>): Promise<void> {
    validador.validar(sobre);
    const canal = canalPublicar;
    if (!canal || !estaConectado) throw new ErrorBrokerNoDisponible();
    const contenido = Buffer.from(JSON.stringify(sobre));
    await new Promise<void>((resolver, rechazar) => {
      canal.publish(
        EXCHANGE,
        sobre.tipo,
        contenido,
        {
          persistent: true,
          contentType: 'application/json',
          messageId: sobre.eventId,
          type: sobre.tipo,
          appId: servicio,
        },
        (error: unknown) => (error ? rechazar(error) : resolver()),
      );
    });
  }

  return {
    publicar,
    async publicarEvento<D>(tipo: TipoEvento, datos: D) {
      const sobre = crearEvento(tipo, datos, region);
      await publicar(sobre);
      return sobre;
    },
    async consumir<D>(c: OpcionesConsumidor<D>) {
      consumidores.push(c);
      if (estaConectado) {
        // Los consumidores nuevos se preparan con la conexión actual; los de antes, en cada setup.
        const modelo = { createChannel: () => conexion.createChannel() } as unknown as ChannelModel;
        await prepararConsumidor(modelo, c);
      }
    },
    conectado: () => estaConectado,
    async verificar() {
      if (!estaConectado || !canalPublicar) throw new ErrorBrokerNoDisponible();
    },
    async cerrar() {
      cerrando = true;
      await conexion.close().catch(() => undefined);
    },
  };
}
