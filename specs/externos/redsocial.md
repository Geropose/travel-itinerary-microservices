# Red social (publicar un itinerario)

Qué imita el mock `mocks/redsocial` (puerto 4007, dueño D). Lo usa el adaptador de redes sociales del
Servicio de Integraciones (Iteración 3, adaptadores de redes sociales; ADR-003) para publicar el
itinerario que el usuario quiere compartir (QA-7: publicación en menos de 3 s). Lo pide el Servicio de
Viajes con `POST /viajes/{viajeId}/compartir-red`, a través de la ruta interna
`POST /interna/redes/publicar` de Integraciones.

## Qué API real imita

El formato está **inspirado en la API de Mastodon**, una red social real con API pública: se publica un
estado con texto, visibilidad e idioma, y la respuesta trae el `id` y la `url` de la publicación (que es lo
que Trotamundos le devuelve al usuario). Se copian solo los campos que usa Trotamundos.

| Tema | Documentación de referencia |
|---|---|
| Publicar un estado (`POST /api/v1/statuses`) | https://docs.joinmastodon.org/methods/statuses/ |
| Recurso `Status` | https://docs.joinmastodon.org/entities/Status/ |
| Límite de caracteres de la instancia | https://docs.joinmastodon.org/entities/Instance/ |

## Datos de prueba

| Dato | Valor |
|---|---|
| `red` en Trotamundos | `redsocial` |
| URL pública simulada | `https://redsocial.example` |

## Autenticación

Cada llamada lleva `Authorization: Bearer <token>`. En Mastodon es el token de la cuenta del usuario (scope
`write:statuses`). En el prototipo el mock acepta un único token configurado por entorno (ver preguntas
abiertas). Sin token o con un token inválido: `401`.

## Publicar

```
POST /api/v1/statuses
Content-Type: application/json
Authorization: Bearer <token>
Idempotency-Key: 0b6c7e1e-2f4b-4b8e-9a77-3f5d1c2e8a90

{
  "status": "Me voy de viaje a Santiago del 10 al 14 de diciembre ✈️\n10/12 08:30 Vuelo AN 1234 Buenos Aires (EZE) → Santiago (SCL)\n10/12 15:00 Hotel Cordillera\n14/12 11:00 Regreso",
  "visibility": "public",
  "language": "es"
}
```

Mastodon documenta los parámetros como formulario; el mock los recibe en JSON, que es lo que manda el
adaptador.

| Campo | Obligatorio | Uso |
|---|---|---|
| `status` | Sí | Texto de la publicación. Máximo 500 caracteres (el valor por defecto de Mastodon, `max_characters`). |
| `visibility` | No | `public` (por defecto), `unlisted`, `private` o `direct`, como Mastodon. |
| `language` | No | Código ISO 639-1 de dos letras: el idioma del usuario (`es`, `en`, ...). |
| Header `Idempotency-Key` | No | Mastodon guarda la clave hasta 1 hora y no publica dos veces lo mismo. Integraciones manda una por pedido, así un reintento no duplica la publicación. |

Respuesta `200 OK` (Mastodon responde `200`, no `201`):

```json
{
  "id": "103254962155278888",
  "created_at": "2026-11-28T15:04:47.196Z",
  "visibility": "public",
  "language": "es",
  "uri": "https://redsocial.example/users/ana_garcia/statuses/103254962155278888",
  "url": "https://redsocial.example/@ana_garcia/103254962155278888",
  "content": "<p>Me voy de viaje a Santiago del 10 al 14 de diciembre ✈️<br />10/12 08:30 Vuelo AN 1234 Buenos Aires (EZE) → Santiago (SCL)<br />10/12 15:00 Hotel Cordillera<br />14/12 11:00 Regreso</p>"
}
```

- `url` es la URL de la publicación que devuelve la ruta interna `POST /interna/redes/publicar`.
- `content` viene en HTML (como en Mastodon); Trotamundos no lo usa.

## Traducción desde la ruta interna de Integraciones

| Ruta interna (`red, itinerario`) | Pedido a la red social |
|---|---|
| `red` | Elige el adaptador y la URL de la red (configuración). |
| `itinerario` | El adaptador arma el texto de `status`: una línea de título con destino y fechas, y una línea por reserva. Si supera los 500 caracteres, recorta las últimas reservas y agrega `…`. |
| Idioma del usuario (claim `idioma` del JWT) | `language` |

## Errores

Formato de Mastodon:

```json
{ "error": "Validation failed: Text can't be blank" }
```

| Código HTTP | Cuándo |
|---|---|
| `401` | Falta el token o es inválido (`{ "error": "The access token is invalid" }`). |
| `422` | `status` vacío o de más de 500 caracteres, o `visibility` inválida. |
| `503` | Falla simulada desde `/admin`. Integraciones responde el error a Viajes y el usuario ve que no se pudo compartir. |

## Preguntas abiertas para la revisión cruzada (P0.5)

- En una red social real cada usuario publica con su propia cuenta, así que tendría que conectarla con
  OAuth (como el correo, ADR-015). La wiki no define esa conexión. Para el prototipo se propone un único
  token por entorno y que el mock publique siempre con una cuenta de prueba.

## Fuera del formato real

Las rutas `/admin/...` del mock (ver las publicaciones, configurar demora y fallas) son solo para pruebas y
las define el mock (P2.D1).
