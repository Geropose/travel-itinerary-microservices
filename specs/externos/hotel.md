# Hotel (sin aviso: solo se puede consultar)

Qué imita el mock `mocks/hotel` (puerto 4004, dueño D). Lo usa el adaptador del hotel del Servicio de
Integraciones (Iteración 3, adaptadores de proveedores de viaje; ADR-003) para obtener cambios y
cancelaciones de reservas (UC-3).

Es un proveedor **que no avisa**: no manda webhooks. El adaptador lo consulta cada 2 minutos
(configurable) y pide las reservas modificadas desde la última consulta (Iteración 3, Paso 5; peor caso de
QA-1 en el Paso 7).

## Qué API real imita

No hay un estándar único para las APIs de hoteles. El formato es un JSON simple inspirado en las APIs de
reservas hoteleras y en los mensajes de reserva de OpenTravel (OTA), el estándar de la industria de viajes:
reserva con número de confirmación, estado, número de revisión, hotel, huésped, fechas de entrada y salida y
habitación. La consulta "reservas modificadas desde una fecha" es la forma habitual de sincronizar con un
sistema de reservas que no avisa.

| Tema | Documentación de referencia |
|---|---|
| OpenTravel Alliance (mensajes de reserva de hotel) | https://opentravel.org/ |

Los nombres de campos van en inglés y en `camelCase`, distinto de la aerolínea: cada proveedor tiene su
formato y el adaptador lo traduce (patrón Adapter).

## Datos de prueba

| Dato | Valor |
|---|---|
| `proveedor` en Trotamundos | `hotel-cordillera` |
| Nombre | Hotel Cordillera (Santiago, Chile) |
| Remitente de sus correos | `reservas@hotel-cordillera.example` ([correos-reserva.md](correos-reserva.md)) |

Los `reservationId` del mock son los mismos números que mandan los correos de reserva (por ejemplo
`HC-48213`).

## Autenticación

Cada llamada lleva el header `X-Api-Key: <clave de API>`. La clave sale de una variable de entorno. Sin
clave o con una clave inválida: `401`.

## Recurso `reservation`

```json
{
  "reservationId": "HC-48213",
  "status": "modified",
  "revision": 2,
  "createdAt": "2026-11-20T14:02:00Z",
  "lastModified": "2026-11-28T12:05:00Z",
  "hotel": {
    "code": "HC-SCL-01",
    "name": "Hotel Cordillera",
    "address": "Av. Providencia 1234",
    "city": "Santiago",
    "countryCode": "CL"
  },
  "guest": { "firstName": "Ana", "lastName": "García" },
  "checkIn": "2026-12-11T15:00:00-03:00",
  "checkOut": "2026-12-14T11:00:00-03:00",
  "room": { "type": "DBL", "description": "Doble superior", "guests": 2 }
}
```

| Campo | Significado |
|---|---|
| `reservationId` | Número de reserva del hotel. Es el `numeroReserva` de Trotamundos. |
| `status` | `confirmed`, `modified` o `cancelled`. |
| `revision` | Sube en 1 con cada cambio. Junto con `reservationId` identifica un cambio. |
| `lastModified` | Fecha del último cambio (UTC). Es lo que filtra la consulta. |
| `checkIn` / `checkOut` | Entrada y salida, con la diferencia horaria del hotel (ISO 8601). |
| `hotel.city` | Ciudad del hotel. Es el `destino` de Trotamundos. |

## 1. Consultar reservas modificadas (la usa el adaptador cada 2 minutos)

```
GET /v1/reservations?modifiedSince=2026-11-28T12:00:00Z&limit=100
```

| Parámetro | Uso |
|---|---|
| `modifiedSince` | Obligatorio. Fecha ISO 8601 en UTC. Devuelve las reservas con `lastModified` **mayor o igual**. |
| `limit` | Tamaño de página, de 1 a 500. Por defecto 100. |
| `cursor` | Página siguiente (el `nextCursor` de la respuesta anterior). |

Respuesta `200`, ordenada por `lastModified` de menor a mayor:

```json
{
  "reservations": [
    {
      "reservationId": "HC-48213",
      "status": "modified",
      "revision": 2,
      "createdAt": "2026-11-20T14:02:00Z",
      "lastModified": "2026-11-28T12:05:00Z",
      "hotel": {
        "code": "HC-SCL-01",
        "name": "Hotel Cordillera",
        "address": "Av. Providencia 1234",
        "city": "Santiago",
        "countryCode": "CL"
      },
      "guest": { "firstName": "Ana", "lastName": "García" },
      "checkIn": "2026-12-11T15:00:00-03:00",
      "checkOut": "2026-12-14T11:00:00-03:00",
      "room": { "type": "DBL", "description": "Doble superior", "guests": 2 }
    }
  ],
  "nextCursor": null
}
```

- Sin cambios: `{ "reservations": [], "nextCursor": null }`.
- `nextCursor` distinto de `null`: hay más páginas; se piden con `cursor=<nextCursor>` y el mismo
  `modifiedSince`.
- Como el filtro es "mayor o igual", la última reserva de una consulta vuelve a aparecer en la siguiente.
  El adaptador guarda el `lastModified` más alto que vio como próximo `modifiedSince`, y descarta los pares
  `reservationId` + `revision` que ya procesó (P2.D2: no publicar dos veces el mismo cambio).
- `modifiedSince` faltante o con formato inválido: `400`.

## 2. Consultar una reserva

```
GET /v1/reservations/HC-48213
```

Respuesta `200`: un recurso `reservation`. Si no existe: `404`.

## Traducción a `ReservaActualizada.datos`

El hotel no dice qué campos cambiaron. El adaptador guarda la última revisión que vio de cada reserva y
compara: `cambios` lleva solo lo que es distinto. Si es la primera vez que ve esa reserva (por ejemplo,
llegó por correo y nunca cambió en el hotel), manda `inicio`, `fin` y `destino` actuales.

| Campo del evento | De dónde sale |
|---|---|
| `proveedor` | Configuración del adaptador: `hotel-cordillera`. |
| `numeroReserva` | `reservationId` |
| `estado` | `status`: `confirmed` → `confirmada`, `modified` → `modificada`, `cancelled` → `cancelada`. |
| `cambios.inicio` | `checkIn`, si cambió. |
| `cambios.fin` | `checkOut`, si cambió. |
| `cambios.destino` | `hotel.city`, si cambió. |
| `cambios.detalle.hotel` | `hotel.name`, si cambió. |
| `cambios.detalle.habitacion` | `room.description`, si cambió. |
| `origenCambio` | Siempre `proveedor`. |

Ejemplo: el huésped pasó la entrada del 10 al 11 de diciembre (revisión 1 → 2):

```json
{
  "proveedor": "hotel-cordillera",
  "numeroReserva": "HC-48213",
  "estado": "modificada",
  "cambios": { "inicio": "2026-12-11T15:00:00-03:00" },
  "origenCambio": "proveedor"
}
```

En una cancelación, `cambios` va vacío (`{}`). Una reserva que no se puede traducir (falta
`reservationId`, `status` desconocido, fechas inválidas) va a `no_traducidos` con el JSON original (QA-6).

## Errores

```json
{ "error": { "code": "NOT_FOUND", "message": "Reservation HC-48299 not found" } }
```

| Código HTTP | `code` | Cuándo |
|---|---|---|
| `400` | `INVALID_PARAMETER` | `modifiedSince` faltante o inválido, `limit` fuera de rango. |
| `401` | `UNAUTHORIZED` | Falta la clave de API o es inválida. |
| `404` | `NOT_FOUND` | Reserva inexistente. |
| `503` | `SERVICE_UNAVAILABLE` | Falla simulada desde `/admin`. El adaptador vuelve a consultar en el próximo intervalo con el mismo `modifiedSince`, así no pierde cambios. |

## Fuera del formato real

Las rutas `/admin/...` del mock (generar cambios y cancelaciones, configurar demora y fallas, semillas) son
solo para pruebas y las define el mock (P2.D1).
