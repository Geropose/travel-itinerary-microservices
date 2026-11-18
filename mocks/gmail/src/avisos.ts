// Avisos push con el formato de Cloud Pub/Sub (specs/externos/gmail.md, sección 6). El mock no tiene
// Pub/Sub: cada tópico de `watch` tiene configurada por entorno la URL de su suscripción push.
//
// Como Gmail y Pub/Sub:
// - como máximo un aviso por segundo por buzón (si entran varios correos juntos, va uno solo con el
//   historyId más nuevo);
// - si la URL responde un error o tarda demasiado, reintenta más tarde con espera exponencial.
import type { Logger } from '@trotamundos/comun';

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
  reintentos = 5,
  esperaMs = 1000,
  tiempoMaximoMs = 10_000,
}: OpcionesAvisos): Avisos {
  let numero = 2_070_443_601_311_540;
  const ultimoEnvio = new Map<string, number>();
  const pendientes = new Map<string, { historyId: number; topicName: string }>();
  const temporizadores = new Set<NodeJS.Timeout>();

  function esperar(ms: number, accion: () => void) {
    const t = setTimeout(() => {
      temporizadores.delete(t);
      accion();
    }, ms);
    temporizadores.add(t);
  }

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

  async function enviar(url: string, datos: CuerpoPush, intento: number): Promise<void> {
    let estado = 0;
    try {
      const respuesta = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(datos),
        signal: AbortSignal.timeout(tiempoMaximoMs),
      });
      estado = respuesta.status;
      await respuesta.body?.cancel();
    } catch {
      // Sin respuesta (error de red o tiempo máximo): se reintenta como un error.
    }
    if (estado >= 200 && estado < 300) return;
    if (intento >= reintentos) {
      logger.warn({ estado, intentos: intento + 1 }, 'aviso push descartado');
      return;
    }
    // El mismo aviso (mismo messageId), como Pub/Sub cuando no recibe la confirmación.
    esperar(esperaMs * 2 ** intento, () => void enviar(url, datos, intento + 1));
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
    void enviar(url, cuerpo(email, pendiente.historyId, pendiente.topicName), 0);
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
      else esperar(falta, () => salir(email));
    },
    detener() {
      for (const t of temporizadores) clearTimeout(t);
      temporizadores.clear();
    },
  };
}
