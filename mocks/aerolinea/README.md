# Mock de Aerolínea Andina (`mocks/aerolinea`, puerto 4003)

Imita la API externa documentada en `specs/externos/aerolinea.md` (inspirada en Duffel) para el
proveedor `aerolinea-andina`:

- Consulta de órdenes: `GET /air/orders?booking_reference=...` y `GET /air/orders/{id}`.
- Webhooks firmados (`X-Webhook-Signature: t=<epoch>,v1=<HMAC-SHA256>`):
  `order.airline_initiated_change_detected` y `order.updated`, con reintentos exponenciales.
- Reprogramaciones: `POST /air/order_change_requests` (0 a 3 ofertas) y `POST /air/order_changes`.
- Semillas coherentes con `mocks/gmail` y `mocks/outlook` (incluyendo `XKQ7PL`).
- Rutas `/admin`: `/admin/ordenes`, `/admin/ordenes/:ref/{cambiar,cancelar,opciones}`,
  `/admin/tormenta`, `/admin/webhooks`, `/admin/comportamiento` (demoras y fallas `503` /
  `no-responder`) y `/admin/reiniciar`.
