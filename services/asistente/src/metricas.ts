import type { Logger } from '@trotamundos/comun';
import type { ResultadoMensaje } from './plugins/tipos.ts';
import type { IntencionDetectada } from './reglas.ts';

export const LIMITE_QA12_MS = 3000;

export interface RegistroLatenciaMensaje {
  conversacionId: string;
  intencion: IntencionDetectada;
  estado: 'respondido' | 'consultando';
  resultado: ResultadoMensaje;
  duracionMs: number;
  cumpleQa12: boolean;
}

export interface ResumenMetricasAsistente {
  total: number;
  cumplenQa12: number;
  porcentajeQa12: number;
  promedioMs: number;
  p50Ms: number;
  p95Ms: number;
  maximoMs: number;
  ultimos: RegistroLatenciaMensaje[];
}

export interface MetricasAsistente {
  registrar(entrada: Omit<RegistroLatenciaMensaje, 'cumpleQa12'>): RegistroLatenciaMensaje;
  resumen(): ResumenMetricasAsistente;
  reiniciar(): void;
}

function percentil(ordenados: number[], p: number): number {
  if (ordenados.length === 0) return 0;
  const idx = Math.min(
    ordenados.length - 1,
    Math.max(0, Math.ceil((p / 100) * ordenados.length) - 1),
  );
  return ordenados[idx] ?? 0;
}

/**
 * Recolector de métricas de tiempo de respuesta por mensaje del Asistente Virtual (QA-12: < 3 s).
 * Emite una entrada estructurada en Pino por cada mensaje y mantiene estadísticas en memoria.
 */
export function crearMetricasAsistente(
  logger: Logger,
  limiteQa12Ms = LIMITE_QA12_MS,
  maxHistorial = 1000,
): MetricasAsistente {
  const registros: RegistroLatenciaMensaje[] = [];

  return {
    registrar(entrada) {
      const duracionMs = Math.round(entrada.duracionMs * 100) / 100;
      const cumpleQa12 =
        entrada.estado === 'consultando'
          ? duracionMs <= limiteQa12Ms + 500
          : duracionMs < limiteQa12Ms;
      const completo: RegistroLatenciaMensaje = {
        ...entrada,
        duracionMs,
        cumpleQa12,
      };
      registros.push(completo);
      if (registros.length > maxHistorial) {
        registros.shift();
      }
      if (cumpleQa12) {
        logger.info(completo, 'Mensaje atendido por el asistente (QA-12)');
      } else {
        logger.warn(completo, 'Mensaje atendido por encima del umbral de QA-12');
      }
      return completo;
    },

    resumen() {
      const total = registros.length;
      if (total === 0) {
        return {
          total: 0,
          cumplenQa12: 0,
          porcentajeQa12: 100,
          promedioMs: 0,
          p50Ms: 0,
          p95Ms: 0,
          maximoMs: 0,
          ultimos: [],
        };
      }
      const duraciones = registros.map((r) => r.duracionMs).sort((a, b) => a - b);
      const suma = duraciones.reduce((acc, v) => acc + v, 0);
      const cumplenQa12 = registros.filter((r) => r.cumpleQa12).length;
      return {
        total,
        cumplenQa12,
        porcentajeQa12: Math.round((cumplenQa12 / total) * 10_000) / 100,
        promedioMs: Math.round((suma / total) * 100) / 100,
        p50Ms: percentil(duraciones, 50),
        p95Ms: percentil(duraciones, 95),
        maximoMs: duraciones.at(-1) ?? 0,
        ultimos: registros.slice(-20),
      };
    },

    reiniciar() {
      registros.length = 0;
    },
  };
}
