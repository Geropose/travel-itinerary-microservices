# Mock de Outlook (`mocks/outlook`, puerto 4002)

Imita la Microsoft identity platform (OAuth) y Microsoft Graph v1.0 con los formatos de
[`specs/externos/outlook.md`](../../specs/externos/outlook.md). Lo usa el adaptador de Outlook del
Servicio de Correo (ADR-003, ADR-010, ADR-015). Todo se guarda en memoria: al reiniciar vuelve a las
semillas.

```
npm start -w mocks/outlook        # con las variables de .env.example
npm test -w mocks/outlook
```

En Docker se levanta con lo global (`npm run infra:levantar`), en la red global y con el 4002 publicado,
porque el navegador del usuario abre la pantalla de permiso.

## Rutas con el formato real

| Ruta | Sección de outlook.md |
|---|---|
| `GET /{tenant}/oauth2/v2.0/authorize` | 1.1 Pantalla de permiso con "Permitir" y "Cancelar" (cualquier `tenant`) |
| `POST /{tenant}/oauth2/v2.0/token` | 1.2 y 1.3 `authorization_code` y `refresh_token`; errores de 1.4 |
| `GET /v1.0/me` | 1.6 Con `$select` |
| `GET /v1.0/me/messages` | 2. `$filter=receivedDateTime ge\|gt <fecha>`, `$orderby=receivedDateTime asc\|desc`, `$select`, `$top`, `@odata.nextLink` |
| `GET /v1.0/me/messages/{id}` | 3. Con `$select` |
| `POST /v1.0/subscriptions` | 4.1 y 4.2 Con el handshake de `validationToken` |
| `PATCH /v1.0/subscriptions/{id}` | 4.3 Renovar |
| `DELETE /v1.0/subscriptions/{id}` | Borrar (al desconectar la cuenta) |

- **OAuth:** acepta los scopes cortos (`Mail.Read`) o la URL completa y responde con la URL completa,
  sin `offline_access`. Sin `offline_access` no hay `refresh_token`. El código vence al minuto. Cada
  renovación trae un refresh token nuevo y el mock descarta el anterior (Microsoft pide no seguir
  usándolo), así una prueba descubre si el adaptador no lo reemplaza.
- **Tokens en Graph:** un token vencido, inventado o ausente da `401 InvalidAuthenticationToken`. Sin
  `Mail.Read`, leer correos o suscribirse da `403 ErrorAccessDenied`; sin `User.Read`, `/me` da `403`.
- **Cuerpo:** viene como texto (no en base64). Con `Prefer: outlook.body-content-type="text"` viene el
  texto plano. Sin el header, o con `"html"`, viene el HTML; un correo de solo texto se convierte a HTML
  como hace Graph.
- **Suscripciones:**
  - Antes de crearla, el mock valida la `notificationUrl`. Le manda un `POST` con
    `?validationToken=` y un cuerpo vacío en `text/plain`.
  - Tiene que responder `200` en `text/plain` con el token decodificado, en menos de 10 s; si no, `400`.
  - Vida máxima: 10.080 minutos. Con menos de 45 minutos, la lleva a 45. Si ya hay una suscripción
    con la misma `changeType` y `resource`, responde `409`.
- **Change notifications (sección 5):** cuando entra un correo, el mock manda `{ "value": [...] }` a la
  `notificationUrl` de cada suscripción vigente del buzón.
  - Los correos que entran juntos van en el mismo `value`.
  - Si no hay respuesta `2xx` en 3 s, reintenta el mismo aviso con espera exponencial.
- **Límites (sección 6, QA-7):** 10.000 solicitudes a Graph cada 10 minutos por buzón
  (`LIMITE_SOLICITUDES`, `VENTANA_LIMITE_S`). Al superarlo, `429 TooManyRequests` con `Retry-After`.
- La pantalla de permiso no pide contraseña: se elige el buzón y se aprieta "Permitir". Una prueba
  automática puede mandar el formulario directo: `POST /common/oauth2/v2.0/authorize/decision` con
  `client_id`, `redirect_uri`, `scope`, `state`, `email` y `decision=permitir` (o `cancelar`).

## Administración, generador y semillas (`mocks/comun`)

Las rutas `/admin`, el generador de correos y las semillas son las de [`mocks/comun`](../comun/README.md),
iguales a las del mock de Gmail. En este mock:

- `GET /admin/buzones` muestra también el `id` del usuario, si es una cuenta personal y cuántas
  suscripciones vigentes tiene.
- Los 20 buzones de prueba van de `ana.garcia@outlook.example` a `valentina.rojas@outlook.example`. Los
  últimos 5 son cuentas personales: `/v1.0/me` devuelve `mail` en `null` y hay que usar
  `userPrincipalName` (sección 1.6).

## Configuración

Ver [`.env.example`](.env.example). `CLIENT_SECRET` tiene que coincidir con el del Servicio de Correo (en
Docker sale de `SECRETO_CLIENTE_OUTLOOK` del `.env` de la raíz). Las change notifications van a la
`notificationUrl` que el Servicio de Correo pone al crear la suscripción, así que el mock no necesita
una URL de avisos.
