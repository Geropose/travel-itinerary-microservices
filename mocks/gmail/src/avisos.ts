// Avisos push con el formato de Cloud Pub/Sub (specs/externos/gmail.md, sección 6). El mock no tiene
// Pub/Sub: cada tópico de `watch` tiene configurada por entorno la URL de su suscripción push.
//
// Como Gmail y Pub/Sub:
// - como máximo un aviso por segundo por buzón (si entran varios correos juntos, va uno solo con el
//   historyId más nuevo);
// - si la URL responde un error o tarda demasiado, reintenta más tarde con espera exponencial
//   (enviador de mocks/comun).
import type { Logger } from '@trotamundos/comun';
import { crearEnviador } from '@trotamundos/mocks-comun';

export interface OpcionesAvisos {
  /** Tópico de Pub/Sub → URL de su suscripción push. */
  suscripciones: Map<string, string>;
  logger: Logger;
  reloj?: () => number;
  /** Tiempo mínimo entre dos avisos del mismo buzón (Gmail: 1 s). */
  intervaloMs?: number;
  reintentos?: number;
  /** Espera antes del primer reintento; se duplica en cada uno. */
  esperaMs?: number;
  /** Tiempo máximo para que responda la URL de avisos. */
  tiempoMaximoMs?: number;
}

export interface Avisos {
  /** Pide un aviso para el buzón: sale ahora o, si salió uno hace menos de 1 s, al cumplirse. */
  avisar(email: string, historyId: number, topicName: string): void;
  /** Cuerpo del aviso, como lo manda Pub/Sub. */
  cuerpo(email: string, historyId: number, topicName: string): CuerpoPush;
  detener(): void;
}

export interface CuerpoPush {
  message: {
    data: string;
    messageId: string;
    message_id: string;
    publishTime: string;
    publish_time: string;
  };
  subscription: string;
}

/** Nombre de la suscripción push de un tópico: projects/p/topics/t → projects/p/subscriptions/t-push. */
export const suscripcionDe = (topicName: string) =>
  `${topicName.replace('/topics/', '/subscriptions/')}-push`;

/** Lee "tópico=url,tópico=url" (variable SUSCRIPCIONES_PUSH). */
export function leerSuscripciones(texto: string): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const entrada of texto.split(',')) {
    const igual = entrada.indexOf('=');
    if (igual > 0) mapa.set(entrada.slice(0, igual).trim(), entrada.slice(igual + 1).trim());
  }
  return mapa;
}

export function crearAvisos({
  suscripciones,
  logger,
  reloj = Date.now,
  intervaloMs = 1000,
  reintentos,
  esperaMs,
  tiempoMaximoMs,
}: OpcionesAvisos): Avisos {
  // Pub/Sub nunca repite un messageId. El Servicio de Correo guarda los que ya vio (en su base, que
  // sigue entre arranques) y descarta los repetidos: si el mock empezara siempre desde el mismo
  // número, después de reiniciarlo los primeros avisos se descartarían y sus correos no se leerían.
  // Por eso se empieza desde la hora de arranque (en ms, por 1000): 16 dígitos, como los de Pub/Sub.
  let numero = reloj() * 1000;
  const ultimoEnvio = new Map<string, number>();
  const pendientes = new Map<string, { historyId: number; topicName: string }>();
  const enviador = crearEnviador({
    logger,
    ...(reintentos === undefined ? {} : { reintentos }),
    ...(esperaMs === undefined ? {} : { esperaMs }),
    ...(tiempoMaximoMs === undefined ? {} : { tiempoMaximoMs }),
  });

  function cuerpo(email: string, historyId: number, topicName: string): CuerpoPush {
    numero += 1;
    const publicado = new Date(reloj()).toISOString();
    // La guía de Pub/Sub dice base64 (con + y /); el adaptador acepta también base64url.
    const data = Buffer.from(
      JSON.stringify({ emailAddress: email, historyId: String(historyId) }),
    ).toString('base64');
    return {
      message: {
        data,
        messageId: String(numero),
        message_id: String(numero),
        publishTime: publicado,
        publish_time: publicado,
      },
      subscription: suscripcionDe(topicName),
    };
  }

  function salir(email: string) {
    const pendiente = pendientes.get(email);
    if (!pendiente) return;
    pendientes.delete(email);
    const url = suscripciones.get(pendiente.topicName);
    if (!url) {
      logger.warn('tópico sin suscripción push: aviso descartado');
      return;
    }
    ultimoEnvio.set(email, Date.now());
    // El mismo aviso (mismo messageId) en cada reintento, como Pub/Sub.
    enviador.enviar(url, cuerpo(email, pendiente.historyId, pendiente.topicName));
  }

  return {
    cuerpo,
    avisar(email, historyId, topicName) {
      const yaEsperaba = pendientes.has(email);
      // Si ya había uno esperando, sale uno solo con el historyId más nuevo.
      pendientes.set(email, { historyId, topicName });
      if (yaEsperaba) return;
      const falta = (ultimoEnvio.get(email) ?? -Infinity) + intervaloMs - Date.now();
      if (falta <= 0) salir(email);
      else enviador.programar(falta, () => salir(email));
    },
    detener: () => enviador.detener(),
  };
}
