-- Estado persistente de ejecuciones asíncronas Map-Reduce (P2.C5, Iteración 6, specs/openapi/analitica.yaml).
-- Vive en la base global de analítica para que cualquier instancia pueda consultar GET /consultas/ejecuciones/{consultaId}
-- y evitar lanzar duplicados concurrentes del mismo tipo y parámetros (409 Conflict).

CREATE TABLE IF NOT EXISTS ejecuciones_consultas (
  consulta_id UUID PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('destinos', 'cancelaciones', 'tendencias')),
  parametros JSONB NOT NULL,
  clave_dedup TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('pendiente', 'enCurso', 'terminada', 'fallida')),
  procesadores INTEGER NOT NULL DEFAULT 0 CHECK (procesadores >= 0 AND procesadores <= 50),
  progreso DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (progreso >= 0 AND progreso <= 1),
  creada_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  iniciada_en TIMESTAMPTZ,
  terminada_en TIMESTAMPTZ,
  duracion_ms INTEGER CHECK (duracion_ms IS NULL OR duracion_ms >= 0),
  resultado JSONB,
  error TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ejecuciones_activas_clave
  ON ejecuciones_consultas (clave_dedup)
  WHERE estado IN ('pendiente', 'enCurso');

CREATE INDEX IF NOT EXISTS idx_ejecuciones_creada_en
  ON ejecuciones_consultas (creada_en DESC);
