-- Credenciales de los usuarios de esta región (Iteración 5, ADR-014, CONST-6). La contraseña se
-- guarda solo como hash argon2id: nadie puede leerla (QA-8).
CREATE TABLE credenciales (
  usuario_id uuid PRIMARY KEY,
  -- En minúsculas, para que Ana@correo y ana@correo sean la misma cuenta.
  email text NOT NULL UNIQUE,
  hash_contrasena text NOT NULL,
  roles text[] NOT NULL DEFAULT '{usuario}',
  idioma text NOT NULL,
  creada_en timestamptz NOT NULL DEFAULT now()
);

-- Tokens de renovación (7 días). Se guarda solo su hash SHA-256: el token es aleatorio de 256 bits,
-- así que alcanza con un hash rápido.
CREATE TABLE tokens_renovacion (
  hash text PRIMARY KEY,
  usuario_id uuid NOT NULL REFERENCES credenciales (usuario_id) ON DELETE CASCADE,
  vence_en timestamptz NOT NULL,
  -- Con fecha: se cerró la sesión y el token ya no sirve.
  revocado_en timestamptz
);

CREATE INDEX tokens_renovacion_usuario ON tokens_renovacion (usuario_id);

-- Intentos de login fallidos, para el límite por email (5 en 15 minutos). Compartido entre las
-- instancias del servicio porque está en la base.
CREATE TABLE intentos_fallidos (
  email text NOT NULL,
  fecha timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX intentos_fallidos_email_fecha ON intentos_fallidos (email, fecha);
