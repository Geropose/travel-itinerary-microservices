# Auditoría de Plataforma, Seguridad y Web Base (P5.1 · Dueño A)

Auditoría cruzada sobre `@trotamundos/comun`, `autenticacion`, `gateway`, `monitor`, `enrutador` y la capa base de `web/` contra los contratos OpenAPI, esquemas de eventos y `docs/CONVENCIONES.md`.

## Resumen de hallazgos resueltos (PR #57)

| ID | Gravedad | Componente | Problema y resolución |
| --- | --- | --- | --- |
| A1 | Alta | `packages/comun/src/spec.ts` | `aRegex` compilaba case-sensitive y Express atendía en case-insensitive: rutas en mayúsculas salteaban `validador.middleware` y `sinValidador`. Se compiló `RegExp(..., 'i')` y se agregó prueba en `validador.test.ts` y `servidor.test.ts`. |
| A2 | Alta | `packages/comun/src/db.ts`, `autenticacion`, `gateway` | `crearPool` no registraba `pool.on('error')`, cayendo ante desconexiones de PostgreSQL. Se aceptó `logger` y `connectionTimeoutMillis` (5 s por defecto) y se registró listener de errores en `crearPool`, verificando en `packages/comun/test/db.test.ts`. |
| A3 | Alta | `services/enrutador/src/app.ts` | Faltaba el fan-out en paralelo a ambas regiones para `POST /api/integraciones/webhooks/proveedores/:proveedor` sin prefijo/JWT/`X-Region` (retornando primer `2xx` o peor status). Implementado y probado en `enrutador.test.ts`. |
| A4 | Alta | `services/autenticacion/` | Race concurrente en `/login` sobre `intentos_fallidos`. Se agregó `002_intentos_fallidos_id.sql` + `reservarIntentoLogin` con `pg_advisory_xact_lock` y `borrarIntentoPorId` en derivados `307`, probado en `services/autenticacion/test/auditoria.test.ts`. |
| A5 | Alta | `services/autenticacion/`, `services/usuarios/` | Timeout en `/interna/cuentas` dejaba cuenta huérfana y el reintento fallaba con `409`. Se hizo idempotente `crearCuenta` para el mismo `(usuarioId, email, region)` y `/registro` reintenta una vez ante `ErrorTiempoAgotado`. |
| A6 | Alta | `web/src/api/cliente.ts` | Un `503`/`5xx` en `/renovar` cerraba la sesión. Ahora solo `400`/`401` cierra la sesión y se valida que no haya cambiado `tokenRenovacion` en paralelo (`web/test/cliente.test.ts`). |
| A7 | Alta | `packages/comun/src/{http,servidor,validador}.ts` | `rutaParaLog` ahora redacta segmentos con `@`/`%40` y quita query strings en logs de servidor, `AccesoRechazado` y errores de `crearClienteHttp` (`http.test.ts`, `servidor.test.ts`, `validador.test.ts`). |
| A8 | Media | `services/autenticacion/src/rutas.ts` | `rechazo()` enviaba `req.ip` sin validar a `AccesoRechazado`. Ahora usa `ipDe(req)` exportado por `@trotamundos/comun`. |
| A9 | Media | `packages/comun/src/db.ts` | `enTransaccion` y `migrar` podían devolver conexiones con transacción abortada o `pg_advisory_lock` retenido ante fallos de `ROLLBACK`/unlock. Ahora destruyen la conexión con `cliente.release(true)`. |
| A10 | Media | `services/monitor/src/vigilante.ts` | Un ciclo lento disparaba ráfagas de `setTimeout(..., 0)` y `iniciar()` no era idempotente. Se reprograma desde el fin real del ciclo si quedó atrasado y se protege `iniciar()`. |
| A11 | Media | `services/monitor/src/vigilante.ts` | `reiniciar()` incrementaba `reinicios` antes de completar Docker, podía pisar `sana` si fallaba tarde y permitía reinicios solapados. Corregido y cubierto en `vigilante.test.ts`. |
| A12 | Media | `services/monitor/src/docker.ts` | `JSON.parse` sin `try/catch` ni `res.on('error')` en `end` podía tumbar el proceso del monitor; cubierto en `docker.test.ts`. |
| A13 | Media | `packages/comun/src/http.ts` | Timeout leyendo el cuerpo escapaba del `try/catch` de `ErrorTiempoAgotado` y JSON inválido en `502` lanzaba `SyntaxError`. Cubierto en `http.test.ts`. |
| A14 | Media | `web/src/{api/cliente,acciones,main}.tsx` | Se protege `renovar()` contra cambios de sesión concurrentes, `cerrarSesion` acota `/logout` con timeout y limpia siempre en `finally`, y `alVencer` limpia el panel cacheado en IndexedDB (`cliente.test.ts`, `acceso.test.ts`). |
| A15 | Baja | `packages/comun/src/validador.ts` | `verificarToken` recarga JWKS de forma deduplicada (cooldown 30 s) y reintenta una vez ante `ERR_JWKS_NO_MATCHING_KEY` (`validador.test.ts`). |
| A16 | Baja | `packages/comun/src/{broker,outbox}.ts` | Se documenta para revisión posterior (baja probabilidad en entorno Docker Compose con reconexión automática). |
| A17 | Baja | `packages/comun/src/servidor.ts` | `sinValidador` ahora incluye `contextoActual()?.requestId` para coincidir con el header `X-Request-Id` (`servidor.test.ts`). |
| A18 | Baja | `web/src/{acciones,pantallas/Acceso}.tsx` | `/login` mapea `400` a `credenciales`, `recordarRegion` tolera fallos de almacenamiento y `useEnvio` limpia `enviando` en `finally` (`web/test/acceso.test.ts`). |
