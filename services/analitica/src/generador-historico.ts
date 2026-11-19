// Generador masivo de histórico anonimizado realista para mediciones de Map-Reduce y QA-5 (P2.C5).
// Inserta N filas en lotes rápidos directo en PostgreSQL dentro de las particiones mensuales de
// `reservas_anonimizadas`, respetando todas las restricciones de ViajeAnonimizado.json (cero PII).
import type { Pool } from '@trotamundos/comun';

export interface OpcionesGeneradorHistorico {
  /** Cantidad total de filas anonimizadas a generar (ej. 1_000_000 para mediciones QA-5). */
  cantidad: number;
  /** Primer año del rango histórico (incluido, por defecto 2023). */
  desdeAnio?: number;
  /** Último año del rango histórico (incluido, por defecto 2025). */
  hastaAnio?: number;
  /** Cantidad de filas por lote INSERT (por defecto 100_000). */
  tamanoLote?: number;
  /** Semilla numérica para generar claves únicas entre corridas distintas. */
  semilla?: number;
  alCompletarLote?: (insertadas: number, total: number) => void;
}

export interface ResultadoGeneracionHistorico {
  insertadas: number;
  desdeFecha: string;
  hastaFecha: string;
  duracionMs: number;
}

/**
 * Inserta `cantidad` filas anonimizadas realistas en la tabla particionada `reservas_anonimizadas`:
 * - Distribución entre region-1 y region-2, 3 proveedores (aerolinea-andina, hotel-cordillera,
 *   rentadora-sur), 12 destinos internacionales y tasas realistas de cancelación (4 %–9 %).
 * - `codigo_reserva` es un hash hexadecimal de 64 caracteres único por fila (sin datos personales).
 */
export async function generarHistoricoAnonimizado(
  pool: Pool,
  opciones: OpcionesGeneradorHistorico,
): Promise<ResultadoGeneracionHistorico> {
  const cantidad = Math.max(0, Math.trunc(opciones.cantidad));
  const desdeAnio = opciones.desdeAnio ?? 2023;
  const hastaAnio = opciones.hastaAnio ?? 2025;
  if (hastaAnio < desdeAnio) {
    throw new Error(`Rango de años inválido: ${desdeAnio}..${hastaAnio}`);
  }
  const tamanoLote = Math.max(1, Math.min(250_000, Math.trunc(opciones.tamanoLote ?? 100_000)));
  const semilla = opciones.semilla ?? Math.floor(Date.now() % 1_000_000_000);

  const desdeFecha = `${desdeAnio}-01-01`;
  const hastaFecha = `${hastaAnio}-12-31`;
  const inicioMs = performance.now();

  // Aseguramos todas las particiones mensuales del período antes de insertar lotes.
  await pool.query(
    `SELECT asegurar_particion_mes(d::date)
     FROM generate_series($1::date, $2::date, '1 month'::interval) AS d`,
    [desdeFecha, hastaFecha],
  );

  let insertadas = 0;
  while (insertadas < cantidad) {
    const restantes = cantidad - insertadas;
    const cantidadLote = Math.min(tamanoLote, restantes);
    const offset = insertadas;

    await pool.query(
      `WITH serie AS (
         SELECT
           gs AS n,
           ($1::date + ((gs * 7919 + $4::bigint) % (($2::date - $1::date) + 1))::int) AS fecha_inicio,
           ((gs + $4::bigint) % 3) AS idx_tipo,
           ((gs * 31 + $4::bigint) % 12) AS idx_destino,
           ((gs * 17 + $4::bigint) % 100) AS pct_estado,
           ((gs + $4::bigint) % 2) AS idx_region
         FROM generate_series($3::bigint + 1, $3::bigint + $5::bigint) AS gs
       ),
       armado AS (
         SELECT
           md5('hist-a-' || $4::text || '-' || n::text) || md5('hist-b-' || $4::text || '-' || n::text) AS codigo_reserva,
           CASE WHEN idx_region = 0 THEN 'region-1' ELSE 'region-2' END AS region,
           CASE idx_tipo
             WHEN 0 THEN 'aerolinea-andina'
             WHEN 1 THEN 'hotel-cordillera'
             ELSE 'rentadora-sur'
           END AS proveedor,
           CASE idx_tipo
             WHEN 0 THEN 'vuelo'
             WHEN 1 THEN 'hotel'
             ELSE 'auto'
           END AS tipo_reserva,
           CASE idx_tipo
             WHEN 0 THEN (ARRAY['EZE', 'AEP', 'COR', 'MAD', 'BCN', 'BOG'])[1 + (n % 6)]
             WHEN 2 THEN (ARRAY['Aeropuerto SCL', 'Aeropuerto MAD', 'Aeropuerto BRC', 'Aeropuerto MIA'])[1 + (n % 4)]
             ELSE NULL
           END AS origen,
           (ARRAY[
             'SCL', 'MAD', 'Bariloche', 'Mendoza', 'MIA', 'LIM',
             'BOG', 'GRU', 'BCN', 'CDG', 'FCO', 'MEX'
           ])[1 + idx_destino] AS destino,
           fecha_inicio AS inicio,
           (fecha_inicio + (CASE idx_tipo WHEN 0 THEN 0 WHEN 1 THEN 1 + (n % 6) ELSE 1 + (n % 5) END)::int) AS fin,
           CASE
             WHEN (idx_tipo = 2 AND pct_estado < 9)
               OR (idx_tipo = 0 AND pct_estado < 6)
               OR (idx_tipo = 1 AND pct_estado < 4) THEN 'cancelada'
             WHEN pct_estado < 20 THEN 'modificada'
             ELSE 'confirmada'
           END AS estado,
           (ARRAY['correo', 'proveedor', 'manual', 'archivado'])[1 + (n % 4)] AS origen_cambio
         FROM serie
       )
       INSERT INTO reservas_anonimizadas (
         codigo_reserva, region, proveedor, tipo_reserva, origen, destino,
         inicio, fin, estado, origen_cambio
       )
       SELECT
         codigo_reserva, region, proveedor, tipo_reserva, origen, destino,
         inicio, fin, estado, origen_cambio
       FROM armado
       ON CONFLICT DO NOTHING`,
      [desdeFecha, hastaFecha, offset, semilla, cantidadLote],
    );

    insertadas += cantidadLote;
    opciones.alCompletarLote?.(insertadas, cantidad);
  }

  return {
    insertadas,
    desdeFecha,
    hastaFecha,
    duracionMs: Math.max(0, Math.round(performance.now() - inicioMs)),
  };
}
