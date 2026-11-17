# Outlook (Microsoft identity platform y Microsoft Graph v1.0)

Qué imita el mock `mocks/outlook` (puerto 4002, dueño B). Lo usa el adaptador de correo de Outlook del
Servicio de Correo (Iteración 3, adaptadores de correo; ADR-003) para leer los buzones con permiso de
solo lectura (ADR-015) y recibir los avisos de correos nuevos (ADR-010).

Formatos comprobados contra la documentación oficial en noviembre de 2026. Se copian solo los campos que
usa Trotamundos; el adaptador tiene que ignorar los campos que no conoce.

| Tema | Documentación oficial |
|---|---|
| OAuth 2.0 authorization code | https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow |
| Listar mensajes | https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0 |
| Obtener un mensaje | https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0 |
| Recurso `message` | https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0 |
| Recurso `itemBody` | https://learn.microsoft.com/en-us/graph/api/resources/itembody?view=graph-rest-1.0 |
| Crear suscripción | https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions?view=graph-rest-1.0 |
| Renovar suscripción | https://learn.microsoft.com/en-us/graph/api/subscription-update?view=graph-rest-1.0 |
| Recurso `subscription` (vida máxima) | https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0 |
| Validación y change notifications | https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks |
| Errores | https://learn.microsoft.com/en-us/graph/errors |
| Errores de autorización | https://learn.microsoft.com/en-us/graph/resolve-auth-errors |
| Límites (429) | https://learn.microsoft.com/en-us/graph/throttling |

## Hosts reales y URL del mock

El mock atiende las mismas rutas en un solo puerto; el adaptador recibe la URL base por entorno (por
ejemplo `OUTLOOK_URL=http://localhost:4002`).

| Host real | Para qué | Rutas que imita el mock |
|---|---|---|
| `https://login.microsoftonline.com` | Permiso y tokens | `GET /{tenant}/oauth2/v2.0/authorize`, `POST /{tenant}/oauth2/v2.0/token` |
| `https://graph.microsoft.com` | Microsoft Graph | `GET /v1.0/me/messages`, `GET /v1.0/me/messages/{id}`, `POST /v1.0/subscriptions`, `PATCH /v1.0/subscriptions/{id}` |

`{tenant}` es `common` (cuentas personales y de trabajo). El mock acepta cualquier valor.

## 1. OAuth 2.0 (authorization code)

Scopes: `offline_access https://graph.microsoft.com/Mail.Read`. `Mail.Read` es solo lectura (ADR-015);
`offline_access` hace falta para recibir `refresh_token`.

### 1.1 Pedido de permiso

```
GET /common/oauth2/v2.0/authorize?
  client_id=11112222-bbbb-3333-cccc-4444dddd5555
  &response_type=code
  &redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fapi%2Fcorreo%2Foauth%2Fcallback
  &response_mode=query
  &scope=offline_access%20https%3A%2F%2Fgraph.microsoft.com%2FMail.Read
  &state=<state firmado por el Servicio de Correo>
```

El mock muestra el botón "Permitir" y redirige:

```
GET {redirect_uri}?code=OAAABAAAAiL9Kn2Z27UubvWFPbm0gLWQJVzCTE9UkP3pSx1aXxUjq3n8b2JRLk4OxVXr&state=<el mismo state>
```

Si el usuario rechaza:

```
GET {redirect_uri}?error=access_denied&error_description=the+user+canceled+the+authentication&state=<el mismo state>
```

El código vence en alrededor de 1 minuto.

### 1.2 Canje del código

```
POST /common/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

client_id=11112222-bbbb-3333-cccc-4444dddd5555&scope=offline_access%20https%3A%2F%2Fgraph.microsoft.com%2FMail.Read&code=OAAABAAAAiL9Kn2Z27UubvWFPbm0gLWQJVzCTE9UkP3pSx1aXxUjq3n8b2JRLk4OxVXr&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fapi%2Fcorreo%2Foauth%2Fcallback&grant_type=authorization_code&client_secret=<secreto>
```

Respuesta `200`:

```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.ejemplo",
  "token_type": "Bearer",
  "expires_in": 3599,
  "scope": "https://graph.microsoft.com/Mail.Read",
  "refresh_token": "AwABAAAAvPM1KaPlrEqdFSBzjqfTGAMxZGUTdM0t4B4ejemplo"
}
```

El adaptador comprueba que `scope` incluya `Mail.Read`. El access token es opaco para Trotamundos: no se
decodifica ni se valida (Microsoft lo desaconseja).

### 1.3 Renovación del token

```
POST /common/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

client_id=11112222-bbbb-3333-cccc-4444dddd5555&scope=offline_access%20https%3A%2F%2Fgraph.microsoft.com%2FMail.Read&refresh_token=AwABAAAAvPM1KaPlrEqdFSBzjqfTGAMxZGUTdM0t4B4ejemplo&grant_type=refresh_token&client_secret=<secreto>
```

Respuesta `200`: mismo formato que el canje. Trae un `refresh_token` **nuevo**: el adaptador reemplaza el
guardado por este (Microsoft pide descartar el anterior).

### 1.4 Errores de `/token`

Código `400`. Ejemplo de la documentación, con un scope inválido:

```json
{
  "error": "invalid_scope",
  "error_description": "AADSTS70011: The provided value for the input parameter 'scope' is not valid. The scope https://foo.microsoft.com/mail.read is not valid.",
  "error_codes": [70011],
  "timestamp": "2016-01-09 02:02:12Z",
  "trace_id": "0000aaaa-11bb-cccc-dd22-eeeeee333333",
  "correlation_id": "aaaa0000-bb11-2222-33cc-444444dddddd"
}
```

Un código vencido o ya usado, o un refresh token revocado, devuelven el mismo formato con
`"error": "invalid_grant"`. En ese caso el adaptador marca la cuenta como desconectada y el usuario tiene
que volver a dar permiso. El adaptador solo mira `error`; `error_description` es para los logs.

### 1.5 Uso del token y errores de Graph

Todas las llamadas a Graph llevan `Authorization: Bearer <access_token>`. Si el token venció o es inválido,
Graph responde `401` con el formato de error de Graph:

```json
{
  "error": {
    "code": "InvalidAuthenticationToken",
    "message": "Access token has expired or is not yet valid.",
    "innerError": {
      "date": "2026-11-28T12:12:30",
      "request-id": "94fb3b52-452a-4535-a601-69e0a90e3aa2"
    }
  }
}
```

El adaptador renueva el token (1.3) y repite la llamada una sola vez.

## 2. Listar mensajes nuevos

```
GET /v1.0/me/messages?$filter=receivedDateTime ge 2026-11-28T12:00:00Z&$orderby=receivedDateTime asc&$select=id,receivedDateTime,from,subject,body,internetMessageId&$top=50
Prefer: outlook.body-content-type="html"
```

| Parámetro | Uso en Trotamundos |
|---|---|
| `$filter` | Solo `receivedDateTime ge <fecha ISO 8601 en UTC>`: los correos desde la última revisión. |
| `$orderby` | `receivedDateTime asc`. Graph exige que la propiedad del `$orderby` esté también en el `$filter` (si no, error `InefficientFilter`). |
| `$select` | Las propiedades de la tabla de abajo. |
| `$top` | Tamaño de página. Por defecto 10, de 1 a 1000. |
| `Prefer` | `outlook.body-content-type="html"` o `"text"`. Sin el header, el cuerpo viene en HTML. |

Respuesta `200`:

```json
{
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#users('6b1e7c2a-4f3d-4e8b-9c0a-1d2e3f4a5b6c')/messages(id,receivedDateTime,from,subject,body,internetMessageId)",
  "value": [
    {
      "@odata.etag": "W/\"CQAAABYAAADHcgC8Hl9tRZ/hc1wEUs1TAAAwR4Hg\"",
      "id": "AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZiLTU1OGY5OTZhYmY4OABGAAAAAAAiQ8W967B7TKBjgx9rVEURBwAiIsqMbYjsT5e-T7KzowPTAAAAAAEMAAAiIsqMbYjsT5e-T7KzowPTAAAYbvZDAAA=",
      "receivedDateTime": "2026-11-28T12:12:30Z",
      "subject": "Confirmación de tu reserva XKQ7PL",
      "internetMessageId": "<xkq7pl.1764331950@aerolinea-andina.example>",
      "from": {
        "emailAddress": {
          "name": "Aerolínea Andina",
          "address": "reservas@aerolinea-andina.example"
        }
      },
      "body": {
        "contentType": "html",
        "content": "<html><body><script type=\"application/ld+json\">{\"@context\":\"http://schema.org\",\"@type\":\"FlightReservation\",\"reservationNumber\":\"XKQ7PL\"}</script><p>Tu reserva XKQ7PL está confirmada.</p></body></html>"
      }
    }
  ],
  "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$filter=receivedDateTime+ge+2026-11-28T12%3a00%3a00Z&$orderby=receivedDateTime+asc&$select=id%2creceivedDateTime%2cfrom%2csubject%2cbody%2cinternetMessageId&$top=50&$skip=50"
}
```

(El JSON-LD del ejemplo está recortado; el completo está en [correos-reserva.md](correos-reserva.md).)

- A diferencia de Gmail, el cuerpo viene como texto (`body.content`), **no** en base64.
- Para la página siguiente se usa la URL de `@odata.nextLink` tal cual (no se arma a mano el `$skip`). Si
  no viene `@odata.nextLink`, no hay más páginas.

Campos que usa el procesador de correo:

| Campo | Para qué |
|---|---|
| `id` | `correoId` del evento `ReservaDetectada` y clave para no procesar dos veces el mismo correo. |
| `receivedDateTime` | Fecha de recepción (UTC); la mayor se guarda como punto de partida de la próxima revisión. |
| `from.emailAddress.address` | Filtro de remitentes (whitelist, Iteración 5) y reconocimiento del proveedor. |
| `subject` | Reglas de texto cuando no hay marcado. |
| `body.contentType` / `body.content` | JSON-LD schema.org; si no hay, reglas de texto. |
| `internetMessageId` | Solo para rastrear el correo en los logs. |

## 3. Obtener un mensaje

Se usa al recibir un aviso (sección 5), que trae solo el `id`.

```
GET /v1.0/me/messages/{id}?$select=id,receivedDateTime,from,subject,body,internetMessageId
Prefer: outlook.body-content-type="html"
```

Respuesta `200`: un objeto `message` con los mismos campos que cada elemento de `value` en la sección 2.
Si el `id` no existe, `404` con el formato de error de Graph.

## 4. Suscripción a avisos (change notifications)

### 4.1 Crear la suscripción

```
POST /v1.0/subscriptions
Content-Type: application/json

{
  "changeType": "created",
  "notificationUrl": "http://localhost:3003/notificaciones/outlook",
  "resource": "me/mailFolders('Inbox')/messages",
  "expirationDateTime": "2026-12-05T12:00:00Z",
  "clientState": "<secreto aleatorio por cuenta, guardado por el Servicio de Correo>"
}
```

Antes de responder, Graph valida la `notificationUrl` (4.2). Respuesta `201 Created`:

```json
{
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#subscriptions/$entity",
  "id": "7f105c7d-2dc5-4530-97cd-4e7ae6534c07",
  "resource": "me/mailFolders('Inbox')/messages",
  "applicationId": "11112222-bbbb-3333-cccc-4444dddd5555",
  "changeType": "created",
  "clientState": "<el mismo secreto>",
  "notificationUrl": "http://localhost:3003/notificaciones/outlook",
  "expirationDateTime": "2026-12-05T12:00:00Z",
  "creatorId": "8ee44408-0679-472c-bc2a-692812af3437",
  "latestSupportedTlsVersion": "v1_2",
  "notificationContentType": "application/json"
}
```

- Vida máxima para mensajes de Outlook: **10.080 minutos (menos de 7 días)**. Un pedido con menos de 45
  minutos se lleva a 45 minutos.
- Si la validación de la URL falla, Graph no crea la suscripción y responde `400 Bad Request`.
- Una suscripción con el mismo `changeType` y `resource` que otra existente responde `409 Conflict`.

### 4.2 Validación de la URL (handshake de `validationToken`)

Al crear la suscripción, Graph llama a la `notificationUrl`:

```
POST {notificationUrl}?validationToken=token%20opaco%3A%20f2b1d6a0
Content-Type: text/plain; charset=utf-8
```

El Servicio de Correo tiene que responder **dentro de 10 segundos** con:

```
HTTP/1.1 200 OK
Content-Type: text/plain

token opaco: f2b1d6a0
```

Es decir: código `200`, `Content-Type: text/plain` y el `validationToken` decodificado de la URL, en texto
plano (no codificado). El token es opaco: no se interpreta.

### 4.3 Renovar la suscripción

```
PATCH /v1.0/subscriptions/7f105c7d-2dc5-4530-97cd-4e7ae6534c07
Content-Type: application/json

{ "expirationDateTime": "2026-12-12T12:00:00Z" }
```

Respuesta `200` con la suscripción actualizada. El Servicio de Correo la renueva antes de que venza; cada
aviso trae `subscriptionExpirationDateTime` para saber cuándo.

## 5. Change notification (aviso de correo nuevo)

Cuando entra un correo a la bandeja, el mock hace:

```
POST {notificationUrl}
Content-Type: application/json

{
  "value": [
    {
      "id": "lsgTZMr9KwAAA",
      "subscriptionId": "7f105c7d-2dc5-4530-97cd-4e7ae6534c07",
      "subscriptionExpirationDateTime": "2026-12-05T12:00:00Z",
      "clientState": "<el mismo secreto>",
      "changeType": "created",
      "resource": "Users/6b1e7c2a-4f3d-4e8b-9c0a-1d2e3f4a5b6c/Messages/AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZiLTU1OGY5OTZhYmY4OABGAAAAAAAiQ8W967B7TKBjgx9rVEURBwAiIsqMbYjsT5e-T7KzowPTAAAAAAEMAAAiIsqMbYjsT5e-T7KzowPTAAAYbvZDAAA=",
      "tenantId": "84bd8158-6d4d-4958-8b9f-9d6445542f95",
      "resourceData": {
        "@odata.type": "#Microsoft.Graph.Message",
        "@odata.id": "Users/6b1e7c2a-4f3d-4e8b-9c0a-1d2e3f4a5b6c/Messages/AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZiLTU1OGY5OTZhYmY4OABGAAAAAAAiQ8W967B7TKBjgx9rVEURBwAiIsqMbYjsT5e-T7KzowPTAAAAAAEMAAAiIsqMbYjsT5e-T7KzowPTAAAYbvZDAAA=",
        "@odata.etag": "W/\"CQAAABYAAADkrWGo7bouTKlsgTZMr9KwAAAUWRHf\"",
        "id": "AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZiLTU1OGY5OTZhYmY4OABGAAAAAAAiQ8W967B7TKBjgx9rVEURBwAiIsqMbYjsT5e-T7KzowPTAAAAAAEMAAAiIsqMbYjsT5e-T7KzowPTAAAYbvZDAAA="
      }
    }
  ]
}
```

- `value` puede traer varios avisos, incluso de suscripciones distintas.
- El aviso **no** trae el contenido del correo: solo el `id` (`resourceData.id`). El procesador lo lee con
  la sección 3.
- Seguridad: el adaptador compara `clientState` con el guardado para esa `subscriptionId`; si no coincide,
  descarta el aviso (puede no venir de Microsoft).
- El Servicio de Correo responde `202 Accepted` (o `200`) **dentro de 3 segundos** y procesa después
  (encola el buzón, ADR-010). Si no responde a tiempo o responde un error, el mock reintenta el envío.

## 6. Límites de uso (QA-7)

Al superar el límite, Graph responde:

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 10

{
  "error": {
    "code": "TooManyRequests",
    "innerError": {
      "code": "429",
      "date": "2026-11-28T12:51:51",
      "message": "Please retry after",
      "request-id": "94fb3b52-452a-4535-a601-69e0a90e3aa2",
      "status": "429"
    },
    "message": "Please retry again later."
  }
}
```

El adaptador espera los segundos de `Retry-After` antes de reintentar. El mock aplica un límite
configurable por buzón y devuelve este mismo formato.

## Fuera del formato real

Las rutas `/admin/...` del mock (inyectar correos, generador compartido con el mock de Gmail en
`mocks/comun`, semillas) son solo para pruebas y las define el mock (P2.B2). No forman parte de este
contrato.
