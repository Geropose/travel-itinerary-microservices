-- Esquema inicial del Servicio de Viajes (P2.C1, Iteraciones 2 y 6, ADR-001, ADR-002, ADR-016).
-- Guarda solo los viajes y reservas de los usuarios de la región (CONST-6).

CREATE TABLE IF NOT EXISTS viajes (
  id UUID PRIMARY KEY,
  usuario_id UUID NOT NULL,
  nombre TEXT NOT NULL,
  destino TEXT NOT NULL,
  inicio TIMESTAMPTZ NOT NULL,
  fin TIMESTAMPTZ NOT NULL,
  estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'archivado')),
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (fin >= inicio)
);

CREATE INDEX IF NOT EXISTS idx_viajes_usuario_estado_inicio
  ON viajes (usuario_id, estado, inicio);

CREATE INDEX IF NOT EXISTS idx_viajes_activos_fin
  ON viajes (fin)
  WHERE estado = 'activo';

CREATE TABLE IF NOT EXISTS reservas (
  id UUID PRIMARY KEY,
  viaje_id UUID NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
  usuario_id UUID NOT NULL,
  proveedor TEXT NOT NULL,
  tipo_reserva TEXT NOT NULL CHECK (tipo_reserva IN ('vuelo', 'hotel', 'auto')),
  numero_reserva TEXT NOT NULL,
  inicio TIMESTAMPTZ NOT NULL,
  fin TIMESTAMPTZ NOT NULL,
  origen TEXT,
  destino TEXT NOT NULL,
  detalle JSONB NOT NULL DEFAULT '{}'::jsonb,
  estado TEXT NOT NULL DEFAULT 'confirmada' CHECK (estado IN ('confirmada', 'modificada', 'cancelada')),
  origen_cambio TEXT NOT NULL CHECK (origen_cambio IN ('correo', 'proveedor', 'manual', 'archivado')),
  correo_id TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (proveedor, numero_reserva),
  CHECK (fin >= inicio),
  CHECK (tipo_reserva <> 'vuelo' OR (origen IS NOT NULL AND length(origen) > 0))
);

CREATE INDEX IF NOT EXISTS idx_reservas_viaje_inicio
  ON reservas (viaje_id, inicio);

CREATE INDEX IF NOT EXISTS idx_reservas_usuario_inicio
  ON reservas (usuario_id, inicio);
