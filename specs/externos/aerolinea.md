# Aerolínea (avisa cambios por webhook)

Qué imita el mock `mocks/aerolinea` (puerto 4003, dueño D). Lo usa el adaptador de la aerolínea del
Servicio de Integraciones (Iteración 3, adaptadores de proveedores de viaje; ADR-003) para recibir
cambios y cancelaciones (UC-3) y para pedir y aplicar reprogramaciones (Iteración 7, UC-8).

Es el proveedor **que avisa**: manda un webhook cuando cambia una reserva, así el cambio llega al panel en
segundos (QA-1). El hotel y la rentadora, en cambio, solo se pueden consultar.

## Qué API real imita

No hay un estándar único para las APIs de aerolíneas. El formato está **inspirado en la API de Duffel**,
una API real de reservas aéreas que usan agencias online: órdenes con `booking_reference` (el PNR o
_record locator_), segmentos de vuelo, webhooks firmados con HMAC y cambios iniciados por la aerolínea con
segmentos quitados y agregados. Es una versión simplificada: no es la API de Duffel y el adaptador no
podría hablar con Duffel sin cambios.

| Tema | Documentación de referencia |
|---|---|
| Órdenes y `booking_reference` | https://duffel.com/docs/api/v2/orders |
| Cambios iniciados por la aerolínea (`added` / `removed`) | https://duffel.com/docs/api/v2/airline-initiated-changes |
| Webhooks firmados (`t=...,v1=...`) | https://duffel.com/docs/guides/receiving-webhooks |
| Pedidos de cambio y ofertas de cambio | https://duffel.com/docs/api/v2/order-change-requests |

Los nombres de campos van en inglés y en `snake_case`, como en la API real: el adaptador es el que los
traduce al formato interno de Trotamundos (patrón Adapter).

## Datos de prueba

| Dato | Valor |
|---|---|
| `proveedor` en Trotamundos | `aerolinea-andina` |
| Nombre y código IATA | Aerolínea Andina, `AN` |
| Remitente de sus correos | `reservas@aerolinea-andina.example` ([correos-reserva.md](correos-reserva.md)) |

Los `booking_reference` del mock son los mismos que mandan los correos de reserva (por ejemplo `XKQ7PL`).

## Autenticación

Cada llamada del adaptador lleva `Authorization: Bearer <clave de API>`. La clave sale de una variable de
entorno (`.env.example` con un valor de ejemplo). Sin clave o con una clave inválida: `401`.

## Recurso `order` (reserva)

```json
{
  "id": "ord_0000AN000XKQ7PL",
  "booking_reference": "XKQ7PL",
  "status": "confirmed",
  "version": 1,
  "created_at": "2026-11-20T13:40:00Z",
  "updated_at": "2026-11-20T13:40:00Z",
  "cancelled_at": null,
  "owner": { "iata_code": "AN", "name": "Aerolínea Andina" },
  "passengers": [{ "id": "pas_0001", "given_name": "Ana", "family_name": "García" }],
  "segments": [
    {
      "id": "seg_0001",
      "marketing_carrier": { "iata_code": "AN" },
      "marketing_carrier_flight_number": "1234",
      "origin": { "iata_code": "EZE", "city_name": "Buenos Aires" },
      "destination": { "iata_code": "SCL", "city_name": "Santiago" },
      "departing_at": "2026-12-10T08:30:00-03:00",
      "arriving_at": "2026-12-10T10:40:00-03:00",
      "seat": "14C"
    }
  ]
}
```

| Campo | Significado |
|---|---|
| `id` | Identificador interno de la orden en la aerolínea (se usa en las rutas). |
| `booking_reference` | Código de reserva (PNR). Es el `numeroReserva` de Trotamundos. |
| `status` | `confirmed`, `changed` (cambió algún segmento) o `cancelled`. |
| `version` | Sube en 1 con cada cambio. Junto con `booking_reference` identifica un cambio: sirve para no publicar dos veces el mismo. |
| `segments[]` | Vuelos de la reserva, en orden. |
| `departing_at` / `arriving_at` | Fecha y hora con la diferencia horaria del aeropuerto (ISO 8601). Duffel manda la hora local sin diferencia; acá se simplifica. |

## 1. Consultar una reserva

```
GET /air/orders?booking_reference=XKQ7PL
```

Respuesta `200`:

```json
{
  "data": [
    {
      "id": "ord_0000AN000XKQ7PL",
      "booking_reference": "XKQ7PL",
      "status": "confirmed",
      "version": 1,
      "...": "el resto del recurso order"
    }
  ],
  "meta": { "limit": 50, "after": null, "before": null }
}
```

Si no hay ninguna, `data` va vacío. También existe `GET /air/orders/{id}`, que responde
`{ "data": <order> }` o `404`.

## 2. Webhook de cambios (la aerolínea avisa)

Cuando una reserva cambia, el mock llama a la URL configurada por entorno. En Trotamundos es la ruta
pública del Servicio de Integraciones `POST /webhooks/proveedores/aerolinea-andina`.

```
POST /webhooks/proveedores/aerolinea-andina
Content-Type: application/json
X-Webhook-Signature: t=1764321150,v1=<HMAC-SHA256 en hexadecimal>

{
  "id": "wev_0000AN0000000042",
  "type": "order.airline_initiated_change_detected",
  "created_at": "2026-11-28T09:12:30Z",
  "idempotency_key": "XKQ7PL-v2",
  "data": {
    "object": {
      "order": {
        "id": "ord_0000AN000XKQ7PL",
        "booking_reference": "XKQ7PL",
        "status": "changed",
        "version": 2,
        "updated_at": "2026-11-28T09:12:30Z",
        "cancelled_at": null,
        "owner": { "iata_code": "AN", "name": "Aerolínea Andina" },
        "passengers": [{ "id": "pas_0001", "given_name": "Ana", "family_name": "García" }],
        "segments": [
          {
            "id": "seg_0002",
            "marketing_carrier": { "iata_code": "AN" },
            "marketing_carrier_flight_number": "1234",
            "origin": { "iata_code": "EZE", "city_name": "Buenos Aires" },
            "destination": { "iata_code": "SCL", "city_name": "Santiago" },
            "departing_at": "2026-12-10T11:15:00-03:00",
            "arriving_at": "2026-12-10T13:25:00-03:00",
            "seat": "14C"
          }
        ]
      },
      "removed": [
        {
          "id": "seg_0001",
          "marketing_carrier": { "iata_code": "AN" },
          "marketing_carrier_flight_number": "1234",
          "origin": { "iata_code": "EZE", "city_name": "Buenos Aires" },
          "destination": { "iata_code": "SCL", "city_name": "Santiago" },
          "departing_at": "2026-12-10T08:30:00-03:00",
          "arriving_at": "2026-12-10T10:40:00-03:00",
          "seat": "14C"
        }
      ],
      "added": [
        {
          "id": "seg_0002",
          "marketing_carrier": { "iata_code": "AN" },
          "marketing_carrier_flight_number": "1234",
          "origin": { "iata_code": "EZE", "city_name": "Buenos Aires" },
          "destination": { "iata_code": "SCL", "city_name": "Santiago" },
          "departing_at": "2026-12-10T11:15:00-03:00",
          "arriving_at": "2026-12-10T13:25:00-03:00",
          "seat": "14C"
        }
      ]
    }
  }
}
```

### Tipos de aviso

| `type` | Cuándo | `data.object` |
|---|---|---|
| `order.airline_initiated_change_detected` | La aerolínea cambió el horario, el vuelo o la ruta, o canceló el vuelo (tormenta, cancelación masiva). | `order` actual, `removed` (segmentos que ya no están) y `added` (segmentos nuevos). En una cancelación, `order.status` es `cancelled`, `cancelled_at` tiene fecha y `added` va vacío. |
| `order.updated` | Se aplicó una reprogramación pedida por Trotamundos (sección 3). | Igual que el anterior. |

### Firma (`X-Webhook-Signature`)

Mismo esquema que Duffel: `t=<segundos epoch>,v1=<firma>`, donde la firma es
`HMAC-SHA256(secreto, t + "." + cuerpo)` en hexadecimal en minúsculas, calculada sobre el cuerpo **tal
como llegó** (sin volver a serializar el JSON). El secreto es compartido entre el mock y el adaptador y
sale de una variable de entorno.

El adaptador rechaza con `401` (y no publica nada) si:

- falta el header o no tiene el formato `t=...,v1=...`;
- la firma no coincide (comparación de tiempo constante);
- `t` tiene más de 5 minutos de diferencia con la hora actual (evita que se reenvíe un aviso viejo).

### Respuesta y reintentos

- El Servicio de Integraciones responde `200` (o cualquier `2xx`) en menos de 5 segundos. Lo que tarde más
  lo hace después (publicar con el outbox).
- Si no responde a tiempo o responde un error, el mock reintenta el mismo aviso (mismo `id` e
  `idempotency_key`) con espera creciente. Por eso un aviso puede llegar repetido: el adaptador descarta
  los que ya procesó usando `proveedor` + `booking_reference` + `version` (P2.D2).

### Traducción a `ReservaActualizada.datos`

| Campo del evento | De dónde sale |
|---|---|
| `proveedor` | El de la URL del webhook: `aerolinea-andina`. |
| `numeroReserva` | `order.booking_reference` |
| `estado` | `order.status`: `confirmed` → `confirmada`, `changed` → `modificada`, `cancelled` → `cancelada`. |
| `cambios.inicio` | `departing_at` del primer segmento de `order.segments`, si es distinto del primero de `removed`. |
| `cambios.fin` | `arriving_at` del último segmento de `order.segments`, si es distinto del último de `removed`. |
| `cambios.origen` | `origin.iata_code` del primer segmento, si cambió. |
| `cambios.destino` | `destination.iata_code` del último segmento, si cambió. |
| `cambios.detalle.numeroVuelo` | `marketing_carrier.iata_code` + espacio + `marketing_carrier_flight_number`, si cambió. |
| `origenCambio` | Siempre `proveedor`. |

En una cancelación, `cambios` va vacío (`{}`). El ejemplo de arriba se traduce al ejemplo válido de
`specs/schemas/ejemplos/ReservaActualizada.valido.json` (`inicio` y `fin` nuevos).

Un aviso que no se puede traducir (falta `booking_reference`, `status` desconocido, segmentos vacíos sin
cancelación) va a `no_traducidos` con el cuerpo original (QA-6).

## 3. Reprogramación (opciones y aplicar una)

Lo usa el Servicio de Integraciones para las rutas internas `POST /interna/reprogramaciones/opciones` y
`POST /interna/reprogramaciones/aplicar` (Iteración 7). En Duffel se hace con un pedido de cambio que
devuelve ofertas, y después se elige una. Acá se simplifica a dos llamadas.

### 3.1 Pedir opciones

```
POST /air/order_change_requests
Content-Type: application/json

{ "data": { "order_id": "ord_0000AN000XKQ7PL" } }
```

Respuesta `201`:

```json
{
  "data": {
    "id": "ocr_0000AN0000000007",
    "order_id": "ord_0000AN000XKQ7PL",
    "created_at": "2026-11-28T09:20:00Z",
    "order_change_offers": [
      {
        "id": "oco_0000AN0000000101",
        "expires_at": "2026-11-28T09:50:00Z",
        "change_total_amount": "0.00",
        "change_total_currency": "USD",
        "new_segments": [
          {
            "marketing_carrier": { "iata_code": "AN" },
            "marketing_carrier_flight_number": "1240",
            "origin": { "iata_code": "EZE", "city_name": "Buenos Aires" },
            "destination": { "iata_code": "SCL", "city_name": "Santiago" },
            "departing_at": "2026-12-10T14:00:00-03:00",
            "arriving_at": "2026-12-10T16:10:00-03:00"
          }
        ]
      }
    ]
  }
}
```

- El mock devuelve de 0 a 3 ofertas (vuelos posteriores de la misma ruta).
- Una reserva cancelada también puede pedir opciones (reubicación después de una cancelación).
- Orden inexistente: `404`.

### 3.2 Aplicar una opción

```
POST /air/order_changes
Content-Type: application/json

{ "data": { "selected_order_change_offer": "oco_0000AN0000000101" } }
```

Respuesta `201`:

```json
{
  "data": {
    "id": "oce_0000AN0000000055",
    "order_id": "ord_0000AN000XKQ7PL",
    "selected_order_change_offer": "oco_0000AN0000000101",
    "confirmed_at": "2026-11-28T09:21:10Z"
  }
}
```

- Después de confirmar, el mock actualiza la orden (`status: changed`, `version` + 1) y manda el webhook
  `order.updated`. Así el cambio vuelve a entrar como `ReservaActualizada` y Viajes lo guarda (P2.D3).
- Oferta inexistente: `404`. Oferta vencida (`expires_at` pasado) o ya usada: `422`.
- El Servicio de Integraciones solo manda un `selected_order_change_offer` que haya venido en la respuesta
  de 3.1 (nunca uno inventado).

## Errores

Formato propio del mock, parecido al de Duffel:

```json
{
  "errors": [
    {
      "code": "not_found",
      "title": "Not found",
      "message": "No order with booking_reference XKQ7PX"
    }
  ],
  "meta": { "status": 404, "request_id": "FZW0H3HdJwKk5HMAAKxB" }
}
```

| Código HTTP | `code` | Cuándo |
|---|---|---|
| `401` | `unauthorized` | Falta la clave de API o es inválida. |
| `404` | `not_found` | Orden u oferta inexistente. |
| `422` | `offer_no_longer_available` | Oferta vencida o ya usada. |
| `503` | `service_unavailable` | Falla simulada desde `/admin` (degradación controlada, ADR-019). |

## Fuera del formato real

Las rutas `/admin/...` del mock (generar cambios y cancelaciones, tormenta de cancelaciones masivas,
configurar demora y fallas, semillas) son solo para pruebas y las define el mock (P2.D1).
