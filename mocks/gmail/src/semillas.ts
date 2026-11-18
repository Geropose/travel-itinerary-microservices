// Semillas: 20 buzones de prueba con correos de reserva y de otro tipo. Las semillas de todo el
// sistema (P3.1) conectan estos buzones a usuarios de las dos regiones.
import type { Almacen } from './buzones.ts';
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

/** "Ana García" → "ana.garcia@gmail.example" (dominio reservado para ejemplos, RFC 2606). */
export function emailDe(nombre: string): string {
  const sinTildes = nombre.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return `${sinTildes.toLowerCase().replace(/\s+/g, '.')}@gmail.example`;
}

export const BUZONES_PRUEBA = NOMBRES.map((nombre) => ({ nombre, email: emailDe(nombre) }));

/**
 * Carga los 20 buzones. Cada uno tiene una reserva de vuelo, una de hotel y una de auto con marcado,
 * y 5 correos más al azar, todos de los últimos días. Con la misma fecha, siempre los mismos correos.
 */
export function cargarSemillas(almacen: Almacen, ahora = new Date()) {
  BUZONES_PRUEBA.forEach(({ nombre, email }, i) => {
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
    for (const { correo, etiqueta } of [...fijos, ...otros])
      almacen.agregar(email, correo, etiqueta);
  });
}
