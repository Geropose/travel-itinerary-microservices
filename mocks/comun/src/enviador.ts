// Envío de avisos y webhooks con reintentos (Gmail Pub/Sub, Outlook Graph y Aerolínea): si la URL
// responde un error o tarda demasiado, el mismo aviso se reintenta más tarde con espera exponencial.
import type { Logger } from '@trotamundos/comun';

export interface OpcionesEnviador {
  logger: Logger;
  reintentos?: number;
  /** Espera antes del primer reintento; se duplica en cada uno. */
  esperaMs?: number;
  /** Tiempo máximo para que responda la URL de avisos. */
  tiempoMaximoMs?: number;
}

export type HeadersAviso =
  Record<string, string> | ((cuerpoTexto: string) => Record<string, string>);

export interface Enviador {
  /** Manda el aviso (JSON) y lo reintenta si falla. No espera la respuesta. */
  enviar(url: string, cuerpo: unknown, headers?: HeadersAviso): void;
  /** Corre la acción después de `ms` (se cancela con detener). */
  programar(ms: number, accion: () => void): void;
  detener(): void;
}

export function crearEnviador({
  logger,
  reintentos = 5,
  esperaMs = 1000,
  tiempoMaximoMs = 10_000,
}: OpcionesEnviador): Enviador {
  const temporizadores = new Set<NodeJS.Timeout>();

  function programar(ms: number, accion: () => void) {
    const t = setTimeout(() => {
      temporizadores.delete(t);
      accion();
    }, ms);
    temporizadores.add(t);
  }

  async function intentar(
    url: string,
    cuerpo: string,
    headers: HeadersAviso | undefined,
    intento: number,
  ): Promise<void> {
    let estado = 0;
    try {
      const extra = typeof headers === 'function' ? headers(cuerpo) : (headers ?? {});
      const respuesta = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extra },
        body: cuerpo,
        signal: AbortSignal.timeout(tiempoMaximoMs),
      });
      estado = respuesta.status;
      await respuesta.body?.cancel();
    } catch {
      // Sin respuesta (error de red o tiempo máximo): se reintenta como un error.
    }
    if (estado >= 200 && estado < 300) return;
    if (intento >= reintentos) {
      logger.warn({ estado, intentos: intento + 1 }, 'aviso descartado');
      return;
    }
    programar(esperaMs * 2 ** intento, () => void intentar(url, cuerpo, headers, intento + 1));
  }

  return {
    enviar: (url, cuerpo, headers) => void intentar(url, JSON.stringify(cuerpo), headers, 0),
    programar,
    detener() {
      for (const t of temporizadores) clearTimeout(t);
      temporizadores.clear();
    },
  };
}
