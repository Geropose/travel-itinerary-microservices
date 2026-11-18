-- Cuentas de correo conectadas por OAuth 2.0 (Iteración 3, ADR-003 y ADR-015) y estados OAuth
-- de un solo uso para proteger /oauth/callback contra falsificación y reuso.

CREATE TABLE cuentas_correo (
  id uuid PRIMARY KEY,
  usuario_id uuid NOT NULL,
  proveedor text NOT NULL,
  -- Dirección del buzón en minúsculas, usada para correlacionar avisos push.
  email text NOT NULL,
  estado text NOT NULL DEFAULT 'conectada' CHECK (estado IN ('conectada', 'sin-permiso')),
  -- Tokens guardados únicamente cifrados con AES-256-GCM (QA-8, ADR-015).
  access_token_cifrado text NOT NULL,
  refresh_token_cifrado text NOT NULL,
  token_vence_en timestamptz NOT NULL,
  scope_concedido text NOT NULL,
  -- Suscripción a avisos push (watch de Gmail o subscription de Graph).
  suscripcion_id text,
  suscripcion_secreto_cifrado text,
  suscripcion_vence_en timestamptz,
  -- Marca de prioridad máxima para revisar buzones recién conectados en el primer minuto (QA-7).
  revision_prioritaria boolean NOT NULL DEFAULT true,
  proxima_revision timestamptz NOT NULL DEFAULT now(),
  ultima_revision timestamptz,
  ultimo_cursor text,
  conectada_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proveedor, email)
);

CREATE INDEX idx_cuentas_correo_usuario
  ON cuentas_correo (usuario_id, conectada_en);

CREATE INDEX idx_cuentas_correo_revision
  ON cuentas_correo (revision_prioritaria DESC, proxima_revision ASC)
  WHERE estado = 'conectada';

CREATE TABLE oauth_states (
  nonce uuid PRIMARY KEY,
  usuario_id uuid NOT NULL,
  proveedor text NOT NULL,
  vence_en timestamptz NOT NULL,
  usado_en timestamptz,
  creado_en timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_oauth_states_pendientes
  ON oauth_states (vence_en)
  WHERE usado_en IS NULL;
