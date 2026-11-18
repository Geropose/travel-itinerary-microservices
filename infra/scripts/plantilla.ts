// Genera un servicio a partir de infra/plantilla-servicio (lo usa nuevo-servicio.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export interface OpcionesGenerar {
  /** Raíz del repositorio. */
  raiz: string;
  nombre: string;
  puerto: number;
  /** Con base, broker y JWT (false para el monitor de salud). */
  conDependencias: boolean;
}

/**
 * Reemplaza __NOMBRE__ y __PUERTO__ y resuelve los bloques "dependencias:inicio ... dependencias:fin"
 * (con // o #): con dependencias se quedan, sin las líneas del marcador; sin dependencias se borran.
 */
export function procesar(
  texto: string,
  nombre: string,
  puerto: number,
  conDependencias: boolean,
): string {
  const lineas: string[] = [];
  let dentro = false;
  for (const linea of texto.split('\n')) {
    if (/^\s*(\/\/|#) dependencias:inicio\s*$/.test(linea)) {
      dentro = true;
    } else if (/^\s*(\/\/|#) dependencias:fin\s*$/.test(linea)) {
      dentro = false;
    } else if (!dentro || conDependencias) {
      lineas.push(linea);
    }
  }
  if (dentro) throw new Error('Falta un "dependencias:fin" en la plantilla');
  return lineas
    .join('\n')
    .replaceAll('__NOMBRE__', nombre)
    .replaceAll('__PUERTO__', String(puerto));
}

function archivos(carpeta: string): string[] {
  return readdirSync(carpeta).flatMap((nombre) => {
    const ruta = join(carpeta, nombre);
    return statSync(ruta).isDirectory() ? archivos(ruta) : [ruta];
  });
}

/** Crea services/<nombre>. Lanza un error si falta el contrato o el servicio ya existe. */
export function generarServicio({
  raiz,
  nombre,
  puerto,
  conDependencias,
}: OpcionesGenerar): string {
  if (!/^[a-z][a-z0-9-]*$/.test(nombre))
    throw new Error('El nombre va en minúsculas, sin espacios.');
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
    throw new Error('El puerto tiene que ser un número de 1 a 65535.');
  }
  const spec = join(raiz, 'specs', 'openapi', `${nombre}.yaml`);
  if (!existsSync(spec)) {
    throw new Error(`No existe el contrato specs/openapi/${nombre}.yaml: primero el contrato.`);
  }
  const destino = join(raiz, 'services', nombre);
  if (existsSync(join(destino, 'package.json'))) throw new Error(`services/${nombre} ya existe.`);

  const plantilla = join(raiz, 'infra', 'plantilla-servicio');
  for (const origen of archivos(plantilla)) {
    const ruta = join(destino, relative(plantilla, origen));
    mkdirSync(dirname(ruta), { recursive: true });
    writeFileSync(ruta, procesar(readFileSync(origen, 'utf8'), nombre, puerto, conDependencias));
  }

  const comun = JSON.parse(
    readFileSync(join(raiz, 'packages', 'comun', 'package.json'), 'utf8'),
  ) as {
    version: string;
    dependencies: Record<string, string>;
  };
  const paquete = {
    name: `@trotamundos/${nombre}`,
    version: '0.1.0',
    private: true,
    description: `Servicio ${nombre} de Trotamundos (contrato: specs/openapi/${nombre}.yaml)`,
    type: 'module',
    config: { puerto },
    scripts: {
      start: 'node src/index.ts',
      dev: 'node --watch src/index.ts',
      test: `vitest run --root ../.. services/${nombre}`,
    },
    dependencies: {
      '@trotamundos/comun': comun.version,
      zod: comun.dependencies.zod,
    },
  };
  writeFileSync(join(destino, 'package.json'), `${JSON.stringify(paquete, null, 2)}\n`);
  return destino;
}
