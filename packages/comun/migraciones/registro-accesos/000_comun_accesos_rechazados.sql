-- Registro de accesos (Iteración 5, ADR-005, QA-8, QA-9): base registro_accesos de cada región.
-- La escribe el registro de accesos del gateway: sus propios rechazos directo y los de los
-- microservicios a partir del evento AccesoRechazado.
CREATE TABLE IF NOT EXISTS accesos_rechazados (
  id         bigserial PRIMARY KEY,
  fecha      timestamptz NOT NULL DEFAULT now(),
  servicio   text NOT NULL,
  metodo     text NOT NULL,
  ruta       text NOT NULL,
  status     smallint NOT NULL CHECK (status IN (401, 403)),
  motivo     text NOT NULL,
  usuario_id uuid,
  ip         text,
  request_id uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS accesos_rechazados_fecha ON accesos_rechazados (fecha);
CREATE INDEX IF NOT EXISTS accesos_rechazados_usuario ON accesos_rechazados (usuario_id);
