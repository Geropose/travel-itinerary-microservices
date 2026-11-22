// Caso de Uso 3 (UC-3, Iteración 3): Integración con terceros.
// Cambios y cancelaciones de reservas informadas por el proveedor:
// - Aerolínea: avisa por webhook firmado con HMAC-SHA256 (ADR-003, ADR-010).
// - Hotel: detectado por el mecanismo de consulta periódica / polling (QA-1, QA-6).
// Ambos impactos deben reflejarse de forma trazable en el panel de viajes del usuario.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONFIG_E2E,
  conectarOAuthMock,
  desconectarCuentasCorreo,
  eliminarReservasUsuario,
  esperarCondicion,
  idAleatorio,
  inyectarCorreo,
  pedirJson,
  registrarYLogin,
  reiniciarMock,
  sistemaDisponible,
  type SesionE2E,
} from './comun.ts';

const haySistema = await sistemaDisponible();

describe.skipIf(!haySistema)(
  'UC-3: Cambios y cancelaciones desde proveedores (Aerolínea y Hotel)',
  () => {
    let sesion: SesionE2E;
    const buzonGmail = `uc3-gmail-${idAleatorio()}@gmail.example`;
    const codigoVuelo = `UC3-AIR-${idAleatorio()}`;
    const codigoHotel = `UC3-HTL-${idAleatorio()}`;

    beforeAll(async () => {
      sesion = await registrarYLogin({ nombre: 'Viajero UC3' });
      await conectarOAuthMock({
        proveedor: 'gmail',
        emailBuzon: buzonGmail,
        jwt: sesion.jwt,
        region: sesion.region,
      });
    });

    afterAll(async () => {
      if (!sesion) return;
      await eliminarReservasUsuario(sesion);
      await desconectarCuentasCorreo(sesion);
      await reiniciarMock(CONFIG_E2E.urlMockAerolinea);
      await reiniciarMock(CONFIG_E2E.urlMockHotel);
    });

    it('procesa cambio y cancelación de aerolínea (aviso webhook) y de hotel (consulta periódica)', async () => {
      // 1. Crear la orden de vuelo en mock-aerolínea.
      const respOrdenAir = await fetch(`${CONFIG_E2E.urlMockAerolinea}/admin/ordenes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          booking_reference: codigoVuelo,
          status: 'confirmed',
          passenger: { given_name: 'Viajero', family_name: 'UC3' },
          flight_number: '1234',
          origin_iata: 'EZE',
          origin_city: 'Buenos Aires',
          destination_iata: 'SCL',
          destination_city: 'Santiago',
          departing_at: '2026-12-20T08:30:00-03:00',
          arriving_at: '2026-12-20T10:40:00-03:00',
          seat: '12A',
        }),
      });
      expect(respOrdenAir.status).toBe(201);

      // 2. Crear la reserva en mock-hotel.
      const respReservaHotel = await fetch(`${CONFIG_E2E.urlMockHotel}/admin/reservas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reservationId: codigoHotel,
          status: 'confirmed',
          hotelName: 'Hotel Cordillera',
          city: 'Santiago',
          address: 'Av. Providencia 1200',
          countryCode: 'CL',
          guestFirstName: 'Viajero',
          guestLastName: 'UC3',
          checkIn: '2026-12-20T15:00:00-03:00',
          checkOut: '2026-12-24T11:00:00-03:00',
          roomDescription: 'Habitación Clásica',
        }),
      });
      expect(respReservaHotel.status).toBe(201);

      // 3. Inyectar correos de confirmación inicial para asociar
      // ambas reservas al usuario en Trotamundos.
      const jsonLdVuelo = {
        '@context': 'https://schema.org',
        '@type': 'FlightReservation',
        reservationNumber: codigoVuelo,
        reservationStatus: 'https://schema.org/ReservationConfirmed',
        underName: { '@type': 'Person', name: sesion.nombre },
        reservationFor: {
          '@type': 'Flight',
          flightNumber: 'AN 1234',
          airline: { '@type': 'Airline', name: 'Aerolínea Andina', iataCode: 'AN' },
          departureAirport: { '@type': 'Airport', name: 'Buenos Aires', iataCode: 'EZE' },
          arrivalAirport: { '@type': 'Airport', name: 'Santiago', iataCode: 'SCL' },
          departureTime: '2026-12-20T08:30:00-03:00',
          arrivalTime: '2026-12-20T10:40:00-03:00',
        },
        airplaneSeat: '12A',
      };
      await inyectarCorreo(CONFIG_E2E.urlMockGmail, buzonGmail, {
        de: 'Aerolínea Andina <reservas@aerolinea-andina.example>',
        asunto: `Vuelo AN 1234 — ${codigoVuelo}`,
        texto: `Confirmación vuelo ${codigoVuelo}`,
        html:
          '<!doctype html><html><head><script type="application/ld+json">' +
          JSON.stringify(jsonLdVuelo) +
          '</script></head><body>Confirmado</body></html>',
      });

      const jsonLdHotel = {
        '@context': 'https://schema.org',
        '@type': 'LodgingReservation',
        reservationNumber: codigoHotel,
        reservationStatus: 'https://schema.org/ReservationConfirmed',
        underName: { '@type': 'Person', name: sesion.nombre },
        reservationFor: {
          '@type': 'LodgingBusiness',
          name: 'Hotel Cordillera',
          address: {
            '@type': 'PostalAddress',
            streetAddress: 'Av. Providencia 1200',
            addressLocality: 'Santiago',
            addressCountry: 'CL',
          },
        },
        checkinTime: '2026-12-20T15:00:00-03:00',
        checkoutTime: '2026-12-24T11:00:00-03:00',
      };
      await inyectarCorreo(CONFIG_E2E.urlMockGmail, buzonGmail, {
        de: 'Hotel Cordillera <reservas@hotel-cordillera.example>',
        asunto: `Estadía ${codigoHotel}`,
        texto: `Confirmación hotel ${codigoHotel}`,
        html:
          '<!doctype html><html><head><script type="application/ld+json">' +
          JSON.stringify(jsonLdHotel) +
          '</script></head><body>Confirmado</body></html>',
      });

      // 4. Esperar que ambas reservas aparezcan confirmadas en el panel.
      interface ReservaPanel {
        numeroReserva: string;
        estado: string;
        origenCambio?: string;
      }
      interface PanelRespuesta {
        viajes: { reservas: ReservaPanel[] }[];
      }

      await esperarCondicion(
        async () => {
          const resp = await pedirJson<PanelRespuesta>(
            `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
            { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
          );
          if (resp.status !== 200 || !resp.datos) return undefined;
          const resList = resp.datos.viajes.flatMap((v) => v.reservas);
          const vue = resList.find((r) => r.numeroReserva === codigoVuelo);
          const htl = resList.find((r) => r.numeroReserva === codigoHotel);
          return vue && htl ? true : undefined;
        },
        25_000,
        1_000,
      );

      // 5. Cambio en Aerolínea (dispara webhook HMAC hacia enrutador -> integraciones -> viajes).
      const respCambioAir = await fetch(
        `${CONFIG_E2E.urlMockAerolinea}/admin/ordenes/${codigoVuelo}/cambiar`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ desplazarMinutos: 90 }),
        },
      );
      expect(respCambioAir.status).toBe(200);

      // Esperar que el panel refleje el estado "modificada" para el vuelo.
      const vueloModificado = await esperarCondicion<ReservaPanel>(
        async () => {
          const resp = await pedirJson<PanelRespuesta>(
            `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
            { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
          );
          const resList = resp.datos?.viajes.flatMap((v) => v.reservas) ?? [];
          const r = resList.find((x) => x.numeroReserva === codigoVuelo);
          return r?.estado === 'modificada' ? r : undefined;
        },
        20_000,
        1_000,
      );
      expect(vueloModificado.estado).toBe('modificada');
      expect(vueloModificado.origenCambio).toBe('proveedor');

      // 6. Cancelación en Aerolínea.
      const respCancelAir = await fetch(
        `${CONFIG_E2E.urlMockAerolinea}/admin/ordenes/${codigoVuelo}/cancelar`,
        { method: 'POST' },
      );
      expect(respCancelAir.status).toBe(200);

      const vueloCancelado = await esperarCondicion<ReservaPanel>(
        async () => {
          const resp = await pedirJson<PanelRespuesta>(
            `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
            { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
          );
          const resList = resp.datos?.viajes.flatMap((v) => v.reservas) ?? [];
          const r = resList.find((x) => x.numeroReserva === codigoVuelo);
          return r?.estado === 'cancelada' ? r : undefined;
        },
        20_000,
        1_000,
      );
      expect(vueloCancelado.estado).toBe('cancelada');

      // 7. Cancelación en Hotel (proveedor sin aviso; Integraciones detecta por consulta periódica).
      const respCancelHotel = await fetch(
        `${CONFIG_E2E.urlMockHotel}/admin/reservas/${codigoHotel}/cancelar`,
        { method: 'POST' },
      );
      expect(respCancelHotel.status).toBe(200);

      const hotelCancelado = await esperarCondicion<ReservaPanel>(
        async () => {
          const resp = await pedirJson<PanelRespuesta>(
            `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
            { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
          );
          const resList = resp.datos?.viajes.flatMap((v) => v.reservas) ?? [];
          const r = resList.find((x) => x.numeroReserva === codigoHotel);
          return r?.estado === 'cancelada' ? r : undefined;
        },
        30_000,
        1_500,
      );
      expect(hotelCancelado.estado).toBe('cancelada');
      // Las cuatro esperas consecutivas admiten hasta 95 segundos en total.
    }, 120_000);
  },
);
