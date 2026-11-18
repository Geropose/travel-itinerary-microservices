// Semillas y remitentes compartidos por los mocks de correo.
import { describe, expect, it } from 'vitest';
import type { Correo, Etiqueta } from '../src/correo.ts';
import { remitente } from '../src/correo.ts';
import { buzonesDePrueba, cargarSemillas, emailDe, nombreDe } from '../src/semillas.ts';

describe('remitente', () => {
  it('separa nombre y dirección del header From', () => {
    expect(remitente('Aerolínea Andina <Reservas@Aerolinea-Andina.example>')).toEqual({
      nombre: 'Aerolínea Andina',
      direccion: 'reservas@aerolinea-andina.example',
    });
    expect(remitente('"Pablo Ríos" <pablo@correo.example>').nombre).toBe('Pablo Ríos');
    expect(remitente('solo@correo.example')).toEqual({
      nombre: 'solo@correo.example',
      direccion: 'solo@correo.example',
    });
  });
});

describe('semillas', () => {
  it('20 buzones con el dominio de cada mock, sin tildes', () => {
    expect(emailDe('Hernán López', 'outlook.example')).toBe('hernan.lopez@outlook.example');
    expect(buzonesDePrueba('gmail.example')).toHaveLength(20);
    expect(nombreDe('ines.romero@gmail.example', 'gmail.example')).toBe('Inés Romero');
    expect(nombreDe('otro@gmail.example', 'gmail.example')).toBe('otro');
  });

  it('8 correos por buzón, los 3 primeros reservas con marcado; con la misma fecha, iguales', () => {
    const cargar = () => {
      const correos: { email: string; correo: Correo; etiqueta: Etiqueta }[] = [];
      cargarSemillas(
        'outlook.example',
        (email, correo, etiqueta) => correos.push({ email, correo, etiqueta }),
        new Date('2026-11-28T12:00:00Z'),
      );
      return correos;
    };
    const correos = cargar();
    expect(correos).toHaveLength(160);
    const deAna = correos.filter((c) => c.email === 'ana.garcia@outlook.example');
    expect(deAna.slice(0, 3).map((c) => c.etiqueta.tipo)).toEqual(['vuelo', 'hotel', 'auto']);
    expect(cargar()).toEqual(correos);
  });
});
