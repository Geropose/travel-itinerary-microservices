// Caso de Uso 8 (UC-8, Iteración 7): Asistente virtual (chatbot).
// Actúa como primer nivel de soporte interactivo (ADR-018, ADR-019, QA-12):
// 1. Consulta de estado de reserva.
// 2. Reprogramación de vuelo con confirmación explícita.
// 3. Resolución de problema menor (preguntas frecuentes sin escalar).
// 4. Derivación del caso complejo a la agencia preferida.
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
  'UC-8: Asistente virtual (estado, reprogramación, problema menor y derivación)',
  () => {
    let sesion: SesionE2E;
    const buzonGmail = `uc8-gmail-${idAleatorio()}@gmail.example`;
    const codigoVuelo = 'XKQ7PL';
    const agencia = 'viajes-del-plata';

    beforeAll(async () => {
      sesion = await registrarYLogin({ nombre: 'Viajero UC8' });

      // Configurar agencia preferida en el perfil.
      await pedirJson(`${CONFIG_E2E.urlEnrutador}/api/usuarios/perfil`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sesion.jwt}`,
          'X-Region': sesion.region,
        },
        body: JSON.stringify({ agenciaPreferida: agencia }),
      });

      // Conectar buzón e inyectar vuelo canónico XKQ7PL.
      await conectarOAuthMock({
        proveedor: 'gmail',
        emailBuzon: buzonGmail,
        jwt: sesion.jwt,
        region: sesion.region,
      });

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
          departureTime: '2026-12-10T08:30:00-03:00',
          arrivalTime: '2026-12-10T10:40:00-03:00',
        },
        airplaneSeat: '14C',
      };
      await inyectarCorreo(CONFIG_E2E.urlMockGmail, buzonGmail, {
        de: 'Aerolínea Andina <reservas@aerolinea-andina.example>',
        asunto: `Confirmación de vuelo AN 1234 — ${codigoVuelo}`,
        texto: `Vuelo ${codigoVuelo} confirmado.`,
        html:
          '<!doctype html><html><head><script type="application/ld+json">' +
          JSON.stringify(jsonLdVuelo) +
          '</script></head><body>Confirmado</body></html>',
      });

      // Esperar que la reserva aparezca en el panel de viajes.
      await esperarCondicion(
        async () => {
          const resp = await pedirJson<{ viajes: { reservas: { numeroReserva: string }[] }[] }>(
            `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
            { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
          );
          const resList = resp.datos?.viajes.flatMap((v) => v.reservas) ?? [];
          return resList.some((r) => r.numeroReserva === codigoVuelo) ? true : undefined;
        },
        25_000,
        1_000,
      );
    });

    afterAll(async () => {
      if (!sesion) return;
      await eliminarReservasUsuario(sesion);
      await desconectarCuentasCorreo(sesion);
      await reiniciarMock(CONFIG_E2E.urlMockAerolinea);
      await reiniciarMock(CONFIG_E2E.urlMockAgencia);
    });

    it('atiende estado, reprogramación confirmada, problemas menores y derivación a agencia', async () => {
      // 1. Abrir conversación con el asistente virtual.
      const respConv = await pedirJson<{ conversacionId: string }>(
        `${CONFIG_E2E.urlEnrutador}/api/asistente/conversaciones`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sesion.jwt}`,
            'X-Region': sesion.region,
          },
          body: JSON.stringify({ idioma: 'es' }),
        },
      );
      expect(respConv.status).toBe(201);
      const conversacionId = respConv.datos?.conversacionId ?? '';
      expect(conversacionId).toBeTruthy();

      interface RespuestaMensaje {
        estado: string;
        respuesta: {
          tipo: string;
          texto: string;
          reservas?: { numeroReserva: string }[];
          opciones?: { opcionId: string }[];
          casoId?: string;
        };
      }

      // 2. Consulta de ESTADO: ¿Cuál es el estado de mi vuelo XKQ7PL?
      const respEstado = await pedirJson<RespuestaMensaje>(
        `${CONFIG_E2E.urlEnrutador}/api/asistente/conversaciones/${conversacionId}/mensajes`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sesion.jwt}`,
            'X-Region': sesion.region,
          },
          body: JSON.stringify({ texto: `¿Cuál es el estado de mi vuelo ${codigoVuelo}?` }),
        },
      );
      expect(respEstado.status).toBe(200);
      expect(respEstado.datos?.respuesta.texto).toBeTruthy();
      const reservasVistas = respEstado.datos?.respuesta.reservas ?? [];
      expect(reservasVistas.some((r) => r.numeroReserva === codigoVuelo)).toBe(true);

      // 3. REPROGRAMACIÓN: pedir opciones y confirmar la elegida.
      const respOpciones = await pedirJson<RespuestaMensaje>(
        `${CONFIG_E2E.urlEnrutador}/api/asistente/conversaciones/${conversacionId}/mensajes`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sesion.jwt}`,
            'X-Region': sesion.region,
          },
          body: JSON.stringify({ texto: `Quiero cambiar mi vuelo ${codigoVuelo} para mañana` }),
        },
      );
      expect(respOpciones.status).toBe(200);
      const opciones = respOpciones.datos?.respuesta.opciones ?? [];
      expect(opciones.length).toBeGreaterThan(0);
      const opcionId = opciones[0]?.opcionId ?? '';
      expect(opcionId).toBeTruthy();

      // Confirmar la opción seleccionada.
      interface ConfirmacionRespuesta {
        estado: string;
        respuesta: {
          resultado: string;
          texto: string;
        };
      }
      const respConfirmacion = await pedirJson<ConfirmacionRespuesta>(
        `${CONFIG_E2E.urlEnrutador}/api/asistente/conversaciones/${conversacionId}/confirmaciones`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sesion.jwt}`,
            'X-Region': sesion.region,
          },
          body: JSON.stringify({ opcionId }),
        },
      );
      expect(respConfirmacion.status).toBe(200);
      expect(respConfirmacion.datos?.respuesta.resultado).toBe('reprogramado');

      // 4. PROBLEMA MENOR: pregunta frecuente sobre equipaje (se resuelve sin escalar).
      const respProblemaMenor = await pedirJson<RespuestaMensaje>(
        `${CONFIG_E2E.urlEnrutador}/api/asistente/conversaciones/${conversacionId}/mensajes`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sesion.jwt}`,
            'X-Region': sesion.region,
          },
          body: JSON.stringify({ texto: '¿Cuánto equipaje puedo llevar en mi vuelo?' }),
        },
      );
      expect(respProblemaMenor.status).toBe(200);
      expect(respProblemaMenor.datos?.respuesta.texto).toMatch(/equipaje/i);

      // 5. DERIVACIÓN POR CHAT: solicitar hablar con la agencia preferida.
      const respDerivacion = await pedirJson<RespuestaMensaje>(
        `${CONFIG_E2E.urlEnrutador}/api/asistente/conversaciones/${conversacionId}/mensajes`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sesion.jwt}`,
            'X-Region': sesion.region,
          },
          body: JSON.stringify({ texto: 'Quiero hablar con una persona de mi agencia' }),
        },
      );
      expect(respDerivacion.status).toBe(200);
      expect(respDerivacion.datos?.respuesta.texto).toMatch(/agencia|caso|ticket/i);

      // Verificar en mock-agencia que el caso derivado fue registrado.
      const respCasosAdmin = await pedirJson<{
        casos: { id: string | number; subject?: string; asunto?: string }[];
      }>(`${CONFIG_E2E.urlMockAgencia}/admin/casos`);
      expect(respCasosAdmin.status).toBe(200);
      const casosAgencia = respCasosAdmin.datos?.casos ?? [];
      expect(casosAgencia.length).toBeGreaterThan(0);
    });
  },
);
