# Rentadora de autos (sin aviso: solo se puede consultar)

Qué imita el mock `mocks/rentadora` (puerto 4005, dueño D). Lo usa el adaptador de la rentadora del
Servicio de Integraciones (Iteración 3, adaptadores de proveedores de viaje; ADR-003) para obtener cambios y
cancelaciones de reservas de autos (UC-3).

Igual que el hotel, es un proveedor **que no avisa**: el adaptador lo consulta cada 2 minutos
(configurable) y pide las reservas actualizadas desde la última consulta.

## Qué API real imita

No hay un estándar único para las APIs de rentadoras. El formato es un JSON simple inspirado en las APIs de
reservas de autos y en los mensajes de reserva de vehículos de OpenTravel (OTA): reserva con número de
confirmación, estado, versión, conductor, vehículo identificado con su código ACRISS (el código de 4 letras
que usa toda la industria para la categoría del auto) y lugares y horarios de retiro y devolución.

| Tema | Documentación de referencia |
|---|---|
| OpenTravel Alliance (mensajes de reserva de vehículos) | https://opentravel.org/ |
| Códigos ACRISS de categoría de vehículo | https://www.acriss.org/car-codes/ |

A propósito, el formato es distinto del hotel (otros nombres de campos y paginación por número de página):
así se prueba que cada adaptador traduce el formato de su proveedor sin afectar a los demás (QA-10).

## Datos de prueba

| Dato | Valor |
|---|---|
| `proveedor` en Trotamundos | `rentadora-sur` |
| Nombre | Rentadora Sur |
| Remitente de sus correos | `reservas@rentadora-sur.example` ([correos-reserva.md](correos-reserva.md)) |

Los `confirmationNumber` del mock son los mismos números que mandan los correos de reserva (por ejemplo
`RS-77120`), y los nombres de las sucursales coinciden con `pickupLocation.name` y `dropoffLocation.name`
del correo.

## Autenticación

Cada llamada lleva `Authorization: Bearer <clave de API>`. La clave sale de una variable de entorno. Sin
clave o con una clave inválida: `401`.

## Recurso `booking`

```json
{
  "confirmationNumber": "RS-77120",
  "status": "CONFIRMED",
  "version": 1,
  "createdAt": "2026-11-21T10:15:00Z",
  "updatedAt": "2026-11-21T10:15:00Z",
  "driver": { "firstName": "Ana", "lastName": "García" },
  "vehicle": {
    "acrissCode": "ECMR",
    "categoryName": "Económico",
    "make": "Toyota",
    "model": "Yaris"
  },
  "pickUp": {
    "locationCode": "SCLA01",
    "locationName": "Rentadora Sur Aeropuerto SCL",
    "city": "Santiago",
    "dateTime": "2026-12-10T11:30:00-03:00"
  },
  "dropOff": {
    "locationCode": "SCLA01",
    "locationName": "Rentadora Sur Aeropuerto SCL",
    "city": "Santiago",
    "dateTime": "2026-12-14T09:00:00-03:00"
  }
}
```

| Campo | Significado |
|---|---|
| `confirmationNumber` | Número de reserva de la rentadora. Es el `numeroReserva` de Trotamundos. |
| `status` | `CONFIRMED`, `MODIFIED` o `CANCELLED` (en mayúsculas, a diferencia del hotel). |
| `version` | Sube en 1 con cada cambio. Junto con `confirmationNumber` identifica un cambio. |
| `updatedAt` | Fecha del último cambio (UTC). Es lo que filtra la consulta. |
| `vehicle.acrissCode` | Categoría ACRISS: `ECMR` = económico, 2 o 4 puertas, manual, con aire acondicionado. |
| `pickUp` / `dropOff` | Retiro y devolución: sucursal y fecha y hora con la diferencia horaria local (ISO 8601). |

## 1. Consultar reservas actualizadas (la usa el adaptador cada 2 minutos)

```
GET /api/v1/bookings?updatedSince=2026-11-28T12:00:00Z&page=1&pageSize=50
```

| Parámetro | Uso |
|---|---|
| `updatedSince` | Obligatorio. Fecha ISO 8601 en UTC. Devuelve las reservas con `updatedAt` **mayor o igual**. |
| `page` | Número de página, desde 1. Por defecto 1. |
| `pageSize` | De 1 a 200. Por defecto 50. |

Respuesta `200`, ordenada por `updatedAt` de menor a mayor:

```json
{
  "bookings": [
    {
      "confirmationNumber": "RS-77120",
      "status": "CANCELLED",
      "version": 2,
      "createdAt": "2026-11-21T10:15:00Z",
      "updatedAt": "2026-11-28T12:07:40Z",
      "driver": { "firstName": "Ana", "lastName": "García" },
      "vehicle": {
        "acrissCode": "ECMR",
        "categoryName": "Económico",
        "make": "Toyota",
        "model": "Yaris"
      },
      "pickUp": {
        "locationCode": "SCLA01",
        "locationName": "Rentadora Sur Aeropuerto SCL",
        "city": "Santiago",
        "dateTime": "2026-12-10T11:30:00-03:00"
      },
      "dropOff": {
        "locationCode": "SCLA01",
        "locationName": "Rentadora Sur Aeropuerto SCL",
        "city": "Santiago",
        "dateTime": "2026-12-14T09:00:00-03:00"
      }
    }
  ],
  "page": 1,
  "pageSize": 50,
  "totalCount": 1
}
```

- Sin cambios: `{ "bookings": [], "page": 1, "pageSize": 50, "totalCount": 0 }`.
- Si `page * pageSize < totalCount`, hay más páginas: se piden con `page + 1` y el mismo `updatedSince`.
- Como el filtro es "mayor o igual", la última reserva de una consulta vuelve a aparecer en la siguiente.
  El adaptador guarda el `updatedAt` más alto que vio como próximo `updatedSince`, y descarta los pares
  `confirmationNumber` + `version` que ya procesó.
- `updatedSince` faltante o inválido: `400`.

## 2. Consultar una reserva

```
GET /api/v1/bookings/RS-77120
```

Respuesta `200`: un recurso `booking`. Si no existe: `404`.

## Traducción a `ReservaActualizada.datos`

Igual que el hotel, la rentadora no dice qué campos cambiaron: el adaptador compara con la última versión
que vio y manda en `cambios` solo lo distinto. Si es la primera vez que ve esa reserva, manda `inicio`,
`fin`, `origen` y `destino` actuales.

| Campo del evento | De dónde sale |
|---|---|
| `proveedor` | Configuración del adaptador: `rentadora-sur`. |
| `numeroReserva` | `confirmationNumber` |
| `estado` | `status`: `CONFIRMED` → `confirmada`, `MODIFIED` → `modificada`, `CANCELLED` → `cancelada`. |
| `cambios.inicio` | `pickUp.dateTime`, si cambió. |
| `cambios.fin` | `dropOff.dateTime`, si cambió. |
| `cambios.origen` | `pickUp.locationName`, si cambió. |
| `cambios.destino` | `dropOff.locationName`, si cambió. |
| `cambios.detalle.modelo` | `vehicle.make` + espacio + `vehicle.model`, si cambió. |
| `cambios.detalle.categoria` | `vehicle.categoryName`, si cambió. |
| `origenCambio` | Siempre `proveedor`. |

Ejemplo de la cancelación de arriba:

```json
{
  "proveedor": "rentadora-sur",
  "numeroReserva": "RS-77120",
  "estado": "cancelada",
  "cambios": {},
  "origenCambio": "proveedor"
}
```

Una reserva que no se puede traducir va a `no_traducidos` con el JSON original (QA-6).

## Errores

```json
{ "status": 404, "errorCode": "BOOKING_NOT_FOUND", "message": "Booking RS-77199 does not exist" }
```

| Código HTTP | `errorCode` | Cuándo |
|---|---|---|
| `400` | `INVALID_REQUEST` | `updatedSince` faltante o inválido, `page` o `pageSize` fuera de rango. |
| `401` | `UNAUTHORIZED` | Falta la clave de API o es inválida. |
| `404` | `BOOKING_NOT_FOUND` | Reserva inexistente. |
| `503` | `SERVICE_UNAVAILABLE` | Falla simulada desde `/admin`. El adaptador vuelve a consultar en el próximo intervalo con el mismo `updatedSince`. |

## Fuera del formato real

Las rutas `/admin/...` del mock (generar cambios y cancelaciones, configurar demora y fallas, semillas) son
solo para pruebas y las define el mock (P2.D1).
