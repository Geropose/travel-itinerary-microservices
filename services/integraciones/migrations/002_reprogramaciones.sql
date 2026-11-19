-- Opciones de reprogramación ofrecidas por proveedores (Iteración 7, P2.D3).
-- Garantiza que POST /interna/reprogramaciones/aplicar solo aplique opciones realmente ofrecidas
-- por el proveedor para esa reserva, detecte vencimientos y sea idempotente si se repite.
CREATE TABLE opciones_reprogramacion_ofrecidas (
  proveedor text NOT NULL,
  numero_reserva text NOT NULL,
  opcion_id text NOT NULL,
  vence_en timestamptz NOT NULL,
  ofrecida_en timestamptz NOT NULL DEFAULT now(),
  aplicada_en timestamptz,
  PRIMARY KEY (proveedor, numero_reserva, opcion_id)
);

CREATE INDEX idx_opciones_reprog_reserva
  ON opciones_reprogramacion_ofrecidas (proveedor, numero_reserva, ofrecida_en DESC);
