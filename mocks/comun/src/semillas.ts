// Semillas de los mocks de correo: 20 buzones de prueba con los mismos nombres en Gmail y en Outlook
// (cambia el dominio). Las semillas de todo el sistema (P3.1) los conectan a usuarios de las dos
// regiones.
import type { Correo, Etiqueta } from './correo.ts';
import { crearAzar, generarCorreo, generarLote } from './generador.ts';

export const NOMBRES = [
  'Ana García',
  'Bruno Díaz',
  'Carla Méndez',
  'Diego Fernández',
  'Elena Torres',
  'Facundo Ruiz',
  'Gabriela Sosa',
  'Hernán López',
  'Inés Romero',
  'Javier Castro',
  'Karina Molina',
  'Lucas Herrera',
  'María Suárez',
  'Nicolás Acosta',
  'Olivia Benítez',
  'Pablo Ríos',
  'Rocío Medina',
  'Sofía Navarro',
  'Tomás Giménez',
  'Valentina Rojas',
] as const;

/** "Ana García" → "ana.garcia@<dominio>" (dominios .example, reservados para ejemplos, RFC 2606). */
export function emailDe(nombre: string, dominio: string): string {
  const sinTildes = nombre.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return `${sinTildes.toLowerCase().replace(/\s+/g, '.')}@${dominio}`;
}

export const buzonesDePrueba = (dominio: string) =>
  NOMBRES.map((nombre) => ({ nombre, email: emailDe(nombre, dominio) }));

/** Nombre del dueño de un buzón de prueba (o la parte de antes de la @). */
export function nombreDe(email: string, dominio: string): string {
  const buzon = buzonesDePrueba(dominio).find((b) => b.email === email.toLowerCase());
  return buzon?.nombre ?? email.split('@')[0] ?? email;
}

/**
 * Carga los 20 buzones. Cada uno tiene una reserva de vuelo, una de hotel y una de auto con marcado,
 * y 5 correos más al azar, todos de los últimos días. Con la misma fecha, siempre los mismos correos.
 */
export function cargarSemillas(
  dominio: string,
  agregar: (email: string, correo: Correo, etiqueta: Etiqueta) => void,
  ahora = new Date(),
) {
  buzonesDePrueba(dominio).forEach(({ nombre, email }, i) => {
    const azar = crearAzar(i + 1);
    const fijos = (['vuelo', 'hotel', 'auto'] as const).map((tipo, j) =>
      generarCorreo(azar, {
        tipo,
        para: email,
        nombre,
        fecha: new Date(ahora.getTime() - (3 - j) * 86_400_000),
      }),
    );
    const otros = generarLote({ cantidad: 5, para: email, nombre, semilla: 100 + i, hasta: ahora });
    for (const { correo, etiqueta } of [...fijos, ...otros]) agregar(email, correo, etiqueta);
  });
}
