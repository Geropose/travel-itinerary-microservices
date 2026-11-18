// Reglas puras de agrupación de reservas en viajes y cálculo de metadatos del viaje (UC-5, P2.C1).
import type { EstadoReserva, EstadoViaje, TipoReserva } from './modelo.ts';

/** Margen por defecto de agrupación entre fechas de reservas: 2 días (48 horas). */
export const MARGEN_AGRUPACION_MS_DEFECTO = 2 * 24 * 60 * 60 * 1000;

export interface RangoViajeCandidato {
  viajeId: string;
  inicio: string;
  fin: string;
  estado: EstadoViaje;
}

export interface ReservaParaResumen {
  tipoReserva: TipoReserva;
  destino: string;
  inicio: string;
  fin: string;
  estado: EstadoReserva;
}

export interface ResumenViaje {
  inicio: string;
  fin: string;
  destino: string;
  nombre: string;
}

/**
 * Distancia en milisegundos entre dos intervalos cerrados [aInicio, aFin] y [bInicio, bFin].
 * Devuelve 0 cuando se superponen o se tocan en un extremo.
 */
export function distanciaEntreRangosMs(
  aInicioMs: number,
  aFinMs: number,
  bInicioMs: number,
  bFinMs: number,
): number {
  if (aFinMs < bInicioMs) return bInicioMs - aFinMs;
  if (bFinMs < aInicioMs) return aInicioMs - bFinMs;
  return 0;
}

/**
 * Elige el viaje activo del usuario en el que debe agruparse una reserva nueva:
 * entra si sus fechas se superponen o están a menos de `margenMs` (por defecto 2 días).
 * Si hay más de un candidato válido, elige el más cercano (y ante empate, el de inicio más temprano).
 */
export function buscarViajeParaAgrupar(
  viajes: readonly RangoViajeCandidato[],
  inicioIso: string,
  finIso: string,
  margenMs: number = MARGEN_AGRUPACION_MS_DEFECTO,
): RangoViajeCandidato | null {
  const inicioMs = Date.parse(inicioIso);
  const finMs = Date.parse(finIso);
  if (Number.isNaN(inicioMs) || Number.isNaN(finMs)) {
    throw new Error('Fechas de reserva inválidas para agrupación.');
  }

  let mejor: { viaje: RangoViajeCandidato; distancia: number; inicioViajeMs: number } | null = null;

  for (const viaje of viajes) {
    if (viaje.estado !== 'activo') continue;
    const vInicioMs = Date.parse(viaje.inicio);
    const vFinMs = Date.parse(viaje.fin);
    if (Number.isNaN(vInicioMs) || Number.isNaN(vFinMs)) continue;

    const distancia = distanciaEntreRangosMs(inicioMs, finMs, vInicioMs, vFinMs);
    if (distancia >= margenMs) continue;

    if (
      !mejor ||
      distancia < mejor.distancia ||
      (distancia === mejor.distancia && vInicioMs < mejor.inicioViajeMs)
    ) {
      mejor = { viaje, distancia, inicioViajeMs: vInicioMs };
    }
  }

  return mejor?.viaje ?? null;
}

/**
 * Calcula inicio, fin, destino principal y nombre de un viaje a partir de sus reservas.
 * Prioriza reservas no canceladas para elegir el destino principal (hotel si existe; si no, la
 * primera reserva por fecha de inicio para evitar tomar el aeropuerto de regreso).
 */
export function calcularResumenViaje(reservas: readonly ReservaParaResumen[]): ResumenViaje {
  if (reservas.length === 0) {
    throw new Error('No se puede calcular el resumen de un viaje sin reservas.');
  }

  const ordenadas = [...reservas].sort((a, b) => Date.parse(a.inicio) - Date.parse(b.inicio));
  const primera = ordenadas[0];
  if (!primera) {
    throw new Error('No se puede calcular el resumen de un viaje sin reservas.');
  }

  let minInicioMs = Date.parse(primera.inicio);
  let maxFinMs = Date.parse(primera.fin);
  for (const r of ordenadas) {
    const ini = Date.parse(r.inicio);
    const fin = Date.parse(r.fin);
    if (ini < minInicioMs) minInicioMs = ini;
    if (fin > maxFinMs) maxFinMs = fin;
  }

  const vigentes = ordenadas.filter((r) => r.estado !== 'cancelada');
  const poolDestino = vigentes.length > 0 ? vigentes : ordenadas;
  const hotel = poolDestino.find((r) => r.tipoReserva === 'hotel');
  const referencia = hotel ?? poolDestino[0] ?? primera;
  const destino = referencia.destino;

  return {
    inicio: new Date(minInicioMs).toISOString(),
    fin: new Date(maxFinMs).toISOString(),
    destino,
    nombre: `Viaje a ${destino}`,
  };
}
