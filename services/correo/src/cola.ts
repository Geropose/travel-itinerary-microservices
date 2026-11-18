// Cola interna de trabajo en RabbitMQ para repartir revisiones de buzones entre procesadores
// en paralelo (Iteración 2, ADR-009). No forma parte del exchange de eventos entre servicios.
import { conContexto, contextoActual, type Logger } from '@trotamundos/comun';
import {
  connect,
  type Channel,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
} from 'amqplib';
import type { ProveedorCorreo } from './adaptadores/tipos.ts';

export const COLA_BUZONES = 'correo.buzones-a-revisar';
const COLA_BUZONES_DLQ = `${COLA_BUZONES}.dlq`;

export type OrigenRevision = 'cuenta-nueva' | 'viaje-proximo' | 'periodica' | 'push';

export interface TrabajoRevisionBuzon {
  trabajoId: string;
  cuentaId: string;
  usuarioId: string;
  proveedor: ProveedorCorreo;
  email: string;
  origen: OrigenRevision;
  /** 1 = máxima (cuenta nueva o push), 2 = viaje próximo (5 min), 3 = resto (60 min). */
  prioridad: 1 | 2 | 3;
  creadoEn: string;
  push?: {
    historyId?: string;
    mensajeIds?: string[];
  };
}

export class ErrorColaNoDisponible extends Error {
  constructor() {
    super('La cola interna de buzones no está disponible.');
    this.name = 'ErrorColaNoDisponible';
  }
}

export interface OpcionesColaBuzones {
  url: string;
  logger: Logger;
  reconexion?: { esperaInicialMs?: number; esperaMaximaMs?: number; intentosAlArrancar?: number };
}

export interface OpcionesConsumidorCola {
  manejar: (trabajo: TrabajoRevisionBuzon) => Promise<void>;
  prefetch?: number;
  esperasReintentoMs?: number[];
}

export interface ColaBuzones {
  encolar(trabajo: TrabajoRevisionBuzon): Promise<void>;
  consumir(opciones: OpcionesConsumidorCola): Promise<void>;
  conectado(): boolean;
  verificar(): Promise<void>;
  cerrar(): Promise<void>;
}

const esperar = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));

async function asegurarColas(canal: Channel): Promise<void> {
  await canal.assertQueue(COLA_BUZONES_DLQ, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await canal.assertQueue(COLA_BUZONES, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': COLA_BUZONES_DLQ,
    },
  });
}

export async function conectarColaBuzones(opciones: OpcionesColaBuzones): Promise<ColaBuzones> {
  const { url, logger } = opciones;
  const consumidores: OpcionesConsumidorCola[] = [];
  let canalPublicar: ConfirmChannel | undefined;
  let estaConectado = false;
  let cerrando = false;

  async function prepararConsumidor(modelo: ChannelModel, c: OpcionesConsumidorCola) {
    const canal = await modelo.createChannel();
    canal.on('error', (err: Error) =>
      logger.warn({ err, cola: COLA_BUZONES }, 'error en canal de cola de buzones'),
    );
    await asegurarColas(canal);
    await canal.prefetch(c.prefetch ?? 10);
    await canal.consume(COLA_BUZONES, (msg) => {
      if (msg) void procesarMensaje(canal, msg, c);
    });
  }

  async function procesarMensaje(
    canal: Channel,
    mensaje: ConsumeMessage,
    c: OpcionesConsumidorCola,
  ) {
    const confirmar = (ok: boolean) => {
      try {
        if (ok) canal.ack(mensaje);
        else canal.nack(mensaje, false, false);
      } catch {
        // Canal cerrado: RabbitMQ reentrega otro trabajador cuando reconecta.
      }
    };

    let trabajo: TrabajoRevisionBuzon;
    try {
      const parsed = JSON.parse(mensaje.content.toString('utf8')) as TrabajoRevisionBuzon;
      if (!parsed.trabajoId || !parsed.cuentaId || !parsed.proveedor) {
        throw new Error('Mensaje de revisión incompleto');
      }
      trabajo = parsed;
    } catch (err) {
      logger.error({ err, cola: COLA_BUZONES }, 'trabajo inválido: va a DLQ');
      confirmar(false);
      return;
    }

    const esperas = c.esperasReintentoMs ?? [500, 1000, 2000];
    for (let intento = 0; ; intento++) {
      try {
        await conContexto({ requestId: trabajo.trabajoId }, () => c.manejar(trabajo));
        confirmar(true);
        return;
      } catch (err) {
        const espera = esperas[intento];
        if (espera === undefined) {
          logger.error(
            { err, trabajoId: trabajo.trabajoId, cuentaId: trabajo.cuentaId },
            'trabajo falló en todos los reintentos: va a DLQ',
          );
          confirmar(false);
          return;
        }
        await esperar(espera);
      }
    }
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
        canal.on('error', (err: Error) =>
          logger.warn({ err, cola: COLA_BUZONES }, 'error en canal publicador de cola'),
        );
        await asegurarColas(canal);
        for (const c of consumidores) await prepararConsumidor(modelo, c);
        canalPublicar = canal;
      },
    },
  });
  estaConectado = true;
  conexion.on('connect', () => {
    estaConectado = true;
  });
  conexion.on('disconnect', () => {
    estaConectado = false;
    canalPublicar = undefined;
    if (!cerrando) logger.warn({ cola: COLA_BUZONES }, 'conexión perdida con cola: reconectando');
  });
  conexion.on('error', (err: Error) =>
    logger.warn({ err, cola: COLA_BUZONES }, 'error en conexión de cola'),
  );

  return {
    async encolar(trabajo) {
      const canal = canalPublicar;
      if (!canal || !estaConectado) throw new ErrorColaNoDisponible();
      const cuerpo = Buffer.from(JSON.stringify(trabajo));
      const requestId = contextoActual()?.requestId;
      await new Promise<void>((resolver, rechazar) => {
        canal.sendToQueue(
          COLA_BUZONES,
          cuerpo,
          {
            persistent: true,
            contentType: 'application/json',
            messageId: trabajo.trabajoId,
            ...(requestId ? { headers: { 'x-request-id': requestId } } : {}),
          },
          (err: unknown) => (err ? rechazar(err) : resolver()),
        );
      });
    },
    async consumir(c) {
      consumidores.push(c);
      if (estaConectado) {
        const modelo = { createChannel: () => conexion.createChannel() } as unknown as ChannelModel;
        await prepararConsumidor(modelo, c);
      }
    },
    conectado: () => estaConectado,
    async verificar() {
      if (!estaConectado || !canalPublicar) throw new ErrorColaNoDisponible();
    },
    async cerrar() {
      cerrando = true;
      await conexion.close().catch(() => undefined);
    },
  };
}
