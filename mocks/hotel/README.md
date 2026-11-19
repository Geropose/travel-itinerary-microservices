# Mock de Hotel Cordillera (`mocks/hotel`, puerto 4004)

Imita la API externa documentada en `specs/externos/hotel.md` para el proveedor `hotel-cordillera`.
No envía webhooks: el adaptador lo consulta periódicamente por `modifiedSince`.

- Autenticación: header `X-Api-Key`.
- `GET /v1/reservations?modifiedSince=<ISO-UTC>&limit=<1..500>&cursor=<opaque>`
- `GET /v1/reservations/{reservationId}`
- Semillas coherentes con `mocks/gmail` y `mocks/outlook` (incluyendo `HC-48213`).
- Rutas `/admin`: `/admin/reservas`, `/admin/reservas/:id/{cambiar,cancelar}`, `/admin/tormenta`,
  `/admin/comportamiento` (demoras y fallas `503` / `no-responder`) y `/admin/reiniciar`.
