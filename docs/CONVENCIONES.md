## 4. Convenciones comunes (todos las respetan)

El Prompt 0.1 copia esta sección en `docs/CONVENCIONES.md`. Es el acuerdo que permite trabajar en paralelo.

### 4.1 Estructura del repositorio

```
Trabajo-especial-trotamundos/      (repositorio del TP; la wiki es el repositorio .wiki de al lado)
├── CLAUDE.md                      reglas para el agente
├── docs/CONVENCIONES.md           esta sección
├── docs/mediciones.md             resultados de las mediciones (fase 4)
├── specs/
│   ├── openapi/<servicio>.yaml    un contrato REST por servicio
│   ├── asyncapi/eventos.yaml      los 4 eventos
│   ├── schemas/<Evento>.json      JSON Schema de cada evento
│   └── externos/                  qué API real imita cada mock
├── packages/comun/                kit común (lo hace A)
├── services/<servicio>/           un microservicio por carpeta
├── mocks/<mock>/                  sistemas externos simulados
├── web/                           aplicación web y móvil (PWA)
├── infra/                         compose, nginx, rabbitmq, scripts
└── tests/{e2e,carga,caos}/        pruebas de todo el sistema
```

La wiki se clona al lado del repositorio, en `../Trabajo-especial-trotamundos.wiki/`. Los prompts la leen desde ahí.

### 4.2 Servicios, puertos y dueños

| Servicio / mock | Carpeta | Puerto | Dueño |
|---|---|---|---|
| Enrutador global | `services/enrutador` | 8000 | A |
| Balanceador (nginx) | `infra/nginx` | 8080 por región (r1: 8081, r2: 8082 hacia afuera) | A |
| API Gateway | `services/gateway` | 3000 | A |
| Autenticación | `services/autenticacion` | 3001 | A |
| Usuarios | `services/usuarios` | 3002 | B |
| Correo | `services/correo` | 3003 | B |
| Viajes | `services/viajes` | 3004 | C |
| Integraciones | `services/integraciones` | 3005 | D |
| Analítica | `services/analitica` | 3006 | C |
| Asistente Virtual | `services/asistente` | 3007 | D |
| Monitor de salud | `services/monitor` | 3010 | A |
| Mock Gmail | `mocks/gmail` | 4001 | B |
| Mock Outlook | `mocks/outlook` | 4002 | B |
| Mock aerolínea (avisa cambios) | `mocks/aerolinea` | 4003 | D |
| Mock hotel (sin aviso) | `mocks/hotel` | 4004 | D |
| Mock rentadora (sin aviso) | `mocks/rentadora` | 4005 | D |
| Mock agencia | `mocks/agencia` | 4006 | D |
| Mock red social | `mocks/redsocial` | 4007 | D |
| Web | `web` | 5173 | A (base) + cada dueño sus pantallas |

Todas las rutas públicas pasan por el gateway con el prefijo del servicio: `/api/usuarios/...`, `/api/viajes/...`, etc.

### 4.3 Reglas de todos los servicios

- `GET /health` responde `200 {"estado":"ok"}` si el servicio puede atender (base y broker conectados), y `503` si no. Lo usa el monitor de salud (ADR-007).
- Errores en formato `application/problem+json` (RFC 7807): `{type, title, status, detail, requestId}`.
- Cada solicitud lleva `X-Request-Id`; si no viene, el gateway lo crea. Se loguea en todas las líneas (logs JSON con `pino`).
- La configuración sale de variables de entorno, validadas al arrancar (si falta una, el servicio no arranca).
- Las llamadas HTTP a otro servicio tienen tiempo máximo (2 s por defecto) y propagan el JWT del usuario (ADR-019, Iteración 7).
- Los tiempos de la wiki (examinador 5 y 60 min, consulta a proveedores cada 2 min, archivado nocturno) se configuran por entorno, así en la demo se pueden acortar.
- Variable `REGION` = `region-1` o `region-2`. Cada servicio solo guarda datos de usuarios de su región (CONST-6).

### 4.4 JWT (ADR-014)

- Firmado con RS256 por el Servicio de Autenticación. La clave pública se publica en `GET /api/autenticacion/.well-known/jwks.json`. Los validadores la descargan una vez y verifican **sin usar la red** en cada solicitud.
- Claims: `sub` (usuarioId, UUID), `region` (`region-1` o `region-2`), `roles` (`["usuario"]` o `["analista"]`), `idioma`, `exp` (**15 minutos**).
- Token de renovación opaco (guardado con hash), válido 7 días, para pedir un JWT nuevo sin volver a escribir la contraseña.
- **Token de servicio** (`tokenServicio` en `specs/openapi/comun.yaml`): solo para las rutas internas sin un usuario detrás (registro, tareas programadas, pruebas). Lo emite `POST /interna/tokens-servicio` de Autenticación a cambio del secreto del servicio (`SECRETO_SERVICIO_<SERVICIO>`). Claims: `sub` (nombre del servicio), `roles` (`["servicio"]`), `region`, `exp` (**5 minutos**). Cada ruta dice qué servicios la pueden llamar. Donde hay un usuario se propaga su JWT (ADR-019), nunca el token de servicio.

### 4.5 Eventos (ADR-002, ADR-016)

- Exchange de tipo *topic* `trotamundos.eventos`. La *routing key* es el nombre del evento. Cada consumidor tiene su propia cola *quorum* y una cola de mensajes fallidos (`<cola>.dlq`).
- Todos los eventos usan el mismo sobre:

```json
{
  "eventId": "uuid",
  "tipo": "ReservaDetectada",
  "version": 1,
  "ocurridoEn": "2026-11-20T13:45:00Z",
  "region": "region-1",
  "datos": { }
}
```

| Evento | Publica | Consume | `datos` |
|---|---|---|---|
| `ReservaDetectada` | Correo (procesadores) | Viajes (consumidores) | `usuarioId, proveedor, tipoReserva (vuelo/hotel/auto), numeroReserva, inicio, fin, origen, destino, estado (confirmada/modificada/cancelada), detalle{}, correoId` |
| `ReservaActualizada` | Integraciones (adaptadores) | Viajes (consumidores) | `proveedor, numeroReserva, estado (confirmada/modificada/cancelada), cambios{inicio?, fin?, origen?, destino?, detalle?}, origenCambio ("proveedor")` |
| `FiltrosActualizados` | Usuarios (filtros y whitelist) | Correo (filtro de remitentes) | `usuarioId, remitentesPermitidos[], filtrosActivos (bool)` |
| `ViajeActualizado` | Viajes (gestor de viajes) | Analítica (anonimizador) | `numeroReserva, proveedor, tipoReserva, origen, destino, inicio, fin, estado, origenCambio (correo/proveedor/manual/archivado)` |
| `AccesoRechazado` | Cada microservicio (Validador de Intercepción) | Gateway (registro de accesos) | `servicio, metodo, ruta, status (401/403), motivo (sin-token/token-invalido/otra-region/sin-permiso), usuarioId?, ip?, requestId` |

- **Idempotencia:** cada consumidor guarda el `eventId` en una tabla `eventos_procesados` dentro de la misma transacción que aplica el cambio; si ya está, ignora el evento (Iteración 2: "ignoran los repetidos").
- **Publicación segura (outbox):** quien publica guarda el evento en una tabla `eventos_salientes` en la misma transacción que su cambio, y un publicador lo envía al broker cada 500 ms. Así un cambio guardado nunca se queda sin su evento.
- `ReservaDetectada`: Viajes hace un *upsert* por `proveedor + numeroReserva`. Si la reserva no existe la crea y la agrupa en un viaje; si existe le aplica el `estado` y las fechas nuevas.
- `ReservaActualizada` no trae `usuarioId` (el proveedor no lo conoce): Viajes busca la reserva por `proveedor + numeroReserva`. Si no la encuentra, ignora el evento, lo registra en el log y lo confirma sin reintentar.
- `FiltrosActualizados`: mientras Correo no recibió ninguno de un usuario, toma sus filtros como inactivos y su lista como vacía.
- `ViajeActualizado` no lleva `usuarioId`, `viajeId` ni `reservaId`. El anonimizador reemplaza `numeroReserva` por `codigoReserva = HMAC-SHA256(numeroReserva, SECRETO_ANALITICA)` y guarda `inicio` y `fin` solo con la fecha, sin la hora (ADR-016).
- `AccesoRechazado`: el Validador de Intercepción de cada microservicio lo publica sin hacer esperar la respuesta. Los rechazos del propio gateway se guardan directo en `accesos_rechazados`, sin pasar por el broker (QA-8, QA-9).

### 4.6 Roles y permisos (ADR-005)

- `usuario`: solo ve y cambia sus propios datos.
- Itinerario compartido: lo ven el dueño y las personas designadas. El dueño lo resuelve Viajes con sus datos; las personas designadas las guarda Usuarios ("Permisos de itinerarios"), que no sabe de quién es cada viaje y se lo pregunta a Viajes (`GET /interna/viajes/{viajeId}/dueno`).
- `analista`: solo accede a `/api/analitica/...`, nunca a datos personales.
- `servicio`: solo lo tiene el token de servicio. Sirve únicamente en las rutas internas que lo piden; en el resto responde 403.
- Toda solicitud rechazada se guarda de forma asíncrona en el registro de accesos (QA-9: menos de 1 s). Los microservicios la publican como evento `AccesoRechazado`; el gateway guarda las suyas directo.
