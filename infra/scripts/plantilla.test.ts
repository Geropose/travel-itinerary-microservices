import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { generarServicio, procesar } from './plantilla.ts';

const raiz = fileURLToPath(new URL('../../', import.meta.url));

/** Copia un archivo o una carpeta (cpSync recursivo se cae en Windows con rutas con ñ). */
function copiar(origen: string, destino: string): void {
  if (statSync(origen).isDirectory()) {
    for (const nombre of readdirSync(origen)) copiar(join(origen, nombre), join(destino, nombre));
    return;
  }
  mkdirSync(dirname(destino), { recursive: true });
  copyFileSync(origen, destino);
}

const texto = [
  "const a = '__NOMBRE__';",
  '// dependencias:inicio',
  'const base = conectar(__PUERTO__);',
  '// dependencias:fin',
  'PUERTO=__PUERTO__',
  '# dependencias:inicio',
  'URL_BASE=postgres://x',
  '# dependencias:fin',
].join('\n');

describe('procesar', () => {
  it('con dependencias deja los bloques sin las líneas del marcador', () => {
    expect(procesar(texto, 'viajes', 3004, true)).toBe(
      [
        "const a = 'viajes';",
        'const base = conectar(3004);',
        'PUERTO=3004',
        'URL_BASE=postgres://x',
      ].join('\n'),
    );
  });

  it('sin dependencias borra los bloques enteros', () => {
    expect(procesar(texto, 'monitor', 3010, false)).toBe(
      ["const a = 'monitor';", 'PUERTO=3010'].join('\n'),
    );
  });

  it('falla si un bloque no se cierra', () => {
    expect(() => procesar('// dependencias:inicio\nx', 'a', 1, true)).toThrow(/dependencias:fin/);
  });
});

describe('generarServicio', () => {
  // Copia mínima del repositorio en una carpeta temporal.
  const temporal = mkdtempSync(join(tmpdir(), 'plantilla-'));
  for (const ruta of [
    'infra/plantilla-servicio',
    'packages/comun/package.json',
    'specs/openapi/monitor.yaml',
  ]) {
    copiar(join(raiz, ruta), join(temporal, ruta));
  }
  afterAll(() => rmSync(temporal, { recursive: true, force: true }));

  it('genera el servicio con su package.json, puerto y contrato', () => {
    const destino = generarServicio({
      raiz: temporal,
      nombre: 'monitor',
      puerto: 3010,
      conDependencias: false,
    });
    const paquete = JSON.parse(readFileSync(join(destino, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(paquete).toMatchObject({ name: '@trotamundos/monitor', config: { puerto: 3010 } });
    const index = readFileSync(join(destino, 'src', 'index.ts'), 'utf8');
    expect(index).not.toContain('conectarBroker');
    expect(index).not.toContain('dependencias:');
    expect(readFileSync(join(destino, 'src', 'app.ts'), 'utf8')).toContain(
      'specs/openapi/monitor.yaml',
    );
    expect(readFileSync(join(destino, 'Dockerfile'), 'utf8')).toContain('EXPOSE 3010');
  });

  it('no pisa un servicio que ya existe ni genera uno sin contrato', () => {
    expect(() =>
      generarServicio({ raiz: temporal, nombre: 'monitor', puerto: 3010, conDependencias: false }),
    ).toThrow(/ya existe/);
    expect(() =>
      generarServicio({ raiz: temporal, nombre: 'otro', puerto: 3011, conDependencias: true }),
    ).toThrow(/primero el contrato/);
  });
});
