# Contratos del prototipo

## Alcance

El inventario compara los métodos y rutas de los YAML de OpenAPI con el registro de Express en los servicios. Los esquemas de `comun.yaml` se comparten entre contratos y ese archivo no declara operaciones.

El control HTTP en vivo tiene casos para las **63 operaciones de los 9 contratos OpenAPI**:
- **Dueño A** (`tests/e2e/openapi-a.test.ts`): 1 operación de Gateway, 2 de Monitor y 8 de Autenticación (11 en total).
- **Dueño B** (`tests/e2e/openapi-b.test.ts`): 11 operaciones de Usuarios y 8 de Correo (19 en total).
- **Dueño C** (`tests/e2e/openapi-c.test.ts`): 13 operaciones de Viajes y 6 de Analítica (19 en total).
- **Dueño D** (`tests/e2e/openapi-d.test.ts`): 6 operaciones de Asistente y 8 de Integraciones (14 en total).

Cada caso usa datos de prueba, compara el estado HTTP y el esquema de la respuesta declarada, y genera variantes sin los campos obligatorios del ejemplo (tanto en el cuerpo JSON como en query params, incluyendo `oneOf` en Analítica y `required` condicional `if`/`then` en Viajes). Para un parámetro de ruta se usa un valor inválido, porque eliminar el segmento llamaría a otra ruta. Las operaciones sin campos obligatorios solo tienen el caso válido. Las rutas internas (`/interna/*`), las de Monitor y la salud directa de Gateway se prueban desde la red de Compose de la región.

La captura de RabbitMQ escucha una cola temporal en cada región mientras corre E2E. Exige observar los seis tipos declarados en AsyncAPI y valida el sobre, el contenido y la región de los mensajes observados. `ViajeAnonimizado` es una fila de Analítica y su esquema se sigue verificando con los ejemplos de la suite estática.

## Diferencias observadas en el inventario

| Dueño | Componente | Diferencia | Estado | Referencia |
| --- | --- | --- | --- | --- |
| A | Enrutador global | Tiene un `GET /health` propio para el healthcheck de Docker. Se describe en Gateway, pero OpenAPI solo declara la operación de salud del Gateway regional. | Documentado en el contrato de Gateway | [Implementación](../services/enrutador/src/app.ts#L226) y [contrato del gateway](../specs/openapi/gateway.yaml) |
| A | Monitor y Gateway | El contrato de Monitor declara `GET /health` y `GET /estado` y coincide con el código. La descripción del Monitor en el contrato de Gateway decía que el Monitor no tenía rutas propias. | **Resuelto en P5.2:** `gateway.yaml` ahora referencia `specs/openapi/monitor.yaml`. | [Monitor](../specs/openapi/monitor.yaml#L42) y [Gateway](../specs/openapi/gateway.yaml#L120) |
| C | Viajes (`consultarDuenoViaje`) | `GET /interna/viajes/{viajeId}/dueno` recibe `ViajeId` (`format: uuid`) y el servicio responde `400` ante un UUID inválido, pero el contrato solo declaraba `200`, `401`, `403` y `404`. | **Resuelto en P5.2:** se agregó `'400'` (`SolicitudInvalida`) en `viajes.yaml`. | [Viajes](../specs/openapi/viajes.yaml#L431) |

El inventario no encontró operaciones OpenAPI sin registro de ruta en Express. Los reenvíos de login, registro y webhooks de proveedores del enrutador corresponden a los contratos de Autenticación e Integraciones, donde se definen esas operaciones. El inventario estático revisa las rutas de los servicios, incluidos sus registros de salud compartidos.

### Advertencias estáticas del validador OpenAPI

Son advertencias del lint sobre los contratos existentes.

| Dueño | Contrato | Advertencia |
| --- | --- | --- |
| A | Autenticación, Gateway y Monitor | Autenticación no declara respuestas 4xx para `GET /health` y `GET /.well-known/jwks.json`. Gateway y Monitor tampoco las declaran para sus rutas `GET /health`. Monitor tampoco las declara para `GET /estado`. |
| B | Correo y Usuarios | Los dos `GET /health` no declaran respuestas 4xx. El callback OAuth de Correo declara una redirección y el lint indica que falta una respuesta 2xx. |
| C | Analítica y Viajes | Los dos `GET /health` no declaran respuestas 4xx. El lint señala rutas potencialmente ambiguas en Analítica y marca el `required` condicional de `origen` en `Reserva` y `NuevaReserva` de Viajes. |
| D | Asistente e Integraciones | Los dos `GET /health` no declaran respuestas 4xx. |

### Diferencia HTTP del webhook de Aerolínea Andina

**Dueño D · Integraciones (Resuelto en PR #56).** El adaptador en [aerolinea.ts](../services/integraciones/src/adaptadores/aerolinea.ts) ahora valida todos los campos obligatorios de `AvisoAerolinea`, `OrdenAerolinea` y `SegmentoAerolinea` (incluidos `removed` y `added`) antes de traducir, devolviendo `no-traducido` cuando falta cualquiera de ellos. Se eliminó la excepción `camposAceptadosPendientes` en [la prueba de contrato de Integraciones](../tests/e2e/openapi-d.test.ts) para verificar de forma estricta el contrato [AvisoAerolinea](../specs/openapi/integraciones.yaml#L1128).

## Cómo ejecutar

```bash
npm ci
npm run test:contratos
npm run infra:levantar
npm run test:contratos -- --en-vivo
npm run infra:bajar
```

La CI tiene un job que levanta el prototipo, ejecuta el modo en vivo y baja los contenedores. En ese job, Integraciones consulta a los proveedores cada 5 segundos para que el hotel pueda actualizarse dentro de los 30 segundos de la prueba UC-3. Compose conserva los 120 segundos como valor por defecto. Para reproducir el intervalo de CI en Bash, ejecutar `INTERVALO_CONSULTA_PROVEEDORES_SEG=5 npm run infra:levantar` antes de probar en vivo.

Las diferencias HTTP se muestran con operación y dueño (`A`, `B`, `C` o `D`). Las de eventos se muestran con región, tipo y publicador según AsyncAPI. El diagnóstico evita imprimir el mensaje capturado.

## Cobertura HTTP del equipo

| Dueño | Contratos | Operaciones verificadas en vivo | Operaciones pendientes |
| --- | --- | ---: | ---: |
| A | Autenticación (8), Gateway (1) y Monitor (2) | 11 | 0 |
| B | Usuarios (11) y Correo (8) | 19 | 0 |
| C | Viajes (13) y Analítica (6) | 19 | 0 |
| D | Asistente (6) e Integraciones (8) | 14 | 0 |
| **Total** | **9 contratos OpenAPI** | **63** | **0** |

Además de las 63 operaciones HTTP en vivo, la corrida en vivo verifica los 6 eventos publicados en RabbitMQ contra `specs/asyncapi/eventos.yaml`.
