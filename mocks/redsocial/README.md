# Mock de Red Social (`mocks/redsocial`, puerto 4007)

Imita la API externa documentada en `specs/externos/redsocial.md` (inspirada en Mastodon) para
publicar itinerarios compartidos (QA-7).

- Autenticación: `Authorization: Bearer <API_TOKEN>`.
- `POST /api/v1/statuses` → `200 OK` (máximo 500 caracteres, soporte de `Idempotency-Key` por 1 hora).
- Rutas `/admin`: `GET /admin/publicaciones`, `/admin/comportamiento` (demoras y fallas `503` /
  `no-responder`) y `POST /admin/reiniciar`.
