// Genera los secretos de desarrollo en .env a partir de .env.example: claves RSA del JWT de cada
// región, clave AES de los tokens de correo, SECRETO_ANALITICA y las contraseñas de bases y broker.
//
//   npm run infra:secretos                 completa las variables que falten (no cambia las demás)
//   npm run infra:secretos -- --regenerar  genera todo de nuevo (después: npm run infra:reset)
//
// El .env no se sube al repositorio (.gitignore).
import { fileURLToPath } from 'node:url';
import { escribirSecretos } from './entorno.ts';

const raiz = fileURLToPath(new URL('../../', import.meta.url));
const regenerar = process.argv.includes('--regenerar');
const { generadas } = escribirSecretos(raiz, regenerar);

if (generadas.length === 0) {
  process.stdout.write('.env ya tiene todas las variables de .env.example: no se cambió nada.\n');
} else {
  process.stdout.write(`.env: ${generadas.length} secretos generados (${generadas.join(', ')}).\n`);
  if (regenerar) {
    process.stdout.write(
      'Las bases guardan las contraseñas anteriores: corré npm run infra:reset antes de levantar.\n',
    );
  }
}
