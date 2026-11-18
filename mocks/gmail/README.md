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

## Administración (solo para pruebas, no es parte del formato real)

| Ruta | Qué hace |
|---|---|
| `GET /admin/buzones` | Lista los buzones con su cantidad de correos, `historyId` y si tienen `watch` |
| `GET /admin/buzones/{email}/correos` | Correos del buzón con su tipo y la reserva que lleva (para comprobar lo que detectan los procesadores) |
| `POST /admin/buzones/{email}/correos` | Inyecta correos (crea el buzón si no existe) y, si hay `watch`, sale el aviso |
| `POST /admin/buzones/{email}/vencer-tokens` | Hace vencer los access tokens del buzón (para probar la renovación) |
| `POST /admin/buzones/{email}/revocar-tokens` | Revoca los tokens del buzón: la renovación da `invalid_grant` |

Cuerpo de `POST /admin/buzones/{email}/correos`, una de tres formas:

```jsonc
{ "tipo": "vuelo", "estado": "confirmada", "semilla": 7 }   // un correo generado
{ "cantidad": 1000, "semilla": 2026 }                        // un lote mezclado
{ "de": "Alguien <a@correo.example>", "asunto": "Hola", "texto": "...", "html": "<p>...</p>" }
```

Responde `201` con `{ "historyId": "...", "correos": [{ "id", "tipo", "reserva"? }] }`.

## Generador de correos (`src/generador.ts`)

Arma los correos de [`specs/externos/correos-reserva.md`](../../specs/externos/correos-reserva.md). Con
la misma semilla genera siempre los mismos.

| Tipo | Qué es |
|---|---|
| `vuelo`, `hotel`, `auto` | Reserva con JSON-LD de schema.org en el HTML, del remitente del proveedor de prueba. Usa los dos nombres de estado y de `@context` (Google y schema.org) que el procesador tiene que aceptar |
| `vuelo-sin-marcado`, `hotel-sin-marcado`, `auto-sin-marcado` | La misma reserva, solo texto, con la plantilla fija de la sección 4 |
| `no-viaje` | Noticias, facturas, compras, mensajes personales y una promoción de la aerolínea (que no es una reserva) |
| `remitente-no-permitido` | Reserva con marcado válido de `reservas@viajes-baratos.example`, que no es un proveedor de prueba |

El estado puede ser `confirmada`, `modificada` (con `modifiedTime`) o `cancelada`. Un lote mezcla 45 %
de reservas con marcado, 15 % sin marcado, 30 % que no son de viaje y 10 % de remitentes no permitidos.

## Semillas

Al arrancar (`SEMILLAS=true`) crea 20 buzones de prueba, de `ana.garcia@gmail.example` a
`valentina.rojas@gmail.example` (`src/semillas.ts`). Cada uno tiene una reserva de vuelo, una de hotel y
una de auto con marcado, y 5 correos más al azar.

## Configuración

Ver [`.env.example`](.env.example). `CLIENT_SECRET` y el `?token=` de las URL de avisos tienen que
coincidir con los del Servicio de Correo (en Docker salen de `SECRETO_CLIENTE_GMAIL` y
`SECRETO_AVISOS_GMAIL` del `.env` de la raíz).
