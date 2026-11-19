-- Tablas propias del Servicio de Integraciones (ADR-001, ADR-003, QA-6).
-- eventos_salientes y eventos_procesados vienen de MIGRACIONES_EVENTOS (000_comun_*).

-- Clave de deduplicación de cambios de proveedores: proveedor + numero_reserva + versión del cambio.
-- Garantiza que un mismo cambio nunca publique dos eventos ReservaActualizada.
CREATE TABLE cambios_procesados (
  proveedor text NOT NULL,
  numero_reserva text NOT NULL,
  version_cambio text NOT NULL,
  procesado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proveedor, numero_reserva, version_cambio)
);

-- Último estado conocido de cada reserva por proveedor (hotel y rentadora no envían qué campos
-- cambiaron; se compara contra este registro para mandar en `cambios` solo lo que cambió).
CREATE TABLE estado_reservas_proveedor (
  proveedor text NOT NULL,
  numero_reserva text NOT NULL,
  estado text NOT NULL,
  inicio text,
  fin text,
  origen text,
  destino text,
  detalle jsonb NOT NULL DEFAULT '{}'::jsonb,
  version_cambio text NOT NULL,
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proveedor, numero_reserva)
);

-- Cursor temporal de última consulta por proveedor en modo `consulta` (hotel, rentadora).
-- Guarda la marca temporal más alta procesada para no perder cambios tras reinicios o fallas 503.
CREATE TABLE cursores_consulta (
  proveedor text PRIMARY KEY,
  ultimo_desde timestamptz NOT NULL,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

-- Mensajes de proveedores que el adaptador no pudo traducir (QA-6: >= 99 % automáticos).
-- El campo `cuerpo` se guarda sin datos personales (o "[cuerpo no JSON de N bytes]").
CREATE TABLE no_traducidos (
  id uuid PRIMARY KEY,
  proveedor text NOT NULL,
  via text NOT NULL CHECK (via IN ('webhook', 'consulta')),
  recibido_en timestamptz NOT NULL DEFAULT now(),
  motivo text NOT NULL,
  cuerpo text NOT NULL
);

CREATE INDEX idx_no_traducidos_recibido_en ON no_traducidos (recibido_en DESC, id DESC);
CREATE INDEX idx_no_traducidos_proveedor_recibido
  ON no_traducidos (proveedor, recibido_en DESC, id DESC);
