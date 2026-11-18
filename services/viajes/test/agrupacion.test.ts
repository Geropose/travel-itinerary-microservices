import { describe, expect, it } from 'vitest';
import {
  buscarViajeParaAgrupar,
  buscarViajesParaAgrupar,
  calcularResumenViaje,
  distanciaEntreRangosMs,
  MARGEN_AGRUPACION_MS_DEFECTO,
  type RangoViajeCandidato,
} from '../src/agrupacion.ts';

describe('agrupación de reservas por fechas (UC-5)', () => {
  const viajeSantiago: RangoViajeCandidato = {
    viajeId: '11111111-1111-4111-8111-111111111111',
    inicio: '2026-12-10T08:00:00Z',
    fin: '2026-12-14T11:00:00Z',
    estado: 'activo',
  };

  it('calcula distancia 0 cuando los rangos se superponen o se tocan', () => {
    const a = Date.parse('2026-12-10T08:00:00Z');
    const b = Date.parse('2026-12-14T11:00:00Z');
    expect(
      distanciaEntreRangosMs(
        a,
        b,
        Date.parse('2026-12-12T10:00:00Z'),
        Date.parse('2026-12-15T10:00:00Z'),
      ),
    ).toBe(0);
    expect(distanciaEntreRangosMs(a, b, b, Date.parse('2026-12-15T10:00:00Z'))).toBe(0);
  });

  it('agrupa cuando se superpone o está a menos de 2 días antes o después', () => {
    // Superpuesto (hotel durante el viaje)
    expect(
      buscarViajeParaAgrupar([viajeSantiago], '2026-12-10T15:00:00Z', '2026-12-14T11:00:00Z')
        ?.viajeId,
    ).toBe(viajeSantiago.viajeId);

    // 47 h después del fin -> entra en el mismo viaje
    expect(
      buscarViajeParaAgrupar([viajeSantiago], '2026-12-16T10:00:00Z', '2026-12-16T12:00:00Z')
        ?.viajeId,
    ).toBe(viajeSantiago.viajeId);

    // 47 h antes del inicio -> entra en el mismo viaje
    expect(
      buscarViajeParaAgrupar([viajeSantiago], '2026-12-08T07:00:00Z', '2026-12-08T09:00:00Z')
        ?.viajeId,
    ).toBe(viajeSantiago.viajeId);
  });

  it('crea un viaje nuevo cuando la distancia es de 2 días o más', () => {
    // Exactamente 48 h después -> no es "menos de 2 días"
    expect(
      buscarViajeParaAgrupar(
        [viajeSantiago],
        '2026-12-16T11:00:00Z',
        '2026-12-18T11:00:00Z',
        MARGEN_AGRUPACION_MS_DEFECTO,
      ),
    ).toBeNull();

    // 5 días antes
    expect(
      buscarViajeParaAgrupar([viajeSantiago], '2026-12-01T10:00:00Z', '2026-12-04T10:00:00Z'),
    ).toBeNull();
  });

  it('ignora viajes archivados y elige el viaje activo más cercano si hay varios', () => {
    const archivado: RangoViajeCandidato = {
      ...viajeSantiago,
      viajeId: '22222222-2222-4222-8222-222222222222',
      estado: 'archivado',
    };
    expect(
      buscarViajeParaAgrupar([archivado], '2026-12-11T10:00:00Z', '2026-12-12T10:00:00Z'),
    ).toBeNull();

    const viajeA: RangoViajeCandidato = {
      viajeId: 'aaaa1111-1111-4111-8111-111111111111',
      inicio: '2026-12-01T10:00:00Z',
      fin: '2026-12-03T10:00:00Z',
      estado: 'activo',
    };
    const viajeB: RangoViajeCandidato = {
      viajeId: 'bbbb2222-2222-4222-8222-222222222222',
      inicio: '2026-12-06T10:00:00Z',
      fin: '2026-12-08T10:00:00Z',
      estado: 'activo',
    };
    // A 36 h de viajeA y 12 h de viajeB -> elige viajeB y devuelve ambos candidatos puenteados
    expect(
      buscarViajeParaAgrupar([viajeA, viajeB], '2026-12-05T00:00:00Z', '2026-12-05T22:00:00Z')
        ?.viajeId,
    ).toBe(viajeB.viajeId);
    expect(
      buscarViajesParaAgrupar([viajeA, viajeB], '2026-12-05T00:00:00Z', '2026-12-05T22:00:00Z').map(
        (v) => v.viajeId,
      ),
    ).toEqual([viajeB.viajeId, viajeA.viajeId]);
  });

  it('calcula inicio, fin, destino principal (priorizando hotel o vuelo de ida) y nombre', () => {
    const resumen = calcularResumenViaje([
      {
        tipoReserva: 'vuelo',
        destino: 'Buenos Aires (EZE)',
        inicio: '2026-12-14T18:00:00Z',
        fin: '2026-12-14T20:15:00Z',
        estado: 'confirmada',
      },
      {
        tipoReserva: 'vuelo',
        destino: 'Santiago (SCL)',
        inicio: '2026-12-10T08:30:00Z',
        fin: '2026-12-10T10:45:00Z',
        estado: 'confirmada',
      },
      {
        tipoReserva: 'hotel',
        destino: 'Santiago',
        inicio: '2026-12-10T15:00:00Z',
        fin: '2026-12-14T11:00:00Z',
        estado: 'confirmada',
      },
    ]);

    expect(resumen).toEqual({
      inicio: '2026-12-10T08:30:00.000Z',
      fin: '2026-12-14T20:15:00.000Z',
      destino: 'Santiago',
      nombre: 'Viaje a Santiago',
    });

    // Si el hotel está cancelado, toma la primera reserva vigente (vuelo de ida).
    const soloVuelos = calcularResumenViaje([
      {
        tipoReserva: 'vuelo',
        destino: 'Santiago (SCL)',
        inicio: '2026-12-10T08:30:00Z',
        fin: '2026-12-10T10:45:00Z',
        estado: 'confirmada',
      },
      {
        tipoReserva: 'hotel',
        destino: 'Hotel Cancelado',
        inicio: '2026-12-10T15:00:00Z',
        fin: '2026-12-14T11:00:00Z',
        estado: 'cancelada',
      },
    ]);
    expect(soloVuelos.destino).toBe('Santiago (SCL)');
  });
});
