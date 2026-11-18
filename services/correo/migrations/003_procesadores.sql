-- Proyección replicada de whitelists de Usuarios (FiltrosActualizados, Iteración 5),
-- deduplicación de correos ya examinados y registro de metadatos de correos de viaje no
-- interpretables (no_procesados, QA-6/QA-7).

CREATE TABLE filtros_remitentes (
  usuario_id uuid PRIMARY KEY,
  remitentes_permitidos text[] NOT NULL DEFAULT '{}',
  filtros_activos boolean NOT NULL DEFAULT false,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE correos_procesados (
  cuenta_id uuid NOT NULL REFERENCES cuentas_correo (id) ON DELETE CASCADE,
  correo_id text NOT NULL,
  procesado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cuenta_id, correo_id)
);

CREATE TABLE no_procesados (
  id uuid PRIMARY KEY,
  cuenta_id uuid NOT NULL REFERENCES cuentas_correo (id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL,
  proveedor_correo text NOT NULL,
  correo_id text NOT NULL,
  remitente text NOT NULL,
  asunto text,
  recibido_en timestamptz NOT NULL,
  registrado_en timestamptz NOT NULL DEFAULT now(),
  motivo text NOT NULL CHECK (
    motivo IN ('sin-regla', 'marcado-invalido', 'estado-no-confirmado', 'proveedor-desconocido')
  ),
  detalle text,
  UNIQUE (cuenta_id, correo_id)
);

CREATE INDEX idx_no_procesados_usuario_fecha
  ON no_procesados (usuario_id, registrado_en DESC, id DESC);

CREATE INDEX idx_no_procesados_cuenta_fecha
  ON no_procesados (cuenta_id, registrado_en DESC, id DESC);
