// Ping-echo (Iteración 1, ADR-007): cada 5 s un ping a GET /health de cada instancia de la región.
// Con 3 pings seguidos sin 200 (15 s) la marca caída, la reinicia con la API de Docker y lo
// registra en el log. Después del reinicio le da un tiempo de gracia para arrancar.
import type { Logger } from '@trotamundos/comun';
import type { ClienteDocker, Instancia } from './docker.ts';

export type EstadoInstancia = 'sana' | 'sin-respuesta' | 'caida' | 'reiniciando';

export interface EstadoDeInstancia {
  nombre: string;
  servicio: string;
  estado: EstadoInstancia;
  fallasSeguidas: number;
  ultimoPing?: string;
  caidaDetectadaEn?: string;
  reinicios: number;
  ultimoReinicio?: string;
}

/** ¿Responde 200 a GET <url>/health antes del tiempo máximo? */
export type Ping = (url: string, tiempoMs: number) => Promise<boolean>;

export const pingHttp: Ping = async (url, tiempoMs) => {
  try {
    const respuesta = await fetch(`${url}/health`, { signal: AbortSignal.timeout(tiempoMs) });
    await respuesta.body?.cancel();
    return respuesta.status === 200;
  } catch {
    return false;
  }
};

export interface OpcionesVigilante {
  docker: ClienteDocker;
  logger: Logger;
  /** Cada cuánto se hace el ping (ADR-007: 5 s). */
  intervaloMs?: number;
  /** Pings seguidos sin respuesta para marcarla caída (ADR-007: 3, o sea 15 s). */
  fallasParaCaida?: number;
  /** Tiempo máximo de cada ping (menos que el intervalo). */
  tiempoPingMs?: number;
  /** Después de reiniciarla, cuánto se espera a que vuelva antes de contar fallas otra vez. */
  graciaReinicioMs?: number;
  ping?: Ping;
  ahora?: () => Date;
}

interface Seguimiento extends EstadoDeInstancia {
  /** Hasta cuándo no se cuentan fallas (arranque después de un reinicio). */
  graciaHasta?: number;
}

export interface Vigilante {
  /** Un ciclo: lista las instancias y les hace ping a todas a la vez. */
  ciclo(): Promise<void>;
  /** Corre un ciclo cada intervaloMs, sin acumular atraso. */
  iniciar(): void;
  detener(): void;
  estado(): { actualizadoEn: string | null; intervaloMs: number; instancias: EstadoDeInstancia[] };
}

export function crearVigilante(o: OpcionesVigilante): Vigilante {
  const { docker, logger } = o;
  const intervaloMs = o.intervaloMs ?? 5000;
  const fallasParaCaida = o.fallasParaCaida ?? 3;
  const tiempoPingMs = o.tiempoPingMs ?? 2000;
  const graciaMs = o.graciaReinicioMs ?? 60_000;
  const ping = o.ping ?? pingHttp;
  const ahora = o.ahora ?? (() => new Date());
  const seguimiento = new Map<string, Seguimiento>();
  const reiniciandoIds = new Set<string>();
  let actualizadoEn: string | null = null;
  let temporizador: NodeJS.Timeout | undefined;
  let activo = false;

  function reiniciar(inst: Instancia, s: Seguimiento, momento: Date): void {
    if (reiniciandoIds.has(inst.id)) return;
    reiniciandoIds.add(inst.id);
    s.estado = 'reiniciando';
    s.graciaHasta = momento.getTime() + graciaMs;
    s.fallasSeguidas = 0;
    // Sin esperar: un reinicio tarda unos segundos y no puede atrasar el próximo ping.
    docker.reiniciar(inst.id).then(
      () => {
        reiniciandoIds.delete(inst.id);
        s.reinicios++;
        s.ultimoReinicio = momento.toISOString();
        logger.info(
          { instancia: inst.nombre, servicioInstancia: inst.servicio },
          'Instancia reiniciada',
        );
      },
      (error: unknown) => {
        reiniciandoIds.delete(inst.id);
        if (s.estado === 'reiniciando') {
          s.estado = 'caida';
          delete s.graciaHasta;
        }
        logger.error(
          { err: error, instancia: inst.nombre, servicioInstancia: inst.servicio },
          'No se pudo reiniciar la instancia',
        );
      },
    );
  }

  async function revisar(inst: Instancia, momento: Date): Promise<void> {
    let s = seguimiento.get(inst.id);
    if (!s) {
      s = {
        nombre: inst.nombre,
        servicio: inst.servicio,
        estado: 'sana',
        fallasSeguidas: 0,
        reinicios: 0,
      };
      seguimiento.set(inst.id, s);
    }
    const responde = inst.url !== undefined && (await ping(inst.url, tiempoPingMs));
    s.ultimoPing = momento.toISOString();
    if (responde) {
      if (s.estado !== 'sana' && s.estado !== 'sin-respuesta') {
        logger.info(
          { instancia: inst.nombre, servicioInstancia: inst.servicio },
          'La instancia volvió',
        );
      }
      s.estado = 'sana';
      s.fallasSeguidas = 0;
      delete s.graciaHasta;
      return;
    }
    // Recién reiniciada: todavía está arrancando, no se cuenta como falla.
    if (s.graciaHasta !== undefined && momento.getTime() < s.graciaHasta) return;
    delete s.graciaHasta;
    s.fallasSeguidas++;
    if (s.fallasSeguidas < fallasParaCaida) {
      s.estado = 'sin-respuesta';
      return;
    }
    s.estado = 'caida';
    s.caidaDetectadaEn = momento.toISOString();
    logger.warn(
      {
        instancia: inst.nombre,
        servicioInstancia: inst.servicio,
        fallasSeguidas: s.fallasSeguidas,
        corriendo: inst.corriendo,
      },
      'Instancia caída: se reinicia',
    );
    reiniciar(inst, s, momento);
  }

  async function ciclo(): Promise<void> {
    const momento = ahora();
    let instancias: Instancia[];
    try {
      instancias = await docker.listar();
    } catch (error) {
      logger.error({ err: error }, 'No se pudo consultar a Docker');
      return;
    }
    // Las instancias que ya no existen (por ejemplo, al escalar hacia abajo) dejan de seguirse.
    const ids = new Set(instancias.map((i) => i.id));
    for (const id of seguimiento.keys()) if (!ids.has(id)) seguimiento.delete(id);
    await Promise.all(instancias.map((i) => revisar(i, momento)));
    actualizadoEn = ahora().toISOString();
  }

  function programar(proximo: number): void {
    if (!activo) return;
    temporizador = setTimeout(
      () => {
        void ciclo().finally(() => {
          const siguiente = proximo + intervaloMs;
          programar(siguiente <= Date.now() ? Date.now() + intervaloMs : siguiente);
        });
      },
      Math.max(0, proximo - Date.now()),
    );
  }

  return {
    ciclo,
    iniciar() {
      if (activo) return;
      activo = true;
      programar(Date.now());
    },
    detener() {
      activo = false;
      clearTimeout(temporizador);
    },
    estado() {
      return {
        actualizadoEn,
        intervaloMs,
        instancias: [...seguimiento.values()]
          .map(({ graciaHasta: _g, ...resto }) => resto)
          .sort((a, b) => a.nombre.localeCompare(b.nombre)),
      };
    },
  };
}
