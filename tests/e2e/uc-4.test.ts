// Caso de Uso 4 (UC-4, Iteración 4): Gestión manual de reservas.
// Alta, edición y baja manual de reservas desde el panel del usuario (ADR-004, CQRS liviano).
// Las escrituras impactan en la base principal de la región, invalidan la cache de Redis
// y se leen de forma consistente en el panel.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONFIG_E2E,
  eliminarReservasUsuario,
  esperarCondicion,
  idAleatorio,
  pedirJson,
  registrarYLogin,
  sistemaDisponible,
  type SesionE2E,
} from './comun.ts';

const haySistema = await sistemaDisponible();

describe.skipIf(!haySistema)('UC-4: Gestión manual de reservas (alta, edición y baja)', () => {
  let sesion: SesionE2E;
  const codigoReserva = `UC4-MAN-${idAleatorio()}`;

  beforeAll(async () => {
    sesion = await registrarYLogin({ nombre: 'Viajero UC4' });
  });

  afterAll(async () => {
    if (!sesion) return;
    await eliminarReservasUsuario(sesion);
  });

  it(
    'permite dar de alta, editar y eliminar una reserva a mano reflejando los cambios en el panel',
    async () => {
    // 1. Alta manual: POST /api/viajes/reservas
    const alta = await pedirJson<{
      reservaId: string;
      viajeId: string;
      numeroReserva: string;
      estado: string;
      origenCambio: string;
    }>(`${CONFIG_E2E.urlEnrutador}/api/viajes/reservas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sesion.jwt}`,
        'X-Region': sesion.region,
      },
      body: JSON.stringify({
        proveedor: 'aerolinea-andina',
        tipoReserva: 'vuelo',
        numeroReserva: codigoReserva,
        inicio: '2026-12-18T10:00:00Z',
        fin: '2026-12-18T12:30:00Z',
        origen: 'Buenos Aires (EZE)',
        destino: 'Santiago (SCL)',
        detalle: { numeroVuelo: 'AN 7788', asiento: '14A' },
      }),
    });
    expect(alta.status).toBe(201);
    expect(alta.datos?.numeroReserva).toBe(codigoReserva);
    const reservaId = alta.datos?.reservaId ?? '';
    expect(reservaId).toBeTruthy();

    // Verificar que aparece en el panel.
    interface ReservaPanel {
      reservaId: string;
      numeroReserva: string;
      estado: string;
      origen: string;
      detalle?: { asiento?: string };
    }
    interface PanelRespuesta {
      viajes: { destino: string; reservas: ReservaPanel[] }[];
    }

    const panelDespuesAlta = await esperarCondicion<PanelRespuesta>(
      async () => {
        const resp = await pedirJson<PanelRespuesta>(
          `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
          { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
        );
        const resList = resp.datos?.viajes.flatMap((v) => v.reservas) ?? [];
        return resList.some((r) => r.reservaId === reservaId) ? resp.datos : undefined;
      },
      10_000,
      500,
    );
    const reservaEnPanel = panelDespuesAlta.viajes
      .flatMap((v) => v.reservas)
      .find((r) => r.reservaId === reservaId);
    expect(reservaEnPanel?.numeroReserva).toBe(codigoReserva);
    expect(reservaEnPanel?.estado).toBe('confirmada');

    // 2. Edición manual: PATCH /api/viajes/reservas/:reservaId
    const edicion = await pedirJson<{
      reservaId: string;
      origen: string;
      detalle?: { asiento?: string };
      estado: string;
    }>(`${CONFIG_E2E.urlEnrutador}/api/viajes/reservas/${reservaId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sesion.jwt}`,
        'X-Region': sesion.region,
      },
      body: JSON.stringify({
        origen: 'Buenos Aires (AEP)',
        detalle: { asiento: '18C' },
      }),
    });
    expect(edicion.status).toBe(200);

    // Verificar cambio reflejado en el panel.
    const panelDespuesEdicion = await esperarCondicion<PanelRespuesta>(
      async () => {
        const resp = await pedirJson<PanelRespuesta>(
          `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
          { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
        );
        const resList = resp.datos?.viajes.flatMap((v) => v.reservas) ?? [];
        const r = resList.find((x) => x.reservaId === reservaId);
        return r?.origen === 'Buenos Aires (AEP)' ? resp.datos : undefined;
      },
      10_000,
      500,
    );
    const reservaEditada = panelDespuesEdicion.viajes
      .flatMap((v) => v.reservas)
      .find((r) => r.reservaId === reservaId);
    expect(reservaEditada?.origen).toBe('Buenos Aires (AEP)');
    expect(reservaEditada?.detalle?.asiento).toBe('18C');
    expect(reservaEditada?.estado).toBe('modificada');

    // 3. Baja manual: DELETE /api/viajes/reservas/:reservaId
    const baja = await fetch(`${CONFIG_E2E.urlEnrutador}/api/viajes/reservas/${reservaId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
    });
    expect(baja.status).toBe(204);

    // Verificar que ya no está activa en el panel.
    await esperarCondicion(
      async () => {
        const resp = await pedirJson<PanelRespuesta>(
          `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
          { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
        );
        const resList = resp.datos?.viajes.flatMap((v) => v.reservas) ?? [];
        const existe = resList.some((r) => r.reservaId === reservaId);
        return !existe ? true : undefined;
      },
      10_000,
      500,
    );
  });
});
