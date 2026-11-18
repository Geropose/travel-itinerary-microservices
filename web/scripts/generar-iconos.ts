// Genera los íconos PNG de la PWA (web/public/icono-192.png e icono-512.png): fondo verde azulado
// con un círculo blanco, el mismo dibujo que icono.svg. Solo usa Node: node web/scripts/generar-iconos.ts
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const FONDO = [0x0f, 0x76, 0x6e];
const FRENTE = [0xff, 0xff, 0xff];

function bloque(tipo: string, datos: Buffer): Buffer {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);
  const conTipo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const control = Buffer.alloc(4);
  control.writeUInt32BE(crc32(conTipo));
  return Buffer.concat([largo, conTipo, control]);
}

export function png(lado: number): Buffer {
  const cabecera = Buffer.alloc(13);
  cabecera.writeUInt32BE(lado, 0);
  cabecera.writeUInt32BE(lado, 4);
  cabecera.writeUInt8(8, 8); // 8 bits por canal
  cabecera.writeUInt8(2, 9); // RGB
  const filas = Buffer.alloc(lado * (1 + lado * 3));
  const centro = lado / 2;
  const radio = lado * 0.28;
  for (let y = 0; y < lado; y++) {
    const inicio = y * (1 + lado * 3);
    filas[inicio] = 0; // sin filtro
    for (let x = 0; x < lado; x++) {
      const dentro = (x + 0.5 - centro) ** 2 + (y + 0.5 - centro) ** 2 <= radio ** 2;
      const color = dentro ? FRENTE : FONDO;
      filas.set(color, inicio + 1 + x * 3);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloque('IHDR', cabecera),
    bloque('IDAT', deflateSync(filas)),
    bloque('IEND', Buffer.alloc(0)),
  ]);
}

for (const lado of [192, 512]) {
  writeFileSync(new URL(`../public/icono-${lado}.png`, import.meta.url), png(lado));
}
