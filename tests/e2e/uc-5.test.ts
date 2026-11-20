// Caso de Uso 5 (UC-5, Iteración 2): Ciclo de vida del viaje.
// Los elementos del panel deben poder agruparse por viaje y, una vez que el viaje se completa
// (fecha fin transcurrida), debe archivarse y quedar fuera del panel principal (GET /panel),
// siendo accesible únicamente a través de la vista de archivados (GET /archivados).
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

describe.skipIf(!haySistema)('UC-5: Ciclo de vida del viaje (archivado automático)', () => {
  let sesion: SesionE2E;
  const codigoReserva = `UC5-PAST-${idAleatorio()}`;

  beforeAll(async () => {
    sesion = await registrarYLogin({ nombre: 'Viajero UC5' });
  });

  afterAll(async () => {
    if (!sesion) return;
    await eliminarReservasUsuario(sesion);
  });

  it('un viaje terminado se archiva y queda fuera de la vista principal del panel', async () => {
    // 1. Dar de alta una reserva cuyo viaje ya terminó (fechas en el pasado: 2024).
    const alta = await pedirJson<{
      reservaId: string;
      viajeId: string;
      numeroReserva: string;
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
        inicio: '2024-03-10T08:00:00Z',
        fin: '2024-03-10T10:30:00Z',
        origen: 'Buenos Aires (EZE)',
        destino: 'Santiago (SCL)',
        detalle: { numeroVuelo: 'AN 1000' },
      }),
    });
    expect(alta.status).toBe(201);
    const viajeId = alta.datos?.viajeId ?? '';
    expect(viajeId).toBeTruthy();

    // 2. Comprobar que el viaje terminado aparece en /archivados.
    interface ViajeArchivado {
      viajeId: string;
      estado: string;
      reservas: { numeroReserva: string }[];
    }
    interface ListaArchivados {
      viajes: ViajeArchivado[];
    }
    interface ListaPanel {
      viajes: { viajeId: string }[];
    }

    // El requerimiento UC-5 exige: viaje terminado → archivado y fuera del panel.
    const archivados = await esperarCondicion<ListaArchivados>(
      async () => {
        const resp = await pedirJson<ListaArchivados>(
          `${CONFIG_E2E.urlEnrutador}/api/viajes/archivados`,
          { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
        );
        if (resp.status !== 200 || !resp.datos) return undefined;
        const encontrado = resp.datos.viajes.some((v) => v.viajeId === viajeId);
        return encontrado ? resp.datos : undefined;
      },
      15_000,
      1_000,
    );

    const viajeArchivado = archivados.viajes.find((v) => v.viajeId === viajeId);
    expect(viajeArchivado).toBeDefined();
    expect(viajeArchivado?.estado).toBe('archivado');

    // 3. Comprobar que el viaje archivado NO aparece en el panel activo.
    const respPanel = await pedirJson<ListaPanel>(`${CONFIG_E2E.urlEnrutador}/api/viajes/panel`, {
      headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
    });
    expect(respPanel.status).toBe(200);
    const enPanel = (respPanel.datos?.viajes ?? []).some((v) => v.viajeId === viajeId);
    expect(enPanel).toBe(false);
  });
});
