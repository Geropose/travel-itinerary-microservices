# Agencia de viajes (crear un caso)

Qué imita el mock `mocks/agencia` (puerto 4006, dueño D). Lo usa el adaptador de agencias del Servicio de
Integraciones (Iteración 3, adaptadores de agencias; ADR-003) para derivar el problema del usuario a su
agencia preferida (UC-6). Lo pide el Asistente Virtual cuando el caso es complejo o el usuario quiere hablar
con una persona (Iteración 7, ADR-018), y también la degradación controlada (ADR-019).

## Qué API real imita

Una agencia recibe los casos de sus clientes en su sistema de atención (mesa de ayuda). El formato está
**inspirado en la API de tickets de Zendesk**, una mesa de ayuda real muy usada: se crea un ticket con
asunto, un primer comentario y prioridad, y la respuesta trae el número del ticket. Es una versión
simplificada: solo se usa crear un caso.

| Tema | Documentación de referencia |
|---|---|
| Crear ticket (`POST /api/v2/tickets`) | https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/ |

## Datos de prueba

| Dato | Valor |
|---|---|
| `agencia` en Trotamundos | `viajes-del-plata` |
| Nombre | Viajes del Plata |

El perfil del usuario guarda el identificador de su agencia preferida (Servicio de Usuarios). Cada agencia
tiene su adaptador y su URL en la configuración de Integraciones (`proveedores.yaml`); en el prototipo todas
apuntan a este mock.

## Autenticación

Cada llamada lleva `Authorization: Bearer <clave de API>`. La clave sale de una variable de entorno. (Zendesk
acepta token de API con autenticación básica u OAuth con `Bearer`; el mock solo acepta `Bearer`.) Sin clave o
con una clave inválida: `401`.

## Crear un caso

```
POST /api/v2/tickets
Content-Type: application/json

{
  "ticket": {
    "subject": "Trotamundos: vuelo XKQ7PL cancelado, pide reubicación",
    "comment": {
      "body": "Resumen: la aerolínea canceló el vuelo AN 1234 del 10/12 (reserva XKQ7PL, Aerolínea Andina). No hay opciones de reprogramación disponibles y el usuario pidió hablar con una persona.\n\nConversación con el asistente:\n[2026-11-28 09:30] Usuario: Me cancelaron el vuelo a Santiago, ¿qué hago?\n[2026-11-28 09:30] Asistente: Busqué opciones de reprogramación con Aerolínea Andina y no hay vuelos disponibles.\n[2026-11-28 09:31] Usuario: Quiero hablar con mi agencia."
    },
    "priority": "high",
    "external_id": "6b1e7c2a-4f3d-4e8b-9c0a-1d2e3f4a5b6c",
    "tags": ["trotamundos", "asistente-virtual"]
  }
}
```

| Campo | Obligatorio | Uso |
|---|---|---|
| `subject` | Sí | Asunto corto del problema. |
| `comment.body` | Sí | Texto plano: el resumen y la conversación con el asistente, una línea por mensaje (`[fecha hora] Usuario:` o `[fecha hora] Asistente:`). Zendesk también es así: el primer comentario es la descripción del ticket. |
| `priority` | No | `urgent`, `high`, `normal` (por defecto) o `low`, los mismos valores que Zendesk. |
| `external_id` | Sí (en Trotamundos) | El `usuarioId` de Trotamundos, para vincular el caso con el usuario. En Zendesk es "un id para vincular el ticket con registros propios". |
| `tags` | No | Etiquetas libres. Trotamundos siempre manda `trotamundos`. |

Respuesta `201 Created`:

```json
{
  "ticket": {
    "id": 35436,
    "status": "new",
    "subject": "Trotamundos: vuelo XKQ7PL cancelado, pide reubicación",
    "priority": "high",
    "external_id": "6b1e7c2a-4f3d-4e8b-9c0a-1d2e3f4a5b6c",
    "tags": ["trotamundos", "asistente-virtual"],
    "created_at": "2026-11-28T09:31:12Z",
    "updated_at": "2026-11-28T09:31:12Z"
  }
}
```

- `ticket.id` es el **número de caso** que devuelve la ruta interna `POST /interna/agencias/casos` del
  Servicio de Integraciones (como texto: `"35436"`), y el asistente se lo muestra al usuario.
- `status` empieza en `new` (Zendesk usa `new`, `open`, `pending`, `hold`, `solved` y `closed`).

## Traducción desde la ruta interna de Integraciones

| Ruta interna (`agencia, usuarioId, resumen, conversacion[]`) | Pedido a la agencia |
|---|---|
| `agencia` | Elige el adaptador y la URL de la agencia (configuración). |
| `usuarioId` | `ticket.external_id` |
| `resumen` | Primera parte de `ticket.comment.body` y, recortado a 80 caracteres, `ticket.subject` con el prefijo `Trotamundos: `. |
| `conversacion[]` | Segunda parte de `ticket.comment.body`, una línea por mensaje. |

## Errores

Formato propio del mock (Integraciones solo mira el código HTTP):

```json
{
  "error": "RecordInvalid",
  "description": "Record validation errors",
  "details": { "subject": [{ "description": "Subject: no puede estar vacío" }] }
}
```

| Código HTTP | Cuándo |
|---|---|
| `401` | Falta la clave de API o es inválida. |
| `422` | Falta `subject` o `comment.body`, o `priority` no es un valor válido. |
| `503` | Falla simulada desde `/admin` (agencia caída). Integraciones responde un `503` claro al asistente (P2.D3) y el asistente avisa al usuario (ADR-019). |

Si la agencia no responde en el tiempo máximo (2 s por defecto, CONVENCIONES 4.3), Integraciones lo trata
igual que un `503`.

## Preguntas abiertas para la revisión cruzada (P0.5)

- La ruta interna solo trae `usuarioId`. Para que la agencia pueda contactar al usuario haría falta su
  nombre y su correo (Zendesk los recibe en `ticket.requester`). ¿Los manda el Asistente (que tiene el JWT
  del usuario) o Integraciones se los pide al Servicio de Usuarios? Mientras tanto, el mock acepta un
  `ticket.requester` opcional (`{ "name": "...", "email": "..." }`) y no lo exige.

## Fuera del formato real

Las rutas `/admin/...` del mock (ver los casos recibidos, configurar demora y fallas) son solo para pruebas
y las define el mock (P2.D1).
