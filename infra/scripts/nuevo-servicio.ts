// Genera services/<nombre> a partir de infra/plantilla-servicio.
//
//   npm run nuevo-servicio -- <nombre> <puerto> [--sin-dependencias]
//
// El contrato specs/openapi/<nombre>.yaml tiene que existir antes (spec-driven). Con
// --sin-dependencias el servicio no usa base, broker ni JWT (por ejemplo, el monitor de salud).
// Después de generar, correr `npm install` para que el servicio quede enlazado al kit común.
import { fileURLToPath } from 'node:url';
import { generarServicio } from './plantilla.ts';

const argumentos = process.argv.slice(2);
const [nombre = '', puerto = ''] = argumentos.filter((a) => !a.startsWith('--'));
const conDependencias = !argumentos.includes('--sin-dependencias');

try {
  generarServicio({
    raiz: fileURLToPath(new URL('../../', import.meta.url)),
    nombre,
    puerto: Number(puerto),
    conDependencias,
  });
  process.stdout.write(
    `Listo: services/${nombre} (puerto ${puerto}${conDependencias ? '' : ', sin dependencias'}).\n` +
      'Siguiente paso: npm install (enlaza el servicio con el kit común).\n',
  );
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.stderr.write('Uso: npm run nuevo-servicio -- <nombre> <puerto> [--sin-dependencias]\n');
  process.exit(1);
}
