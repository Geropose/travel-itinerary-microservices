-- Cuentas y preferencias de los usuarios de esta región (Iteración 1, CONST-6).
CREATE TABLE cuentas (
  usuario_id uuid PRIMARY KEY,
  -- En minúsculas, para que Ana@correo y ana@correo sean la misma cuenta.
  email text NOT NULL UNIQUE,
  nombre text NOT NULL,
  region text NOT NULL,
  idioma text NOT NULL,
  moneda text NOT NULL DEFAULT 'USD',
  agencia_preferida text,
  creado_en timestamptz NOT NULL DEFAULT now()
);

-- Filtros y whitelist de remitentes seguros (Iteración 5, UC-2).
-- actualizado_en queda en NULL mientras el usuario nunca haya guardado la whitelist.
CREATE TABLE whitelists (
  usuario_id uuid PRIMARY KEY REFERENCES cuentas (usuario_id) ON DELETE CASCADE,
  remitentes_permitidos text[] NOT NULL DEFAULT '{}',
  filtros_activos boolean NOT NULL DEFAULT false,
  actualizado_en timestamptz
);

-- Permisos de itinerarios compartidos: personas designadas por el dueño del viaje (Iteración 5, QA-9).
-- usuario_id queda en NULL si la persona designada todavía no tiene cuenta en esta región y se
-- completa cuando se registra.
CREATE TABLE designados_itinerario (
  viaje_id uuid NOT NULL,
  email text NOT NULL,
  usuario_id uuid REFERENCES cuentas (usuario_id) ON DELETE SET NULL,
  designado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (viaje_id, email)
);

-- Índice para el Validador de Intercepción (GET /interna/permisos/itinerarios/{viajeId}).
CREATE INDEX idx_designados_viaje_usuario
  ON designados_itinerario (viaje_id, usuario_id)
  WHERE usuario_id IS NOT NULL;

-- Índice para vincular rápido designados pendientes cuando se registra una cuenta nueva.
CREATE INDEX idx_designados_email_pendiente
  ON designados_itinerario (email)
  WHERE usuario_id IS NULL;
