-- Agrega columna actualizado_en para heartbeat y expiración de ejecuciones huérfanas de Map-Reduce (C1).
ALTER TABLE ejecuciones_consultas
  ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE ejecuciones_consultas
  SET actualizado_en = COALESCE(terminada_en, iniciada_en, creada_en);

CREATE INDEX IF NOT EXISTS idx_ejecuciones_activas_actualizado
  ON ejecuciones_consultas (actualizado_en)
  WHERE estado IN ('pendiente', 'enCurso');
