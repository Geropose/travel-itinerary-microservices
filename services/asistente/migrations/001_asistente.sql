-- Historial de conversaciones del Asistente Virtual (Iteración 7, ADR-018, CONST-6).
-- Cada región guarda únicamente las conversaciones de sus propios usuarios.

CREATE TABLE conversaciones (
  conversacion_id uuid PRIMARY KEY,
  usuario_id uuid NOT NULL,
  region text NOT NULL,
  idioma text NOT NULL CHECK (idioma IN ('es', 'en')),
  intentos_fallidos integer NOT NULL DEFAULT 0,
  ofrece_derivar boolean NOT NULL DEFAULT false,
  consultando boolean NOT NULL DEFAULT false,
  ultima_secuencia integer NOT NULL DEFAULT 0,
  creada_en timestamptz NOT NULL DEFAULT now(),
  actualizada_en timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversaciones_usuario ON conversaciones (usuario_id, actualizada_en DESC);

CREATE TABLE mensajes (
  mensaje_id uuid PRIMARY KEY,
  conversacion_id uuid NOT NULL REFERENCES conversaciones (conversacion_id) ON DELETE CASCADE,
  secuencia integer NOT NULL CHECK (secuencia >= 1),
  autor text NOT NULL CHECK (autor IN ('usuario', 'asistente')),
  texto text NOT NULL,
  enviado_en timestamptz NOT NULL DEFAULT now(),
  intencion text CHECK (
    intencion IS NULL OR intencion IN ('estado', 'reprogramar', 'problemaMenor', 'derivar', 'desconocida')
  ),
  resultado text CHECK (
    resultado IS NULL OR resultado IN (
      'respondido',
      'repregunta',
      'consultando',
      'opciones',
      'reprogramado',
      'opcionRechazada',
      'derivado',
      'noDisponible'
    )
  ),
  datos jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (conversacion_id, secuencia)
);

CREATE INDEX idx_mensajes_conversacion_sec ON mensajes (conversacion_id, secuencia ASC);

CREATE TABLE opciones_pendientes (
  conversacion_id uuid NOT NULL REFERENCES conversaciones (conversacion_id) ON DELETE CASCADE,
  opcion_id text NOT NULL,
  proveedor text NOT NULL,
  numero_reserva text NOT NULL,
  tipo_reserva text NOT NULL CHECK (tipo_reserva IN ('vuelo', 'hotel', 'auto')),
  inicio text NOT NULL,
  fin text NOT NULL,
  origen text,
  destino text NOT NULL,
  descripcion text,
  ofrecida_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversacion_id, opcion_id)
);
