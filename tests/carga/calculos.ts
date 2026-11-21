// Cálculos de las mediciones de tests/carga (P4.1): percentiles, porcentajes y qué reservas tienen
// que aparecer en el panel según las etiquetas del generador de correos (mocks/comun).
// No usan la red: se prueban en calculos.test.ts.

/** Percentil p (0 a 100) de una lista de valores, por el método del rango más cercano. */
export function percentil(valores: readonly number[], p: number): number {
  if (valores.length === 0) return NaN;
  const ordenados = [...valores].sort((a, b) => a - b);
  const posicion = Math.ceil((p / 100) * ordenados.length) - 1;
  return ordenados[Math.min(Math.max(posicion, 0), ordenados.length - 1)] ?? NaN;
}

export interface Resumen {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
}

export function resumir(valores: readonly number[]): Resumen {
  return {
    n: valores.length,
    min: valores.length ? Math.min(...valores) : NaN,
    p50: percentil(valores, 50),
    p95: percentil(valores, 95),
    max: valores.length ? Math.max(...valores) : NaN,
  };
}

/** Porcentaje con dos decimales (0 si no hay total). */
export function porcentaje(parte: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((parte / total) * 10_000) / 100;
}

/** Correo inyectado tal como lo devuelve POST /admin/buzones/{email}/correos de los mocks. */
export interface CorreoInyectado {
  id: string;
  tipo: string;
  reserva?: { numeroReserva: string };
}

/**
 * Reservas que el Servicio de Correo tiene que detectar en un lote con la whitelist activa de los
 * tres proveedores de prueba: todos los correos de viaje (con o sin marcado JSON-LD), menos los de
 * un remitente que no está en la whitelist (UC-2). Esos últimos no tienen que aparecer.
 */
export function reservasEsperadas(correos: readonly CorreoInyectado[]) {
  const esperadas = new Set<string>();
  const bloqueadas = new Set<string>();
  for (const correo of correos) {
    if (!correo.reserva) continue;
    if (correo.tipo === 'remitente-no-permitido') bloqueadas.add(correo.reserva.numeroReserva);
    else esperadas.add(correo.reserva.numeroReserva);
  }
  return { esperadas, bloqueadas };
}

/** Cuántas de las reservas buscadas están en el panel. */
export function contarEn(panel: ReadonlySet<string>, buscadas: ReadonlySet<string>): number {
  let encontradas = 0;
  for (const numero of buscadas) if (panel.has(numero)) encontradas += 1;
  return encontradas;
}

/** Milisegundos a texto corto ("850 ms", "12,4 s", "2 min 05 s"). */
export function duracion(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  const segundos = Math.round(ms / 1000);
  return `${Math.floor(segundos / 60)} min ${String(segundos % 60).padStart(2, '0')} s`;
}
