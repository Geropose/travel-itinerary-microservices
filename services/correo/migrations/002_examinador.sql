-- Estado de planificación del Examinador (Iteración 2, ADR-009 y ADR-010) y deduplicación
-- idempotente de avisos push entrantes (Pub/Sub y Microsoft Graph).

ALTER TABLE cuentas_correo
  ADD COLUMN ultimo_encolado timestamptz,
  ADD COLUMN intentos_429 integer NOT NULL DEFAULT 0,
  ADD COLUMN bloqueado_hasta timestamptz;

CREATE INDEX idx_cuentas_correo_suscripcion
  ON cuentas_correo (suscripcion_id)
  WHERE suscripcion_id IS NOT NULL;

CREATE INDEX idx_cuentas_correo_email
  ON cuentas_correo (proveedor, email)
  WHERE estado = 'conectada';

CREATE TABLE avisos_push_vistos (
  proveedor text NOT NULL,
  aviso_id text NOT NULL,
  visto_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proveedor, aviso_id)
);

CREATE INDEX idx_avisos_push_vistos_fecha ON avisos_push_vistos (visto_en);
