// Caso de Uso 1 (UC-1, Iteración 2): Procesamiento de correo.
// Detecta correos de reserva en buzones conectados de Gmail y Outlook mediante OAuth y los agrega
// automáticamente al panel de viajes del usuario (ADR-002, ADR-010, ADR-015).
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
  sistemaDisponible,
  type SesionE2E,
} from './comun.ts';

const haySistema = await sistemaDisponible();

describe.skipIf(!haySistema)('UC-1: Procesamiento de correo (Gmail y Outlook)', () => {
  let sesion: SesionE2E;
  const buzonGmail = `uc1-gmail-${idAleatorio()}@gmail.example`;
  const buzonOutlook = `uc1-outlook-${idAleatorio()}@outlook.example`;
  const codigoVuelo = `UC1-VUE-${idAleatorio()}`;
  const codigoHotel = `UC1-HTL-${idAleatorio()}`;

  beforeAll(async () => {
    sesion = await registrarYLogin({ nombre: 'Viajero UC1' });
  });

  afterAll(async () => {
    if (!sesion) return;
    await eliminarReservasUsuario(sesion);
    await desconectarCuentasCorreo(sesion);
  });

  it('conecta cuentas de Gmail y Outlook y detecta reservas automáticamente en el panel', async () => {
    // 1. Conectar buzón de Gmail por OAuth.
    await conectarOAuthMock({
      proveedor: 'gmail',
      emailBuzon: buzonGmail,
      jwt: sesion.jwt,
      region: sesion.region,
    });

    // 2. Conectar buzón de Outlook por OAuth.
    await conectarOAuthMock({
      proveedor: 'outlook',
      emailBuzon: buzonOutlook,
      jwt: sesion.jwt,
      region: sesion.region,
    });

    // 3. Verificar que ambas cuentas aparecen en el Servicio de Correo.
    const cuentas = await pedirJson<{ cuentas: { email: string; proveedor: string }[] }>(
      `${CONFIG_E2E.urlEnrutador}/api/correo/cuentas-correo`,
      { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
    );
    expect(cuentas.status).toBe(200);
    const emailsConectados = (cuentas.datos?.cuentas ?? []).map((c) => c.email.toLowerCase());
    expect(emailsConectados).toContain(buzonGmail.toLowerCase());
    expect(emailsConectados).toContain(buzonOutlook.toLowerCase());

    // 4. Inyectar correo de confirmación de vuelo en mock-gmail (genera aviso Pub/Sub push).
    const jsonLdVuelo = {
      '@context': 'https://schema.org',
      '@type': 'FlightReservation',
      reservationNumber: codigoVuelo,
      reservationStatus: 'https://schema.org/ReservationConfirmed',
      underName: { '@type': 'Person', name: sesion.nombre },
      reservationFor: {
        '@type': 'Flight',
        flightNumber: 'AN 2044',
        airline: { '@type': 'Airline', name: 'Aerolínea Andina', iataCode: 'AN' },
        departureAirport: { '@type': 'Airport', name: 'Buenos Aires', iataCode: 'EZE' },
        arrivalAirport: { '@type': 'Airport', name: 'Santiago', iataCode: 'SCL' },
        departureTime: '2026-12-15T09:00:00-03:00',
        arrivalTime: '2026-12-15T11:15:00-03:00',
      },
      airplaneSeat: '15B',
    };
    await inyectarCorreo(CONFIG_E2E.urlMockGmail, buzonGmail, {
      de: 'Aerolínea Andina <reservas@aerolinea-andina.example>',
      asunto: `Confirmación de vuelo AN 2044 — ${codigoVuelo}`,
      texto: `Tu vuelo AN 2044 (${codigoVuelo}) está confirmado.`,
      html: `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(jsonLdVuelo)}</script></head><body>Confirmado</body></html>`,
    });

    // 5. Inyectar correo de confirmación de hotel en mock-outlook (genera suscripción push Graph).
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
      checkinTime: '2026-12-15T15:00:00-03:00',
      checkoutTime: '2026-12-18T11:00:00-03:00',
    };
    await inyectarCorreo(CONFIG_E2E.urlMockOutlook, buzonOutlook, {
      de: 'Hotel Cordillera <reservas@hotel-cordillera.example>',
      asunto: `Confirmación de estadía Hotel Cordillera — ${codigoHotel}`,
      texto: `Tu estadía ${codigoHotel} está confirmada.`,
      html: `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(jsonLdHotel)}</script></head><body>Confirmado</body></html>`,
    });

    // 6. Esperar a que el procesamiento asíncrono (Correo → RabbitMQ → Viajes) agregue ambas reservas al panel.
    interface ReservaPanel {
      numeroReserva: string;
      tipoReserva: string;
      estado: string;
    }
    interface ViajePanel {
      viajeId: string;
      destino: string;
      reservas: ReservaPanel[];
    }
    interface PanelRespuesta {
      viajes: ViajePanel[];
    }

    const panel = await esperarCondicion<PanelRespuesta>(
      async () => {
        const resp = await pedirJson<PanelRespuesta>(
          `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
          { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
        );
        if (resp.status !== 200 || !resp.datos) return undefined;
        const todasReservas = resp.datos.viajes.flatMap((v) => v.reservas);
        const tieneVuelo = todasReservas.some((r) => r.numeroReserva === codigoVuelo);
        const tieneHotel = todasReservas.some((r) => r.numeroReserva === codigoHotel);
        return tieneVuelo && tieneHotel ? resp.datos : undefined;
      },
      25_000,
      1_000,
    );

    const reservas = panel.viajes.flatMap((v) => v.reservas);
    const reservaVuelo = reservas.find((r) => r.numeroReserva === codigoVuelo);
    const reservaHotel = reservas.find((r) => r.numeroReserva === codigoHotel);

    expect(reservaVuelo).toMatchObject({
      numeroReserva: codigoVuelo,
      tipoReserva: 'vuelo',
      estado: 'confirmada',
    });
    expect(reservaHotel).toMatchObject({
      numeroReserva: codigoHotel,
      tipoReserva: 'hotel',
      estado: 'confirmada',
    });
  });
});
