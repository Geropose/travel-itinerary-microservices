# Mock de Rentadora Sur (`mocks/rentadora`, puerto 4005)

Imita la API externa documentada en `specs/externos/rentadora.md` para el proveedor `rentadora-sur`.
No envía webhooks: el adaptador la consulta periódicamente por `updatedSince` con paginación por
número de página.

- Autenticación: `Authorization: Bearer <API_KEY>`.
- `GET /api/v1/bookings?updatedSince=<ISO-UTC>&page=<1..>&pageSize=<1..200>`
- `GET /api/v1/bookings/{confirmationNumber}`
- Semillas coherentes con `mocks/gmail` y `mocks/outlook` (incluyendo `RS-77120`).
- Rutas `/admin`: `/admin/reservas`, `/admin/reservas/:id/{cambiar,cancelar}`, `/admin/tormenta`,
  `/admin/comportamiento` (demoras y fallas `503` / `no-responder`) y `/admin/reiniciar`.
