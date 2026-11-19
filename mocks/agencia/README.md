# Mock de Viajes del Plata (`mocks/agencia`, puerto 4006)

Imita la API externa documentada en `specs/externos/agencia.md` (inspirada en Zendesk Tickets) para
derivar problemas y reclamos a la agencia de viajes preferida del usuario (UC-6).

- Autenticación: `Authorization: Bearer <API_KEY>`.
- `POST /api/v2/tickets` → `201 Created` con `ticket.id`, `status: "new"` y aceptación opcional de
  `ticket.requester`.
- Rutas `/admin`: `GET /admin/casos`, `GET /admin/casos/:id`, `/admin/comportamiento` (demoras y
  fallas `503` / `no-responder`) y `POST /admin/reiniciar`.
