-- Identificador autoincremental para poder revertir una reserva tentativa de intento fallido
-- cuando /login deriva hacia la otra región (auditoría P5.1).
ALTER TABLE intentos_fallidos
  ADD COLUMN IF NOT EXISTS id bigserial;
