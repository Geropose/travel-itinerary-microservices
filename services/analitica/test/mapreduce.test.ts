// Pruebas unitarias de división de particiones y fase Reduce de Map-Reduce (P2.C5, Iteración 6).
import { describe, expect, it } from 'vitest';
import {
  dividirEnBloques,
  reducirCancelaciones,
  reducirDestinos,
  reducirTendencias,
  type ParcialCancelaciones,
  type ParcialDestinos,
  type ParcialTendencias,
} from '../src/mapreduce.ts';

describe('dividirEnBloques (rangos alineados a particiones mensuales)', () => {
  it('corta el período respetando límites exactos de mes y año bisiesto', () => {
    const bloques = dividirEnBloques('2024-01-15', '2024-03-10', 1);
    expect(bloques).toEqual([
      { id: 0, desde: '2024-01-15', hasta: '2024-01-31' },
      { id: 1, desde: '2024-02-01', hasta: '2024-02-29' },
      { id: 2, desde: '2024-03-01', hasta: '2024-03-10' },
    ]);
  });

  it('subdivide meses en sub-rangos contiguos sin huecos ni solapamientos cuando se piden más procesadores que meses', () => {
    const bloques = dividirEnBloques('2025-01-01', '2025-01-31', 8);
    expect(bloques).toHaveLength(8);
    expect(bloques[0]?.desde).toBe('2025-01-01');
    expect(bloques[bloques.length - 1]?.hasta).toBe('2025-01-31');

    // Verificamos cobertura exacta de los 31 días sin huecos ni duplicados.
    let diasTotales = 0;
    for (let i = 0; i < bloques.length; i++) {
      const actual = bloques[i];
      if (!actual) continue;
      const dIni = Date.parse(`${actual.desde}T00:00:00Z`);
      const dFin = Date.parse(`${actual.hasta}T00:00:00Z`);
      expect(dFin).toBeGreaterThanOrEqual(dIni);
      diasTotales += (dFin - dIni) / 86_400_000 + 1;
      if (i > 0) {
        const previo = bloques[i - 1];
        if (!previo) continue;
        const dPrevFin = Date.parse(`${previo.hasta}T00:00:00Z`);
        expect(dIni - dPrevFin).toBe(86_400_000);
      }
    }
    expect(diasTotales).toBe(31);
  });

  it('genera 36 bloques mensuales para un histórico de 3 años completos', () => {
    const bloques = dividirEnBloques('2023-01-01', '2025-12-31', 8);
    expect(bloques).toHaveLength(36);
  });
});

describe('fase Reduce determinística (conmutativa y asociativa)', () => {
  const generadoEn = '2026-11-20T14:00:00.000Z';

  it('reducirDestinos devuelve el mismo resultado sin importar cómo se particionen o reordenen los bloques', () => {
    const p1: ParcialDestinos = {
      tipo: 'destinos',
      totalReservas: 10,
      porDestino: { SCL: 6, MAD: 4 },
    };
    const p2: ParcialDestinos = {
      tipo: 'destinos',
      totalReservas: 10,
      porDestino: { MAD: 6, BRC: 4 },
    };
    const unido: ParcialDestinos = {
      tipo: 'destinos',
      totalReservas: 20,
      porDestino: { SCL: 6, MAD: 10, BRC: 4 },
    };

    const rA = reducirDestinos([p1, p2], {
      desde: '2025-01-01',
      hasta: '2025-12-31',
      limite: 2,
      generadoEn,
    });
    const rB = reducirDestinos([p2, p1], {
      desde: '2025-01-01',
      hasta: '2025-12-31',
      limite: 2,
      generadoEn,
    });
    const rC = reducirDestinos([unido], {
      desde: '2025-01-01',
      hasta: '2025-12-31',
      limite: 2,
      generadoEn,
    });

    expect(rA).toEqual(rB);
    expect(rA).toEqual(rC);
    expect(rA.destinos).toEqual([
      { destino: 'MAD', reservas: 10, proporcion: 0.5 },
      { destino: 'SCL', reservas: 6, proporcion: 0.3 },
    ]);
  });

  it('reducirCancelaciones ordena de mayor a menor tasa de cancelación y maneja períodos vacíos', () => {
    const parciales: ParcialCancelaciones[] = [
      {
        tipo: 'cancelaciones',
        totalReservas: 100,
        totalCanceladas: 6,
        porClave: {
          'aerolinea-andina': { reservas: 50, canceladas: 3 },
          'rentadora-sur': { reservas: 50, canceladas: 3 },
        },
      },
      {
        tipo: 'cancelaciones',
        totalReservas: 100,
        totalCanceladas: 10,
        porClave: {
          'rentadora-sur': { reservas: 50, canceladas: 7 },
          'hotel-cordillera': { reservas: 50, canceladas: 3 },
        },
      },
    ];

    const res = reducirCancelaciones(parciales, {
      desde: '2025-01-01',
      hasta: '2025-12-31',
      agruparPor: 'proveedor',
      generadoEn,
    });
    expect(res.total).toEqual({ reservas: 200, canceladas: 16, tasaCancelacion: 0.08 });
    expect(res.grupos.map((g) => [g.clave, g.tasaCancelacion])).toEqual([
      ['rentadora-sur', 0.1],
      ['aerolinea-andina', 0.06],
      ['hotel-cordillera', 0.06],
    ]);

    const vacio = reducirCancelaciones([], {
      desde: '2025-01-01',
      hasta: '2025-01-31',
      agruparPor: 'destino',
      generadoEn,
    });
    expect(vacio.total).toEqual({ reservas: 0, canceladas: 0, tasaCancelacion: 0 });
    expect(vacio.grupos).toEqual([]);
  });

  it('reducirTendencias devuelve siempre los 12 meses del año incluyendo meses con cero', () => {
    const parciales: ParcialTendencias[] = [
      {
        tipo: 'tendencias',
        porMes: {
          1: { reservas: 10, canceladas: 1, vuelo: 5, hotel: 3, auto: 2 },
          12: { reservas: 4, canceladas: 0, vuelo: 2, hotel: 2, auto: 0 },
        },
      },
      {
        tipo: 'tendencias',
        porMes: {
          1: { reservas: 5, canceladas: 1, vuelo: 3, hotel: 1, auto: 1 },
        },
      },
    ];

    const res = reducirTendencias(parciales, { anio: 2025, generadoEn });
    expect(res.periodos).toHaveLength(12);
    expect(res.periodos[0]).toEqual({
      mes: 1,
      reservas: 15,
      canceladas: 2,
      porTipoReserva: { vuelo: 8, hotel: 4, auto: 3 },
    });
    expect(res.periodos[5]).toEqual({
      mes: 6,
      reservas: 0,
      canceladas: 0,
      porTipoReserva: { vuelo: 0, hotel: 0, auto: 0 },
    });
    expect(res.periodos[11]).toEqual({
      mes: 12,
      reservas: 4,
      canceladas: 0,
      porTipoReserva: { vuelo: 2, hotel: 2, auto: 0 },
    });
  });
});
