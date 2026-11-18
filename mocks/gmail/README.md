# Mock de Gmail (`mocks/gmail`, puerto 4001)

Imita el OAuth de Google, la Gmail API v1 y los avisos push de Cloud Pub/Sub con los formatos de
[`specs/externos/gmail.md`](../../specs/externos/gmail.md). Lo usa el adaptador de Gmail del Servicio de
Correo (ADR-003, ADR-010, ADR-015). Todo se guarda en memoria: al reiniciar vuelve a las semillas.

```
npm start -w mocks/gmail          # con las variables de .env.example
npm test -w mocks/gmail
```

En Docker se levanta con lo global (`npm run infra:levantar`), en la red global y con el 4001 publicado,
porque el navegador del usuario abre la pantalla de permiso.

## Rutas con el formato real

| Ruta | Sección de gmail.md |
|---|---|
| `GET /o/oauth2/v2/auth` (y `/o/oauth2/auth`) | 1.1 Pantalla de permiso con "Permitir" y "Cancelar" |
| `POST /token` | 1.2 y 1.3 `authorization_code` y `refresh_token`; errores de 1.4 |
| `GET /gmail/v1/users/{userId}/profile` | 1.6 |
| `GET /gmail/v1/users/{userId}/messages` | 2. `q` con `after:<segundos>` y `from:<dirección>`, `maxResults`, `pageToken` |
| `GET /gmail/v1/users/{userId}/messages/{id}` | 3. `format=full` (por defecto) o `minimal` |
| `GET /gmail/v1/users/{userId}/history` | 4. `startHistoryId`, `historyTypes=messageAdded`; 404 si es demasiado viejo |
| `POST /gmail/v1/users/{userId}/watch` | 5. Vence a los 7 días; manda un aviso enseguida |

- El token tiene que estar vigente y tener el scope `gmail.readonly`; si no, `401` con el formato de 1.5.
- Cuota por usuario (sección 7): 6.000 unidades por minuto (`CUOTA_POR_MINUTO`), con el costo de cada
  método. Al superarla, `429` con `reason: "rateLimitExceeded"`.
- Avisos push (sección 6): cuando entra un correo a un buzón con `watch` vigente, manda un `POST` con el
  formato de Pub/Sub a la URL del tópico del `watch` (`SUSCRIPCIONES_PUSH`). Como máximo uno por segundo
  por buzón, con el `historyId` más nuevo. Si la URL responde un error o no responde, reintenta el mismo
  aviso con espera exponencial (5 veces).
- La pantalla de permiso no pide contraseña: se elige el buzón (hay una lista con los de prueba) y se
  aprieta "Permitir". Una prueba automática puede saltear la pantalla y mandar el formulario directo:
  `POST /o/oauth2/v2/auth/decision` con `client_id`, `redirect_uri`, `scope`, `state`, `access_type`,
  `email` y `decision=permitir` (o `cancelar`). Responde `302` a `redirect_uri` igual que Google.

## Administración, generador y semillas (`mocks/comun`)

Las rutas `/admin`, el generador de correos y las semillas son las de [`mocks/comun`](../comun/README.md),
iguales a las del mock de Outlook. En este mock:

- `GET /admin/buzones` muestra también el `historyId` de cada buzón y si tiene `watch`.
- `POST /admin/buzones/{email}/correos` responde también el `historyId` nuevo y, si hay `watch`, sale el
  aviso push.
- Los 20 buzones de prueba van de `ana.garcia@gmail.example` a `valentina.rojas@gmail.example`.

## Configuración

Ver [`.env.example`](.env.example). `CLIENT_SECRET` y el `?token=` de las URL de avisos tienen que
coincidir con los del Servicio de Correo (en Docker salen de `SECRETO_CLIENTE_GMAIL` y
`SECRETO_AVISOS_GMAIL` del `.env` de la raíz).
