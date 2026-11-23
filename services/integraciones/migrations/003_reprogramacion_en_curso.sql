-- Marca transitoria para evitar que dos instancias apliquen la misma opción de reprogramación
-- en paralelo (auditoría de Integraciones, P5.1). Si una réplica cae a mitad de la llamada al
-- proveedor sin confirmar ni liberar, la reserva expira automáticamente a los 30 s.
ALTER TABLE opciones_reprogramacion_ofrecidas
  ADD COLUMN IF NOT EXISTS en_curso_desde timestamptz;
