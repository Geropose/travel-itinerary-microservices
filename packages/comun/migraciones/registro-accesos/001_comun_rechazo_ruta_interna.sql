-- El gateway también registra las rutas /interna/... pedidas desde afuera: responde 404 y guarda
-- el intento con motivo ruta-interna (specs/openapi/gateway.yaml, P1.5).
ALTER TABLE accesos_rechazados DROP CONSTRAINT IF EXISTS accesos_rechazados_status_check;
ALTER TABLE accesos_rechazados
  ADD CONSTRAINT accesos_rechazados_status_check CHECK (status IN (401, 403, 404));
