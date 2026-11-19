// Pruebas unitarias de P2.C3: analizador cron de archivado nocturno y armado seguro del itinerario
// para publicación en redes sociales (sin números de reserva ni datos personales).
import { describe, expect, it } from 'vitest';
import { coincideCron, esCronValido, parsearCron } from '../src/archivado.ts';
import { armarItinerarioParaRed, type ViajeConReservas } from '../src/modelo.ts';

describe('cron de tarea de archivado (UTC)', () => {
  it('evalúa expresiones cron de 5 campos estándar', () => {
    const nocturno = parsearCron('0 3 * * *');
    expect(coincideCron(nocturno, new Date('2026-12-15T03:00:00Z'))).toBe(true);
    expect(coincideCron(nocturno, new Date('2026-12-15T03:01:00Z'))).toBe(false);
    expect(coincideCron(nocturno, new Date('2026-12-15T04:00:00Z'))).toBe(false);

    const pasosYRangos = parsearCron('*/15 2-4 * * 1-5');
    // 2026-12-15 es martes (día 2).
    expect(coincideCron(pasosYRangos, new Date('2026-12-15T02:30:00Z'))).toBe(true);
    expect(coincideCron(pasosYRangos, new Date('2026-12-15T04:45:00Z'))).toBe(true);
    expect(coincideCron(pasosYRangos, new Date('2026-12-15T05:00:00Z'))).toBe(false);
    // 2026-12-13 es domingo (día 0).
    expect(coincideCron(pasosYRangos, new Date('2026-12-13T03:00:00Z'))).toBe(false);

    const domingoSiete = parsearCron('30 23 * * 7');
    expect(coincideCron(domingoSiete, new Date('2026-12-13T23:30:00Z'))).toBe(true);
  });

  it('rechaza expresiones cron inválidas', () => {
    expect(esCronValido('0 3 * * *')).toBe(true);
    expect(esCronValido('0 3 * *')).toBe(false);
    expect(esCronValido('60 3 * * *')).toBe(false);
    expect(esCronValido('0 25 * * *')).toBe(false);
    expect(esCronValido('*/0 * * * *')).toBe(false);
    expect(esCronValido('no-es-cron')).toBe(false);
  });
});

describe('armarItinerarioParaRed (sin datos sensibles)', () => {
  it('excluye números de reserva, datos personales y reservas canceladas, y respeta el contrato de Integraciones', () => {
    const viaje: ViajeConReservas = {
      viajeId: '3f8a2c1e-7b4d-4e9a-8c6f-1a2b3c4d5e6f',
      usuarioId: '6b1e7c2a-4f3d-4e8b-9c0a-1d2e3f4a5b6c',
      nombre: 'Viaje a Santiago',
      destino: 'Santiago XKQ7PL',
      inicio: '2026-12-10T08:30:00Z',
      fin: '2026-12-14T11:00:00Z',
      estado: 'activo',
      reservas: [
        {
          reservaId: '11111111-1111-4111-8111-111111111111',
          viajeId: '3f8a2c1e-7b4d-4e9a-8c6f-1a2b3c4d5e6f',
          usuarioId: '6b1e7c2a-4f3d-4e8b-9c0a-1d2e3f4a5b6c',
          proveedor: 'aerolinea-andina',
          tipoReserva: 'vuelo',
          numeroReserva: 'XKQ7PL',
          inicio: '2026-12-10T08:30:00Z',
          fin: '2026-12-10T10:40:00Z',
          origen: 'Buenos Aires (EZE)',
          destino: 'Santiago (SCL)',
          estado: 'confirmada',
          detalle: { numeroVuelo: 'AN 1234 XKQ7PL', pasajero: 'Ana García' },
          origenCambio: 'correo',
          correoId: 'msg-privado-1',
          actualizadoEn: '2026-11-20T13:45:00Z',
        },
        {
          reservaId: '22222222-2222-4222-8222-222222222222',
          viajeId: '3f8a2c1e-7b4d-4e9a-8c6f-1a2b3c4d5e6f',
          usuarioId: '6b1e7c2a-4f3d-4e8b-9c0a-1d2e3f4a5b6c',
          proveedor: 'hotel-cordillera',
          tipoReserva: 'hotel',
          numeroReserva: 'HC-48213',
          inicio: '2026-12-10T15:00:00Z',
          fin: '2026-12-14T11:00:00Z',
          destino: 'Santiago',
          estado: 'confirmada',
          detalle: { nombreHotel: 'Hotel Cordillera', huesped: 'Ana García' },
          origenCambio: 'manual',
          actualizadoEn: '2026-11-21T10:00:00Z',
        },
        {
          reservaId: '33333333-3333-4333-8333-333333333333',
          viajeId: '3f8a2c1e-7b4d-4e9a-8c6f-1a2b3c4d5e6f',
          usuarioId: '6b1e7c2a-4f3d-4e8b-9c0a-1d2e3f4a5b6c',
          proveedor: 'rentadora-sur',
          tipoReserva: 'auto',
          numeroReserva: 'RS-CANCEL-99',
          inicio: '2026-12-11T09:00:00Z',
          fin: '2026-12-12T18:00:00Z',
          origen: 'SCL',
          destino: 'SCL',
          estado: 'cancelada',
          detalle: { modelo: 'Compacto' },
          origenCambio: 'proveedor',
          actualizadoEn: '2026-11-22T10:00:00Z',
        },
      ],
    };

    const itinerario = armarItinerarioParaRed(viaje);
    const serializado = JSON.stringify(itinerario);

    expect(itinerario.destino).toBe('Santiago');
    expect(itinerario.reservas).toHaveLength(2);
    expect(itinerario.reservas[0]).toEqual({
      tipoReserva: 'vuelo',
      descripcion: 'Vuelo AN 1234',
      inicio: '2026-12-10T08:30:00Z',
      fin: '2026-12-10T10:40:00Z',
      origen: 'Buenos Aires (EZE)',
      destino: 'Santiago (SCL)',
    });
    expect(itinerario.reservas[1]).toEqual({
      tipoReserva: 'hotel',
      descripcion: 'Hotel Cordillera',
      inicio: '2026-12-10T15:00:00Z',
      fin: '2026-12-14T11:00:00Z',
    });

    // Ningún dato sensible ni identificador interno puede filtrarse.
    expect(serializado).not.toContain('XKQ7PL');
    expect(serializado).not.toContain('HC-48213');
    expect(serializado).not.toContain('RS-CANCEL-99');
    expect(serializado).not.toContain(viaje.usuarioId);
    expect(serializado).not.toContain('Ana García');
    expect(serializado).not.toContain('msg-privado-1');
    expect(serializado).not.toContain('numeroReserva');
  });
});
