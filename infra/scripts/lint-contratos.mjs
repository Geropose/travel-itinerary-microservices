// Valida con @redocly/cli cada contrato REST de specs/openapi/ (menos comun.yaml, que solo
// tiene componentes compartidos). Se usa en npm run test:contratos.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const carpeta = join('specs', 'openapi');
const contratos = readdirSync(carpeta)
  .filter((archivo) => archivo.endsWith('.yaml') && archivo !== 'comun.yaml')
  .map((archivo) => join(carpeta, archivo));

if (contratos.length === 0) {
  process.stdout.write('No hay contratos REST para validar.\n');
  process.exit(0);
}

const resultado = spawnSync('npx', ['redocly', 'lint', ...contratos], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(resultado.status ?? 1);
