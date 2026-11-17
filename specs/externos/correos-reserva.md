# Correos de reserva (marcado schema.org en JSON-LD)

Cómo son los correos de reserva que generan los mocks de correo (`mocks/gmail` y `mocks/outlook`, con el
generador compartido de `mocks/comun`) y cómo los traducen los procesadores de correo al evento
`ReservaDetectada` (Iteración 2; `specs/schemas/ReservaDetectada.json`).

Las aerolíneas, hoteles y rentadoras reales mandan en el HTML del correo un bloque
`<script type="application/ld+json">` con el vocabulario de schema.org. Es lo que leen Gmail y otros
clientes para mostrar las tarjetas de viaje. Los mocks hacen lo mismo.

| Tema | Documentación oficial |
|---|---|
| Marcado de vuelos en correos (Google) | https://developers.google.com/workspace/gmail/markup/reference/flight-reservation |
| Marcado de hoteles en correos (Google) | https://developers.google.com/workspace/gmail/markup/reference/hotel-reservation |
| Marcado de autos en correos (Google) | https://developers.google.com/workspace/gmail/markup/reference/rental-car |
| `FlightReservation` | https://schema.org/FlightReservation |
| `LodgingReservation` | https://schema.org/LodgingReservation |
| `RentalCarReservation` | https://schema.org/RentalCarReservation |
| `ReservationStatusType` | https://schema.org/ReservationStatusType |

Formatos comprobados contra la documentación oficial en noviembre de 2026. Los ejemplos siguen los
ejemplos mínimos de Google, con los datos de prueba de Trotamundos.

## Diferencias entre Google y schema.org que el procesador tiene que aceptar

| Dato | Ejemplos de Google | schema.org | Qué hace el procesador |
|---|---|---|---|
| Estado | `http://schema.org/Confirmed` | `https://schema.org/ReservationConfirmed` (también `ReservationCancelled`, `ReservationHold`, `ReservationPending`) | Acepta los dos nombres, con `http` o `https`. |
| Entrada y salida del hotel | `checkinDate`, `checkoutDate` | `checkinTime`, `checkoutTime` | Acepta los dos. Los mocks usan `checkinDate` y `checkoutDate`. |
| `@context` | `http://schema.org` | `https://schema.org` | Acepta los dos. |

## Proveedores de prueba

Los mocks de correo y los mocks de proveedores usan los mismos proveedores y números de reserva, así los
cambios que avisa o informa un proveedor (`ReservaActualizada`) caen sobre reservas que llegaron por
correo (P2.D1).

| `proveedor` en Trotamundos | Nombre | Remitente de los correos | Mock del proveedor |
|---|---|---|---|
| `aerolinea-andina` | Aerolínea Andina (código IATA `AN`) | `reservas@aerolinea-andina.example` | [aerolinea.md](aerolinea.md), puerto 4003 |
| `hotel-cordillera` | Hotel Cordillera | `reservas@hotel-cordillera.example` | [hotel.md](hotel.md), puerto 4004 |
| `rentadora-sur` | Rentadora Sur | `reservas@rentadora-sur.example` | [rentadora.md](rentadora.md), puerto 4005 |

Los dominios terminan en `.example` (reservado para ejemplos, RFC 2606), así nunca apuntan a un sistema
real.

**`proveedor` sale del remitente, no del marcado:** el procesador busca el dominio del `From` en una tabla
de configuración dominio → identificador. Es el mismo identificador que usa el Servicio de Integraciones
para ese proveedor; si no, Viajes no podría encontrar la reserva cuando llega un `ReservaActualizada`
(que solo trae `proveedor` y `numeroReserva`).

## 1. Vuelo (`FlightReservation`)

Correo HTML completo, como lo genera el mock:

```html
<html>
  <head>
    <script type="application/ld+json">
      {
        "@context": "http://schema.org",
        "@type": "FlightReservation",
        "reservationNumber": "XKQ7PL",
        "reservationStatus": "http://schema.org/Confirmed",
        "underName": { "@type": "Person", "name": "Ana García" },
        "reservationFor": {
          "@type": "Flight",
          "flightNumber": "1234",
          "airline": { "@type": "Airline", "name": "Aerolínea Andina", "iataCode": "AN" },
          "departureAirport": {
            "@type": "Airport",
            "name": "Aeropuerto Internacional Ministro Pistarini",
            "iataCode": "EZE"
          },
          "departureTime": "2026-12-10T08:30:00-03:00",
          "arrivalAirport": {
            "@type": "Airport",
            "name": "Aeropuerto Internacional Arturo Merino Benítez",
            "iataCode": "SCL"
          },
          "arrivalTime": "2026-12-10T10:40:00-03:00"
        },
        "airplaneSeat": "14C"
      }
    </script>
  </head>
  <body>
    <p>Hola Ana, tu reserva <strong>XKQ7PL</strong> está confirmada.</p>
    <p>Vuelo AN 1234, Buenos Aires (EZE) a Santiago (SCL), 10/12/2026 08:30.</p>
  </body>
</html>
```

Campos obligatorios según Google: `reservationNumber`, `reservationStatus`, `underName.name`,
`reservationFor.flightNumber`, `reservationFor.airline` (`name` e `iataCode`),
`reservationFor.departureAirport` (`name` e `iataCode`), `reservationFor.departureTime`,
`reservationFor.arrivalAirport` (`name` e `iataCode`) y `reservationFor.arrivalTime`.

Traducción a `ReservaDetectada.datos`:

| Campo del evento | De dónde sale | Ejemplo |
|---|---|---|
| `tipoReserva` | `@type` = `FlightReservation` | `vuelo` |
| `proveedor` | Dominio del remitente (tabla de arriba) | `aerolinea-andina` |
| `numeroReserva` | `reservationNumber` | `XKQ7PL` |
| `inicio` | `reservationFor.departureTime` | `2026-12-10T08:30:00-03:00` |
| `fin` | `reservationFor.arrivalTime` | `2026-12-10T10:40:00-03:00` |
| `origen` | `reservationFor.departureAirport.iataCode` | `EZE` |
| `destino` | `reservationFor.arrivalAirport.iataCode` | `SCL` |
| `detalle.numeroVuelo` | `airline.iataCode` + espacio + `flightNumber` | `AN 1234` |
| `detalle.asiento` | `airplaneSeat` (opcional) | `14C` |
| `correoId` | `id` del mensaje en Gmail o en Graph | `18c4f2a9d7e3b001` |
| `usuarioId` | Dueño del buzón (no está en el correo) | |

## 2. Hotel (`LodgingReservation`)

```json
{
  "@context": "http://schema.org",
  "@type": "LodgingReservation",
  "reservationNumber": "HC-48213",
  "reservationStatus": "http://schema.org/Confirmed",
  "underName": { "@type": "Person", "name": "Ana García" },
  "reservationFor": {
    "@type": "LodgingBusiness",
    "name": "Hotel Cordillera",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "Av. Providencia 1234",
      "addressLocality": "Santiago",
      "addressRegion": "Región Metropolitana",
      "postalCode": "7500000",
      "addressCountry": "CL"
    },
    "telephone": "+56 2 2345 6789"
  },
  "checkinDate": "2026-12-10T15:00:00-03:00",
  "checkoutDate": "2026-12-14T11:00:00-03:00"
}
```

Campos obligatorios según Google: `reservationNumber`, `reservationStatus`, `underName.name`,
`reservationFor.name`, `reservationFor.address` (calle, ciudad, región, código postal y país),
`reservationFor.telephone`, `checkinDate`, `checkoutDate`.

| Campo del evento | De dónde sale | Ejemplo |
|---|---|---|
| `tipoReserva` | `@type` = `LodgingReservation` | `hotel` |
| `proveedor` | Dominio del remitente | `hotel-cordillera` |
| `numeroReserva` | `reservationNumber` | `HC-48213` |
| `inicio` | `checkinDate` (o `checkinTime`) | `2026-12-10T15:00:00-03:00` |
| `fin` | `checkoutDate` (o `checkoutTime`) | `2026-12-14T11:00:00-03:00` |
| `origen` | No se manda (un hotel no tiene origen) | |
| `destino` | `reservationFor.address.addressLocality` | `Santiago` |
| `detalle.hotel` | `reservationFor.name` | `Hotel Cordillera` |
| `detalle.direccion` | `reservationFor.address.streetAddress` | `Av. Providencia 1234` |
| `detalle.telefono` | `reservationFor.telephone` | `+56 2 2345 6789` |

## 3. Auto (`RentalCarReservation`)

```json
{
  "@context": "http://schema.org",
  "@type": "RentalCarReservation",
  "reservationNumber": "RS-77120",
  "reservationStatus": "http://schema.org/Confirmed",
  "underName": { "@type": "Person", "name": "Ana García" },
  "reservationFor": {
    "@type": "RentalCar",
    "name": "Económico",
    "model": "Yaris",
    "brand": { "@type": "Brand", "name": "Toyota" },
    "rentalCompany": { "@type": "Organization", "name": "Rentadora Sur" }
  },
  "pickupLocation": {
    "@type": "Place",
    "name": "Rentadora Sur Aeropuerto SCL",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "Armando Cortínez Oriente 1704",
      "addressLocality": "Pudahuel",
      "addressRegion": "Región Metropolitana",
      "postalCode": "9020000",
      "addressCountry": "CL"
    }
  },
  "pickupTime": "2026-12-10T11:30:00-03:00",
  "dropoffLocation": {
    "@type": "Place",
    "name": "Rentadora Sur Aeropuerto SCL",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "Armando Cortínez Oriente 1704",
      "addressLocality": "Pudahuel",
      "addressRegion": "Región Metropolitana",
      "postalCode": "9020000",
      "addressCountry": "CL"
    }
  },
  "dropoffTime": "2026-12-14T09:00:00-03:00"
}
```

Campos obligatorios según Google: `reservationNumber`, `reservationStatus`, `underName.name`,
`reservationFor` (`name`, `model`, `brand.name`, `rentalCompany.name`), `pickupLocation` (`name` y
dirección), `pickupTime`, `dropoffLocation` (`name` y dirección), `dropoffTime`. La tabla de Google también
marca `potentialAction` como obligatorio, pero su ejemplo básico no lo trae; los mocks no lo mandan y el
procesador no lo necesita.

| Campo del evento | De dónde sale | Ejemplo |
|---|---|---|
| `tipoReserva` | `@type` = `RentalCarReservation` | `auto` |
| `proveedor` | Dominio del remitente | `rentadora-sur` |
| `numeroReserva` | `reservationNumber` | `RS-77120` |
| `inicio` | `pickupTime` | `2026-12-10T11:30:00-03:00` |
| `fin` | `dropoffTime` | `2026-12-14T09:00:00-03:00` |
| `origen` | `pickupLocation.name` | `Rentadora Sur Aeropuerto SCL` |
| `destino` | `dropoffLocation.name` | `Rentadora Sur Aeropuerto SCL` |
| `detalle.modelo` | `brand.name` + espacio + `model` | `Toyota Yaris` |
| `detalle.categoria` | `reservationFor.name` | `Económico` |

## 4. Correos sin marcado (solo texto)

Algunos proveedores reales no mandan JSON-LD. No hay un estándar para el texto: el generador de los mocks
usa estas plantillas fijas y los procesadores las reconocen con reglas de texto (P2.B6). Un correo que no
coincide con ninguna regla va a `no_procesados` (medición del 99 % de QA-6 y QA-7).

```
Aerolínea Andina - Confirmación de reserva
Código de reserva: XKQ7PL
Vuelo: AN 1234
Salida: EZE 2026-12-10 08:30 (-03:00)
Llegada: SCL 2026-12-10 10:40 (-03:00)
```

```
Hotel Cordillera - Confirmación de reserva
Número de reserva: HC-48213
Ciudad: Santiago
Entrada: 2026-12-10 15:00 (-03:00)
Salida: 2026-12-14 11:00 (-03:00)
```

```
Rentadora Sur - Confirmación de reserva
Número de reserva: RS-77120
Retiro: Rentadora Sur Aeropuerto SCL 2026-12-10 11:30 (-03:00)
Devolución: Rentadora Sur Aeropuerto SCL 2026-12-14 09:00 (-03:00)
Vehículo: Toyota Yaris (Económico)
```

## Preguntas abiertas para la revisión cruzada (P0.5)

- `ReservaDetectada` no tiene estado. Un correo con `reservationStatus` cancelado o en espera
  (`Cancelled`, `ReservationCancelled`, `ReservationHold`, `ReservationPending`) hoy no tiene evento: se
  propone que el procesador publique solo los confirmados y deje los demás en `no_procesados`. Los cambios
  y cancelaciones llegan por el Servicio de Integraciones (`ReservaActualizada`).
- Un correo de modificación (mismo `reservationNumber`, con `modifiedTime`) publica otro
  `ReservaDetectada` con el mismo `proveedor` + `numeroReserva`: Viajes tiene que actualizar la reserva
  existente en lugar de crear una nueva.
