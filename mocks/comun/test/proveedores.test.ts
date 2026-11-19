// Coherencia entre las semillas de los mocks de correo y las semillas de proveedores (P2.D1),
// además de helpers de control de fallas y validación de fechas.
import { describe, expect, it } from 'vitest';
import type { Etiqueta } from '../src/correo.ts';
import { compararSeguro, esFechaIsoValida, leerBearer } from '../src/fallas.ts';
import { cargarSemillas } from '../src/semillas.ts';
import { cargarSemillasProveedores } from '../src/semillas-proveedores.ts';

describe('semillas coherentes entre correo y proveedores', () => {
  it('cada reserva de vuelo, hotel y auto de los 20 buzones existe en las semillas de proveedores', () => {
    const fecha = new Date('2026-11-28T12:00:00Z');
    const etiquetas: Etiqueta[] = [];
    cargarSemillas('gmail.example', (_email, _correo, etiqueta) => etiquetas.push(etiqueta), fecha);

    const proveedores = cargarSemillasProveedores(fecha);
    const refsVuelo = new Set(proveedores.vuelos.map((v) => v.bookingReference));
    const refsHotel = new Set(proveedores.hoteles.map((h) => h.reservationId));
    const refsAuto = new Set(proveedores.autos.map((a) => a.confirmationNumber));

    // Incluye además las 3 reservas de ejemplo documentadas en specs/externos/*.md.
    expect(refsVuelo.has('XKQ7PL')).toBe(true);
    expect(refsHotel.has('HC-48213')).toBe(true);
    expect(refsAuto.has('RS-77120')).toBe(true);

    const reservasCorreo = etiquetas.filter((e) => e.reserva !== undefined);
    expect(reservasCorreo.length).toBeGreaterThanOrEqual(60);

    for (const e of reservasCorreo) {
      if (!e.reserva) continue;
      if (e.reserva.tipoReserva === 'vuelo') {
        expect(refsVuelo.has(e.reserva.numeroReserva)).toBe(true);
      } else if (e.reserva.tipoReserva === 'hotel') {
        expect(refsHotel.has(e.reserva.numeroReserva)).toBe(true);
      } else {
        expect(refsAuto.has(e.reserva.numeroReserva)).toBe(true);
      }
    }
  });
});

describe('utilidades de autenticación y fechas', () => {
  it('valida Bearer, comparación segura y fechas ISO 8601', () => {
    expect(leerBearer('Bearer mi-clave')).toBe('mi-clave');
    expect(leerBearer('Basic abc')).toBeUndefined();
    expect(leerBearer(undefined)).toBeUndefined();
    expect(compararSeguro('secreto-1', 'secreto-1')).toBe(true);
    expect(compararSeguro('secreto-1', 'secreto-2')).toBe(false);
    expect(esFechaIsoValida('2026-11-28T12:00:00Z')).toBe(true);
    expect(esFechaIsoValida('2026-11-28T12:00:00-03:00')).toBe(true);
    expect(esFechaIsoValida('2026-11-28')).toBe(false);
    expect(esFechaIsoValida('no-es-fecha')).toBe(false);
  });
});
