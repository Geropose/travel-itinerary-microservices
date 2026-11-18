-- Tablas del kit común para los eventos (docs/CONVENCIONES.md 4.5).

-- Outbox: el servicio guarda el evento en la misma transacción que su cambio y el publicador lo
-- envía al broker cada 500 ms. Un cambio guardado nunca se queda sin su evento.
CREATE TABLE IF NOT EXISTS eventos_salientes (
  id         bigserial PRIMARY KEY,
  event_id   uuid NOT NULL UNIQUE,
  tipo       text NOT NULL,
  sobre      jsonb NOT NULL,
  creado_en  timestamptz NOT NULL DEFAULT now(),
  enviado_en timestamptz
);
CREATE INDEX IF NOT EXISTS eventos_salientes_pendientes
  ON eventos_salientes (id) WHERE enviado_en IS NULL;

-- Idempotencia: el consumidor guarda el eventId en la misma transacción que aplica el cambio; si
-- ya estaba, ignora el evento repetido.
CREATE TABLE IF NOT EXISTS eventos_procesados (
  event_id     uuid NOT NULL,
  cola         text NOT NULL,
  procesado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, cola)
);
