# Auditoría de Correo, Usuarios y Pantallas Web (P5.1 · Dueño B)

Auditoría cruzada sobre `services/usuarios`, `services/correo` y sus pantallas en `web/` contra `specs/openapi/{usuarios,correo,comun}.yaml`, `specs/asyncapi/eventos.yaml` y `docs/CONVENCIONES.md`.

## Resumen de hallazgos resueltos (PR #57)

| ID | Gravedad | Componente | Problema y resolución |
| --- | --- | --- | --- |
| B1 | Alta | `services/correo/src/{procesador,cola,index}.ts` | En `deteniendo = true`, `procesarCuenta` salía del loop pero ejecutaba `actualizarCursorRevision` y la cola hacía `ack`. Se exportó `ErrorProcesadorDeteniendo`, se reencola con `canal.nack(msg, false, true)` y se ordenó el apagado (`examinador` → `pausarConsumidores` → `procesador.detener` → `outbox` → `cola`/`broker` → `pool`). |
| B2 | Alta | `services/correo/src/{examinador,repositorio,procesador}.ts` | Un aviso push puntual de Outlook limpiaba `revision_prioritaria` y adelantaba `ultimo_cursor`, omitiendo el barrido inicial y mensajes previos. `encolarPorPush` con `mensajeIds` preserva `revision_prioritaria` y `procesarCuenta` no actualiza `ultimo_cursor` en push puntual. |
| B3 | Alta | `services/correo/src/{extractor,procesador}.ts` | `esFechaIsoValida` aceptaba fechas sin segundos o con rollover calendario rechazadas luego por `ajv-formats`, y `ErrorEventoInvalido` abortaba el lote completo creando poison pills. Se exigió RFC 3339 estricto y calendario válido, y `ErrorEventoInvalido` se aísla por correo en `no_procesados`. |
| B4 | Alta | `services/correo/src/{repositorio,examinador}.ts` | `obtenerCuentasParaExaminar` y `clasificarCuentaParaRevision` no consultaban `suscripcion_vence_en`, dejando buzones mudos tras vencer push (6–7 días). Ahora vuelven a polling apenas vence `suscripcion_vence_en` (`examinador.test.ts`). |
| B5 | Media | `services/correo/src/rutas.ts` | En lotes multi-cuenta de Graph, un fallo 503 al encolar una cuenta dejaba marcados como vistos los `avisoIds` de cuentas posteriores. Ahora cada cuenta registra/revierte sus propios `avisos_push_vistos` al momento de encolar. |
| B6 | Media | `services/correo/src/repositorio.ts` | Dos callbacks OAuth concurrentes sin fila previa disparaban `23505` (HTTP 500) en `guardarCuentaConectada`. Se usa `ON CONFLICT DO NOTHING RETURNING id` + re-consulta `FOR UPDATE`. |
| B7 | Media | `services/correo/src/{adaptadores/tipos,adaptadores/gmail,adaptadores/outlook,procesador}.ts` | Un `404` en `leerMensaje` (correo borrado) abortaba todo el bloque de 50 correos. Ahora se mapea a `mensaje-no-encontrado` y se omite individualmente. |
| B8 | Media | `services/usuarios/src/rutas.ts` | `rechazo()` pasaba `req.ip` sin validar, descartando eventos `AccesoRechazado` ante `X-Forwarded-For` inválido. Ahora usa `ipDe(req)`. |
| B9 | Media | `services/usuarios/src/{repositorio,rutas}.ts` | Carrera entre `POST /interna/cuentas` y `POST /itinerarios/:viajeId/designados` podía dejar `usuario_id = NULL`. `designarPersonaConCuenta` y `crearCuenta` comparten `pg_advisory_xact_lock` sobre el email normalizado. |
| B10 | Media | `services/usuarios/src/index.ts`, `services/correo/src/index.ts` | Faltaba `logger` / listener `pool.on('error')` al crear los pools (resuelto vía `crearPool` en `@trotamundos/comun` y pasando `logger`). |
| B11 | Baja | `web/src/pantallas/Whitelist.tsx` | El banner `{aviso}` estaba dentro de `{whitelist && (...)}`, ocultando errores de carga de `GET /whitelist`. Se movió fuera y se cubrió en `web/e2e/pantallas-b.spec.ts`. |
| B12 | Baja | `services/correo/src/rutas.ts` | `DELETE /cuentas-correo/:cuentaId` llamaba `obtenerTokenValido` en vez de `gestorTokens.ejecutarConToken`, fallando sin renovar ante 401 anticipado. |
| B13 | Baja | `services/correo/src/repositorio.ts` | Correos con `From` vacío/inválido en `no_procesados` rompían el `format: email` de `GET /no-procesados`. Se normalizan con `desconocido@remitente.invalid`. |
| B14 | Baja | `services/correo/src/repositorio.ts` | Se mantiene `FOR UPDATE OF cuentas_correo SKIP LOCKED` documentado (impacto acotado para la carga del prototipo, sin bloqueo prolongado cuando el broker confirma normalmente). |
