# Contratos del prototipo

## Alcance

El inventario compara los métodos y rutas de los YAML de OpenAPI con el registro de Express en los servicios. Los esquemas de `comun.yaml` se comparten entre contratos y ese archivo no declara operaciones.

El control HTTP en vivo tiene casos para las 6 operaciones de Asistente y las 8 de Integraciones. Cada caso usa datos de prueba, compara el estado HTTP y el esquema de la respuesta declarada, y genera variantes sin los campos obligatorios del ejemplo. Para un parámetro de ruta se usa un valor inválido, porque eliminar el segmento llamaría a otra ruta. Las operaciones sin campos obligatorios solo tienen el caso válido. Las rutas internas se prueban desde la red de Compose.

La captura de RabbitMQ escucha una cola temporal en cada región mientras corre E2E. Exige observar los seis tipos declarados en AsyncAPI y valida el sobre, el contenido y la región de los mensajes observados. `ViajeAnonimizado` es una fila de Analítica y su esquema se sigue verificando con los ejemplos de la suite estática.

## Diferencias observadas en el inventario

| Dueño | Componente | Diferencia | Referencia |
| --- | --- | --- | --- |
| A | Enrutador global | Tiene un `GET /health` propio. Se describe en Gateway, pero OpenAPI solo declara la operación de salud del Gateway regional. | [Implementación](../services/enrutador/src/app.ts#L210) y [contrato del gateway](../specs/openapi/gateway.yaml) |
| A | Monitor y Gateway | El contrato de Monitor declara `GET /estado` y coincide con el código. La descripción del Monitor en el contrato de Gateway dice que el Monitor no tiene rutas propias. | [Monitor](../specs/openapi/monitor.yaml#L42) y [Gateway](../specs/openapi/gateway.yaml) |

El inventario no encontró operaciones OpenAPI sin registro de ruta en Express. Los reenvíos de login y registro del enrutador corresponden al contrato de Autenticación, donde se definen esas operaciones. El inventario estático revisa las rutas de los servicios, incluidos sus registros de salud compartidos. La comprobación de respuestas requiere la corrida en vivo.

### Advertencias estáticas del validador OpenAPI

Son advertencias del lint sobre los contratos existentes. Su confirmación como diferencias de implementación requiere una prueba HTTP.

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

Las diferencias HTTP de Asistente e Integraciones se muestran con operación y dueño. Las de eventos se muestran con región, tipo y publicador según AsyncAPI. El diagnóstico evita imprimir el mensaje capturado.

## Cobertura HTTP pendiente del equipo

| Dueño | Contratos | Operaciones que faltan probar en vivo |
| --- | --- | ---: |
| A | Autenticación, Gateway y Monitor | 11 |
| B | Correo y Usuarios | 19 |
| C | Analítica y Viajes | 19 |

La corrida #127 capturó los seis tipos de mensajes de RabbitMQ. La verificación en vivo de esta revisión requiere una nueva corrida en GitHub Actions.
