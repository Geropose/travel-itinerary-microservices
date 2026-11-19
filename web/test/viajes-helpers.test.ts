import { describe, expect, it } from 'vitest';
import {
  construirDetalleReserva,
  leerDetalleReserva,
  ordenarReservas,
  type Reserva,
} from '../src/pantallas/viajes-componentes.tsx';

function reservaBase(parcial: Partial<Reserva>): Reserva {
  return {
    reservaId: '11111111-1111-4111-8111-111111111111',
    viajeId: '22222222-2222-4222-8222-222222222222',
    proveedor: 'aerolinea-andina',
    tipoReserva: 'vuelo',
    numeroReserva: 'AA1111',
    inicio: '2026-12-10T10:00:00Z',
    fin: '2026-12-10T12:00:00Z',
    origen: 'EZE',
    destino: 'SCL',
    estado: 'confirmada',
    detalle: {} as Record<string, never>,
    origenCambio: 'correo',
    actualizadoEn: '2026-11-18T12:00:00Z',
    ...parcial,
  };
}

describe('helpers de viajes y reservas', () => {
  it('ordena las reservas de un viaje cronológicamente por inicio sin mutar el arreglo original', () => {
    const tarde = reservaBase({
      reservaId: '33333333-3333-4333-8333-333333333333',
      numeroReserva: 'TARDE',
      inicio: '2026-12-12T15:00:00Z',
      fin: '2026-12-12T17:00:00Z',
    });
    const temprano = reservaBase({
      reservaId: '44444444-4444-4444-8444-444444444444',
      numeroReserva: 'TEMPRANO',
      inicio: '2026-12-10T08:00:00Z',
      fin: '2026-12-10T10:00:00Z',
    });
    const medio = reservaBase({
      reservaId: '55555555-5555-4555-8555-555555555555',
      numeroReserva: 'MEDIO',
      inicio: '2026-12-10T14:00:00Z',
      fin: '2026-12-12T11:00:00Z',
    });

    const entrada = [tarde, temprano, medio];
    const ordenadas = ordenarReservas(entrada);
    expect(ordenadas.map((r) => r.numeroReserva)).toEqual(['TEMPRANO', 'MEDIO', 'TARDE']);
    expect(entrada.map((r) => r.numeroReserva)).toEqual(['TARDE', 'TEMPRANO', 'MEDIO']);
  });

  it('lee precio, moneda y detalles conocidos de una reserva', () => {
    expect(
      leerDetalleReserva({
        precio: 1234.5,
        moneda: 'usd',
        numeroVuelo: 'AN 1234',
        asiento: '14C',
        notas: 'Ventanilla',
      }),
    ).toEqual({
      precio: 1234.5,
      moneda: 'USD',
      numeroVuelo: 'AN 1234',
      asiento: '14C',
      notas: 'Ventanilla',
    });

    expect(leerDetalleReserva({ monto: 500, moneda: 'invalida' })).toEqual({ precio: 500 });
    expect(leerDetalleReserva({ precio: -10 })).toEqual({});
    expect(leerDetalleReserva(null)).toEqual({});
  });

  it('construye detalle preservando campos previos del correo y quitando campos vacíos', () => {
    const actualizado = construirDetalleReserva({
      precio: '890,50',
      moneda: 'eur',
      notas: '  Check-in temprano ',
      base: { numeroVuelo: 'AN 1234', asiento: '14C' },
    });
    expect(actualizado).toEqual({
      numeroVuelo: 'AN 1234',
      asiento: '14C',
      precio: 890.5,
      moneda: 'EUR',
      notas: 'Check-in temprano',
    });

    const limpio = construirDetalleReserva({
      precio: '',
      moneda: '',
      notas: '',
      base: actualizado,
    });
    expect(limpio).toEqual({
      numeroVuelo: 'AN 1234',
      asiento: '14C',
    });
  });
});
