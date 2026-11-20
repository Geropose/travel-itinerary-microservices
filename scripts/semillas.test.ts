// Pruebas unitarias del plan de semillas (P3.1, sin Docker).
import { describe, expect, it } from 'vitest';
import {
  correoCanonicoHotel,
  correoCanonicoVuelo,
  planUsuariosSemilla,
  REMITENTES_PROVEEDORES,
} from './semillas.ts';

describe('planUsuariosSemilla (P3.1)', () => {
  it('genera 10 usuarios en region-1 y 10 en region-2 con correos Gmail y Outlook alternados', () => {
    const usuarios = planUsuariosSemilla();
    expect(usuarios).toHaveLength(20);

    const r1 = usuarios.filter((u) => u.region === 'region-1');
    const r2 = usuarios.filter((u) => u.region === 'region-2');
    expect(r1).toHaveLength(10);
    expect(r2).toHaveLength(10);

    expect(usuarios.filter((u) => u.proveedorCorreo === 'gmail')).toHaveLength(10);
    expect(usuarios.filter((u) => u.proveedorCorreo === 'outlook')).toHaveLength(10);

    // Emails únicos de cuenta y de buzón.
    expect(new Set(usuarios.map((u) => u.email)).size).toBe(20);
    expect(new Set(usuarios.map((u) => u.emailBuzon)).size).toBe(20);
  });

  it('incluye variedad de idiomas (es/en), whitelists y designados dentro de la misma región (CONST-6)', () => {
    const usuarios = planUsuariosSemilla();
    const porEmail = new Map(usuarios.map((u) => [u.email, u]));

    expect(usuarios.some((u) => u.idioma === 'en' && u.region === 'region-1')).toBe(true);
    expect(usuarios.some((u) => u.idioma === 'en' && u.region === 'region-2')).toBe(true);

    const conWhitelistActiva = usuarios.filter((u) => u.whitelist?.filtrosActivos === true);
    expect(conWhitelistActiva.length).toBeGreaterThanOrEqual(2);
    for (const u of conWhitelistActiva) {
      expect(u.whitelist?.remitentesPermitidos).toEqual([...REMITENTES_PROVEEDORES]);
    }

    const conDesignado = usuarios.filter((u) => u.designadoEmail);
    expect(conDesignado.length).toBeGreaterThanOrEqual(2);
    for (const dueno of conDesignado) {
      const designado = porEmail.get(dueno.designadoEmail ?? '');
      expect(designado).toBeDefined();
      expect(designado?.region).toBe(dueno.region);
    }
  });

  it('arma correos canónicos con marcado JSON-LD coherentes con mocks/aerolinea y mocks/hotel', () => {
    const vuelo = correoCanonicoVuelo('ana.garcia@gmail.example', 'Ana García');
    expect(vuelo.html).toContain('FlightReservation');
    expect(vuelo.html).toContain('XKQ7PL');
    expect(vuelo.de).toContain('reservas@aerolinea-andina.example');

    const hotel = correoCanonicoHotel('ana.garcia@gmail.example', 'Ana García');
    expect(hotel.html).toContain('LodgingReservation');
    expect(hotel.html).toContain('HC-48291');
    expect(hotel.de).toContain('reservas@hotel-cordillera.example');
  });
});
