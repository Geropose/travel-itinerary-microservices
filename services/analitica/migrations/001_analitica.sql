-- Esquema de la base global de analítica (P2.C4, Iteración 6, ADR-016, ADR-017, CONST-6).
-- Guarda ÚNICAMENTE filas anonimizadas conformes a specs/schemas/ViajeAnonimizado.json:
-- nunca almacena usuario_id, viaje_id, reserva_id, numero_reserva, nombres ni emails.
-- Tabla particionada por mes sobre la fecha de inicio (DATE sin hora) para consultas Map-Reduce.

CREATE TABLE IF NOT EXISTS reservas_anonimizadas (
  codigo_reserva TEXT NOT NULL CHECK (codigo_reserva ~ '^[0-9a-f]{64}$'),
  region TEXT NOT NULL CHECK (region IN ('region-1', 'region-2')),
  proveedor TEXT NOT NULL CHECK (length(proveedor) > 0),
  tipo_reserva TEXT NOT NULL CHECK (tipo_reserva IN ('vuelo', 'hotel', 'auto')),
  origen TEXT,
  destino TEXT NOT NULL CHECK (length(destino) > 0),
  inicio DATE NOT NULL,
  fin DATE NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('confirmada', 'modificada', 'cancelada')),
  origen_cambio TEXT NOT NULL CHECK (origen_cambio IN ('correo', 'proveedor', 'manual', 'archivado')),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (region, proveedor, codigo_reserva, inicio),
  CHECK (fin >= inicio),
  CHECK (tipo_reserva <> 'vuelo' OR (origen IS NOT NULL AND length(origen) > 0))
) PARTITION BY RANGE (inicio);

-- Índice para ubicar rápidamente una reserva anonimizada (incluso si cambia de fecha/partición).
CREATE INDEX IF NOT EXISTS idx_reservas_anon_clave
  ON reservas_anonimizadas (region, proveedor, codigo_reserva);

-- Índices para consultas analíticas (destinos, cancelaciones por proveedor/destino y tendencias).
CREATE INDEX IF NOT EXISTS idx_reservas_anon_inicio_destino
  ON reservas_anonimizadas (inicio, destino);

CREATE INDEX IF NOT EXISTS idx_reservas_anon_inicio_proveedor_estado
  ON reservas_anonimizadas (inicio, proveedor, estado);

CREATE INDEX IF NOT EXISTS idx_reservas_anon_inicio_tipo_estado
  ON reservas_anonimizadas (inicio, tipo_reserva, estado);

-- Garantiza que exista la partición mensual para una fecha dada de forma segura bajo concurrencia.
CREATE OR REPLACE FUNCTION asegurar_particion_mes(p_fecha DATE)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_inicio DATE := date_trunc('month', p_fecha)::date;
  v_fin DATE := (date_trunc('month', p_fecha) + INTERVAL '1 month')::date;
  v_nombre TEXT := format('reservas_anonimizadas_%s', to_char(v_inicio, 'YYYY_MM'));
BEGIN
  IF to_regclass(format('%I', v_nombre)) IS NOT NULL THEN
    RETURN v_nombre;
  END IF;

  PERFORM pg_advisory_xact_lock(7412100);

  IF to_regclass(format('%I', v_nombre)) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF reservas_anonimizadas FOR VALUES FROM (%L) TO (%L)',
      v_nombre,
      v_inicio,
      v_fin
    );
  END IF;

  RETURN v_nombre;
END;
$$;

-- Particiones mensuales pre-creadas para histórico (2023–2028); cualquier mes fuera de rango se
-- crea automáticamente con asegurar_particion_mes().
DO $$
DECLARE
  v_mes DATE;
BEGIN
  FOR v_mes IN
    SELECT d::date
    FROM generate_series('2023-01-01'::date, '2028-12-01'::date, '1 month'::interval) AS d
  LOOP
    PERFORM asegurar_particion_mes(v_mes);
  END LOOP;
END;
$$;
