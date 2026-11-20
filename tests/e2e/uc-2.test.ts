// Caso de Uso 2 (UC-2, Iteración 5): Filtros y whitelist de remitentes.
// Un usuario configura su whitelist; los correos de remitentes fuera de la lista segura se descartan
// y sus reservas nunca llegan al panel de viajes (ADR-005, ADR-015).
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

describe.skipIf(!haySistema)('UC-2: Filtros y whitelist de remitentes', () => {
  let sesion: SesionE2E;
  const buzonGmail = `uc2-gmail-${idAleatorio()}@gmail.example`;
  const remitenteValido = 'reservas@aerolinea-andina.example';
  const remitenteFuera = 'spammer@desconocido-no-whitelist.example';
  const codigoRechazado = `UC2-BLOCK-${idAleatorio()}`;
  const codigoAceptado = `UC2-ALLOW-${idAleatorio()}`;

  beforeAll(async () => {
    sesion = await registrarYLogin({ nombre: 'Viajero UC2' });
  });

  afterAll(async () => {
    if (!sesion) return;
    await eliminarReservasUsuario(sesion);
    await desconectarCuentasCorreo(sesion);
  });

  it('descarta correos de remitentes fuera de la whitelist y solo acepta remitentes permitidos', async () => {
    // 1. Configurar whitelist activa con solo el remitente seguro.
    const respWhitelist = await pedirJson(`${CONFIG_E2E.urlEnrutador}/api/usuarios/whitelist`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sesion.jwt}`,
        'X-Region': sesion.region,
      },
      body: JSON.stringify({
        filtrosActivos: true,
        remitentesPermitidos: [remitenteValido],
      }),
    });
    expect(respWhitelist.status).toBe(200);

    // 2. Conectar buzón de Gmail por OAuth.
    await conectarOAuthMock({
      proveedor: 'gmail',
      emailBuzon: buzonGmail,
      jwt: sesion.jwt,
      region: sesion.region,
    });

    // 3. Inyectar correo con reserva desde un remitente fuera de la whitelist.
    const jsonLdBloqueado = {
      '@context': 'https://schema.org',
      '@type': 'FlightReservation',
      reservationNumber: codigoRechazado,
      reservationStatus: 'https://schema.org/ReservationConfirmed',
      underName: { '@type': 'Person', name: sesion.nombre },
      reservationFor: {
        '@type': 'Flight',
        flightNumber: 'SP 9999',
        departureAirport: { '@type': 'Airport', name: 'Buenos Aires', iataCode: 'EZE' },
        arrivalAirport: { '@type': 'Airport', name: 'Santiago', iataCode: 'SCL' },
        departureTime: '2026-12-28T09:00:00-03:00',
        arrivalTime: '2026-12-28T11:15:00-03:00',
      },
    };
    await inyectarCorreo(CONFIG_E2E.urlMockGmail, buzonGmail, {
      de: `Remitente No Autorizado <${remitenteFuera}>`,
      asunto: `Vuelo bloqueado — ${codigoRechazado}`,
      texto: `Vuelo ${codigoRechazado} que no debe procesarse.`,
      html: `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(jsonLdBloqueado)}</script></head><body>Bloqueado</body></html>`,
    });

    // 4. Inyectar correo con reserva desde el remitente permitido en la whitelist.
    const jsonLdPermitido = {
      '@context': 'https://schema.org',
      '@type': 'FlightReservation',
      reservationNumber: codigoAceptado,
      reservationStatus: 'https://schema.org/ReservationConfirmed',
      underName: { '@type': 'Person', name: sesion.nombre },
      reservationFor: {
        '@type': 'Flight',
        flightNumber: 'AN 1010',
        airline: { '@type': 'Airline', name: 'Aerolínea Andina', iataCode: 'AN' },
        departureAirport: { '@type': 'Airport', name: 'Buenos Aires', iataCode: 'EZE' },
        arrivalAirport: { '@type': 'Airport', name: 'Santiago', iataCode: 'SCL' },
        departureTime: '2026-12-28T14:00:00-03:00',
        arrivalTime: '2026-12-28T16:15:00-03:00',
      },
    };
    await inyectarCorreo(CONFIG_E2E.urlMockGmail, buzonGmail, {
      de: `Aerolínea Andina <${remitenteValido}>`,
      asunto: `Vuelo permitido — ${codigoAceptado}`,
      texto: `Vuelo ${codigoAceptado} confirmado.`,
      html: `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(jsonLdPermitido)}</script></head><body>Permitido</body></html>`,
    });

    // 5. Esperar a que el correo permitido llegue al panel.
    interface PanelRespuesta {
      viajes: { reservas: { numeroReserva: string }[] }[];
    }
    const panel = await esperarCondicion<PanelRespuesta>(
      async () => {
        const resp = await pedirJson<PanelRespuesta>(
          `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
          { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
        );
        if (resp.status !== 200 || !resp.datos) return undefined;
        const codigos = resp.datos.viajes.flatMap((v) => v.reservas).map((r) => r.numeroReserva);
        return codigos.includes(codigoAceptado) ? resp.datos : undefined;
      },
      25_000,
      1_000,
    );

    // 6. Verificar que la reserva del remitente fuera de la whitelist NO apareció en el panel.
    const todasReservas = panel.viajes.flatMap((v) => v.reservas).map((r) => r.numeroReserva);
    expect(todasReservas).toContain(codigoAceptado);
    expect(todasReservas).not.toContain(codigoRechazado);
  });
});
