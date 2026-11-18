// Levanta con Prism un mock de un servicio a partir de su contrato, en el mismo puerto que el
// servicio real, para programar contra él antes de que esté terminado.
//
//   npm run mock -- <servicio>
//
// Prism responde con los ejemplos del contrato y valida las solicitudes (incluido el token). Antes se
// arma una copia del contrato con los $ref a comun.yaml resueltos y el servidor en "/" (igual que el
// servicio real, sin el prefijo /api/<servicio>).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargarSpec } from '@trotamundos/comun';

/** Puertos de docs/CONVENCIONES.md 4.2, por si el servicio todavía no tiene carpeta. */
const PUERTOS: Record<string, number> = {
  gateway: 3000,
  autenticacion: 3001,
  usuarios: 3002,
  correo: 3003,
  viajes: 3004,
  integraciones: 3005,
  analitica: 3006,
  asistente: 3007,
  monitor: 3010,
};

const raiz = fileURLToPath(new URL('../../', import.meta.url));
const servicio = process.argv[2] ?? '';
const spec = join(raiz, 'specs', 'openapi', `${servicio}.yaml`);
if (!servicio || !existsSync(spec)) {
  process.stderr.write(
    `No existe el contrato specs/openapi/${servicio}.yaml.\nUso: npm run mock -- <servicio>\n`,
  );
  process.exit(1);
}

const paquete = join(raiz, 'services', servicio, 'package.json');
const puerto = existsSync(paquete)
  ? (JSON.parse(readFileSync(paquete, 'utf8')) as { config?: { puerto?: number } }).config?.puerto
  : PUERTOS[servicio];
if (!puerto) {
  process.stderr.write(`No sé el puerto de ${servicio}: agregalo en infra/scripts/mock.ts.\n`);
  process.exit(1);
}

const armado = join(mkdtempSync(join(tmpdir(), 'mock-')), `${servicio}.json`);
writeFileSync(armado, JSON.stringify(cargarSpec(spec).documento));

const requerir = createRequire(import.meta.url);
const paquetePrism = requerir.resolve('@stoplight/prism-cli/package.json');
const binario = (JSON.parse(readFileSync(paquetePrism, 'utf8')) as { bin: { prism: string } }).bin
  .prism;
process.stdout.write(
  `Mock de ${servicio} en http://localhost:${puerto} (contrato ${servicio}.yaml)\n`,
);
const prism = spawn(
  process.execPath,
  [
    join(dirname(paquetePrism), binario),
    'mock',
    '--host',
    '0.0.0.0',
    '--port',
    String(puerto),
    armado,
  ],
  { stdio: 'inherit' },
);
prism.on('exit', (codigo) => process.exit(codigo ?? 0));
