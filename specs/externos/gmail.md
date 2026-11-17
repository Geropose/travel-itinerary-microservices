# Gmail (Google OAuth 2.0 y Gmail API v1)

Qué imita el mock `mocks/gmail` (puerto 4001, dueño B). Lo usa el adaptador de correo de Gmail del
Servicio de Correo (Iteración 3, adaptadores de correo; ADR-003) para leer los buzones con permiso de
solo lectura (ADR-015) y recibir los avisos de correos nuevos (ADR-010).

Formatos comprobados contra la documentación oficial en noviembre de 2026. Se copian solo los campos que
usa Trotamundos; el mock puede agregar otros, y el adaptador tiene que ignorar los campos que no conoce
(como pide Google).

| Tema | Documentación oficial |
|---|---|
| OAuth 2.0 para aplicaciones web | https://developers.google.com/identity/protocols/oauth2/web-server |
| `users.messages.list` | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list |
| `users.messages.get` | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get |
| Recurso `Message` / `MessagePart` | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages |
| `MessagePartBody` | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments |
| `users.history.list` | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list |
| `users.watch` | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch |
| Notificaciones push | https://developers.google.com/workspace/gmail/api/guides/push |
| Formato push de Pub/Sub | https://cloud.google.com/pubsub/docs/push |
| Errores | https://developers.google.com/workspace/gmail/api/guides/handle-errors |
| Cuotas | https://developers.google.com/workspace/gmail/api/reference/quota |

## Hosts reales y URL del mock

Google usa tres hosts. El mock atiende las mismas rutas en un solo puerto; el adaptador recibe la URL base
por entorno (por ejemplo `GMAIL_URL=http://localhost:4001`) y nunca tiene el host escrito en el código.

| Host real | Para qué | Rutas que imita el mock |
|---|---|---|
| `https://accounts.google.com` | Pantalla de permiso | `GET /o/oauth2/v2/auth` |
| `https://oauth2.googleapis.com` | Canje y renovación de tokens | `POST /token` |
| `https://gmail.googleapis.com` | Gmail API | `GET /gmail/v1/users/{userId}/messages`, `GET /gmail/v1/users/{userId}/messages/{id}`, `GET /gmail/v1/users/{userId}/history`, `POST /gmail/v1/users/{userId}/watch` |

`{userId}` es la dirección de correo o el valor especial `me` (el dueño del token). El adaptador siempre usa
`me`.

## 1. OAuth 2.0 (authorization code)

Scope único: `https://www.googleapis.com/auth/gmail.readonly` (solo lectura, ADR-015).

### 1.1 Pedido de permiso

El Servicio de Correo redirige al usuario a:

```
GET /o/oauth2/v2/auth?
  client_id=trotamundos-local.apps.googleusercontent.com
  &redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fapi%2Fcorreo%2Foauth%2Fcallback
  &response_type=code
  &scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly
  &access_type=offline
  &include_granted_scopes=true
  &state=<state firmado por el Servicio de Correo>
```

`access_type=offline` es obligatorio para Trotamundos: sin él Google no devuelve `refresh_token`.

El mock muestra una pantalla con el botón "Permitir" y redirige a `redirect_uri`:

```
GET {redirect_uri}?code=4/P7q7W91a-oMsCeLvIaQm6bTrgtp7&scope=https://www.googleapis.com/auth/gmail.readonly&state=<el mismo state>
```

Si el usuario rechaza: `GET {redirect_uri}?error=access_denied&state=<el mismo state>`.

### 1.2 Canje del código

```
POST /token
Content-Type: application/x-www-form-urlencoded

code=4/P7q7W91a-oMsCeLvIaQm6bTrgtp7&client_id=trotamundos-local.apps.googleusercontent.com&client_secret=<secreto>&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fapi%2Fcorreo%2Foauth%2Fcallback&grant_type=authorization_code
```

Respuesta `200`:

```json
{
  "access_token": "ya29.a0AfB_byC-ejemplo",
  "expires_in": 3599,
  "refresh_token": "1//0gEjemploDeRefreshToken",
  "scope": "https://www.googleapis.com/auth/gmail.readonly",
  "token_type": "Bearer"
}
```

- `expires_in`: segundos de vida del access token (Google da alrededor de una hora).
- `scope`: scopes concedidos separados por espacio. El adaptador tiene que comprobar que incluya
  `gmail.readonly`.

### 1.3 Renovación del token

```
POST /token
Content-Type: application/x-www-form-urlencoded

client_id=trotamundos-local.apps.googleusercontent.com&client_secret=<secreto>&refresh_token=1//0gEjemploDeRefreshToken&grant_type=refresh_token
```

Respuesta `200`: igual que el canje pero **sin** `refresh_token` (se sigue usando el mismo).

```json
{
  "access_token": "ya29.a0AfB_nuevoToken",
  "expires_in": 3599,
  "scope": "https://www.googleapis.com/auth/gmail.readonly",
  "token_type": "Bearer"
}
```

### 1.4 Errores de `/token`

Formato OAuth 2.0 (RFC 6749, sección 5.2), código `400`:

```json
{ "error": "invalid_grant", "error_description": "Bad Request" }
```

`invalid_grant`: código vencido o ya usado, o refresh token revocado. El adaptador marca la cuenta como
desconectada y el usuario tiene que volver a dar permiso (ADR-015, consecuencia "Malo").

### 1.5 Uso del token

Todas las llamadas a la Gmail API llevan `Authorization: Bearer <access_token>`. Si el token venció, es
inválido o no tiene el scope pedido, Gmail responde `401`:

```json
{
  "error": {
    "errors": [
      {
        "domain": "global",
        "reason": "authError",
        "message": "Invalid Credentials",
        "locationType": "header",
        "location": "Authorization"
      }
    ],
    "code": 401,
    "message": "Invalid Credentials"
  }
}
```

## 2. `users.messages.list`

```
GET /gmail/v1/users/me/messages?q=after:1764331200&maxResults=100&pageToken=<opcional>
```

| Parámetro | Uso en Trotamundos |
|---|---|
| `q` | Búsqueda con la sintaxis de Gmail. El mock solo necesita `after:<segundos epoch>` y `from:<dirección>`. |
| `maxResults` | Por defecto 100, máximo 500. |
| `pageToken` | Página siguiente. |

Respuesta `200` (cada mensaje trae solo `id` y `threadId`):

```json
{
  "messages": [
    { "id": "18c4f2a9d7e3b001", "threadId": "18c4f2a9d7e3b001" },
    { "id": "18c4f1b2a0c4d002", "threadId": "18c4f1b2a0c4d002" }
  ],
  "nextPageToken": "09876543211234567890",
  "resultSizeEstimate": 2
}
```

Sin resultados, Gmail omite `messages` y `nextPageToken`: `{ "resultSizeEstimate": 0 }`.

## 3. `users.messages.get` con `format=full`

```
GET /gmail/v1/users/me/messages/18c4f2a9d7e3b001?format=full
```

Respuesta `200`: un `Message`. `payload` es el árbol MIME (`MessagePart`): `headers` solo en la parte de
arriba y en cada parte; `body.data` en **base64url** (alfabeto `-` y `_`, RFC 4648 sección 5), vacío en las
partes contenedoras `multipart/*`.

```json
{
  "id": "18c4f2a9d7e3b001",
  "threadId": "18c4f2a9d7e3b001",
  "labelIds": ["INBOX", "UNREAD"],
  "snippet": "Tu reserva XKQ7PL está confirmada.",
  "historyId": "9876543210",
  "internalDate": "1764331950000",
  "sizeEstimate": 5120,
  "payload": {
    "partId": "",
    "mimeType": "multipart/alternative",
    "filename": "",
    "headers": [
      { "name": "From", "value": "Aerolínea Andina <reservas@aerolinea-andina.example>" },
      { "name": "To", "value": "ana.garcia@gmail.com" },
      { "name": "Subject", "value": "Confirmación de tu reserva XKQ7PL" },
      { "name": "Date", "value": "Fri, 28 Nov 2026 12:12:30 +0000" },
      { "name": "Message-ID", "value": "<xkq7pl.1764331950@aerolinea-andina.example>" }
    ],
    "body": { "size": 0 },
    "parts": [
      {
        "partId": "0",
        "mimeType": "text/plain",
        "filename": "",
        "headers": [{ "name": "Content-Type", "value": "text/plain; charset=UTF-8" }],
        "body": { "size": 37, "data": "VHUgcmVzZXJ2YSBYS1E3UEwgZXN0w6EgY29uZmlybWFkYS4NCg" }
      },
      {
        "partId": "1",
        "mimeType": "text/html",
        "filename": "",
        "headers": [{ "name": "Content-Type", "value": "text/html; charset=UTF-8" }],
        "body": { "size": 4810, "data": "PGh0bWw-PGJvZHk-PHNjcmlwdCB0eXBlPSJhcHBsaWNhdGlvbi9sZCtqc29u..." }
      }
    ]
  }
}
```

(El `data` del HTML está recortado en el ejemplo.) Decodificado, el HTML trae el marcado JSON-LD de
schema.org descripto en [correos-reserva.md](correos-reserva.md).

Campos que usa el procesador de correo:

| Campo | Para qué |
|---|---|
| `id` | `correoId` del evento `ReservaDetectada` y clave para no procesar dos veces el mismo correo. |
| `historyId` | Punto de partida de la próxima revisión. |
| `internalDate` | Fecha de recepción (milisegundos epoch, como string). |
| Header `From` | Filtro de remitentes (whitelist, Iteración 5) y reconocimiento del proveedor. |
| Parte `text/html` | JSON-LD schema.org; si no hay, reglas de texto. |
| Parte `text/plain` | Reglas de texto cuando no hay marcado. |

## 4. `users.history.list`

Lista los cambios del buzón desde un `historyId` conocido. Es lo que usa el procesador después de un aviso
push o en cada revisión periódica.

```
GET /gmail/v1/users/me/history?startHistoryId=9876543000&historyTypes=messageAdded&maxResults=100
```

Respuesta `200`:

```json
{
  "history": [
    {
      "id": "9876543210",
      "messages": [{ "id": "18c4f2a9d7e3b001", "threadId": "18c4f2a9d7e3b001" }],
      "messagesAdded": [
        {
          "message": {
            "id": "18c4f2a9d7e3b001",
            "threadId": "18c4f2a9d7e3b001",
            "labelIds": ["INBOX", "UNREAD"]
          }
        }
      ]
    }
  ],
  "historyId": "9876543210"
}
```

- Sin cambios, Gmail omite `history` y devuelve solo el `historyId` actual.
- `historyId` de la respuesta: se guarda para la próxima consulta.
- Si `startHistoryId` es demasiado viejo o inválido, Gmail responde `404`; el adaptador hace una
  sincronización completa con `messages.list` (`q=after:<última revisión>`).

## 5. `users.watch` (activar avisos push)

```
POST /gmail/v1/users/me/watch
Content-Type: application/json

{ "topicName": "projects/trotamundos/topics/gmail-avisos", "labelIds": ["INBOX"], "labelFilterBehavior": "include" }
```

Respuesta `200`:

```json
{ "historyId": "9876543000", "expiration": "1764936750000" }
```

- `expiration`: cuándo deja de avisar (milisegundos epoch). Hay que repetir `watch` antes: Google pide al
  menos cada 7 días y recomienda una vez por día.
- Un `watch` exitoso manda enseguida una notificación.
- En Google, `topicName` es un tópico de Cloud Pub/Sub y la URL de destino se configura en la suscripción
  push de ese tópico. El mock no tiene Pub/Sub: envía la notificación a la URL configurada por entorno
  (por ejemplo `AVISOS_URL=http://localhost:3003/notificaciones/gmail`, ruta de P2.B5).

## 6. Notificación push (formato Pub/Sub)

Cuando entra un correo a un buzón con `watch` activo, el mock hace:

```
POST {URL de avisos}
Content-Type: application/json

{
  "message": {
    "data": "eyJlbWFpbEFkZHJlc3MiOiJhbmEuZ2FyY2lhQGdtYWlsLmNvbSIsImhpc3RvcnlJZCI6Ijk4NzY1NDMyMTAifQ==",
    "messageId": "2070443601311540",
    "message_id": "2070443601311540",
    "publishTime": "2026-11-28T12:12:31.749Z",
    "publish_time": "2026-11-28T12:12:31.749Z"
  },
  "subscription": "projects/trotamundos/subscriptions/gmail-avisos-push"
}
```

`message.data` decodificado:

```json
{ "emailAddress": "ana.garcia@gmail.com", "historyId": "9876543210" }
```

- El aviso **no** trae el correo: solo dice qué buzón cambió y su `historyId` nuevo. El Examinador encola
  ese buzón y el procesador llama a `history.list` desde el último `historyId` guardado (ADR-010).
- `message.data` va en base64 (la guía de Pub/Sub dice base64 y la de Gmail, base64url): el adaptador acepta
  los dos alfabetos.
- `messageId` es de Pub/Sub, no del correo. Puede llegar repetido: el adaptador lo ignora si ya lo vio.
- Responder `200` (o cualquier `2xx`) confirma el aviso. Si la respuesta es un error o tarda demasiado, el
  mock lo reintenta más tarde, como Pub/Sub.
- Gmail manda como máximo un aviso por segundo por buzón y puede perder alguno: por eso el Examinador
  sigue revisando por intervalo aunque haya avisos.

## 7. Límites de uso (QA-7)

Gmail mide cuotas por usuario: **6.000 unidades por minuto por usuario** (y 1.200.000 por minuto por
proyecto). Costo de cada método:

| Método | Unidades |
|---|---|
| `messages.list` | 5 |
| `messages.get` | 20 (60 con `format=full`, `raw` o `html`) |
| `history.list` | 2 |
| `watch` | 100 |

Al superar el límite, Gmail responde `429 Too Many Requests` (o `403` con `reason: "rateLimitExceeded"`),
con el formato de error de la sección 1.5. El mock aplica el mismo límite (configurable) y responde `429`
con `reason: "rateLimitExceeded"`; el Examinador espera con retroceso exponencial (P2.B5).

## Fuera del formato real

Las rutas `/admin/...` del mock (inyectar correos, generador de correos, semillas) son solo para pruebas y
las define el mock (P2.B1). No forman parte de este contrato.
