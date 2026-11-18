// Lógica del escalador (escalador.ts, ADR-006 y ADR-008), separada para probarla sin Docker:
// leer docker ps y docker stats, y decidir cuántas instancias necesita cada servicio.
import {
  ARCHIVO_REGION,
  compose,
  entornoRegion,
  PROYECTOS,
  type Paso,
  type Proyecto,
} from './entorno.ts';

/** Servicios que se escalan: el gateway y los microservicios (nginx publica un puerto y el monitor es uno por región). */
export const ESCALABLES = [
  'gateway',
  'autenticacion',
  'usuarios',
  'correo',
  'viajes',
  'integraciones',
  'analitica',
  'asistente',
] as const;

/** Instancias con las que arranca cada servicio (region.compose.yaml): nunca se baja de esto. */
export const INSTANCIAS_BASE: Record<string, number> = { gateway: 2 };

/** Con el perfil ha, al menos 3 instancias por servicio (ADR-006, redundancia activa). */
export const MINIMO_HA = 3;

export interface Umbrales {
  /** Si el uso de procesador promedio pasa este porcentaje, se agrega una instancia (ADR-008). */
  subirSobre: number;
  /** Si queda por debajo de este porcentaje durante ventanaBajaMs, se saca una. */
  bajarBajo: number;
  ventanaBajaMs: number;
  /** Tope de instancias por servicio, para que una prueba de carga no llene la máquina. */
  maximo: number;
}

export const UMBRALES: Umbrales = {
  subirSobre: 70,
  bajarBajo: 30,
  ventanaBajaMs: 2 * 60 * 1000,
  maximo: 10,
};

/** Uso de un servicio de una región en una lectura. */
export interface Uso {
  proyecto: string;
  servicio: string;
  instancias: number;
  /** Promedio del uso de procesador de sus instancias (%). */
  cpu: number;
  /** La región corre con el perfil ha. */
  ha: boolean;
}

export interface Decision {
  proyecto: string;
  servicio: string;
  desde: number;
  hasta: number;
  motivo: string;
}

/** Desde cuándo está cada servicio por debajo del umbral (clave proyecto/servicio). */
export type Memoria = Map<string, number>;

export function minimoDe(servicio: string, ha: boolean): number {
  return Math.max(INSTANCIAS_BASE[servicio] ?? 1, ha ? MINIMO_HA : 1);
}

/**
 * Decide los cambios de cantidad de instancias. Con más del 70 % de procesador, una más; con menos
 * del 30 % durante 2 minutos, una menos (nunca por debajo del mínimo). Con el perfil ha y menos de 3
 * instancias, sube a 3.
 */
export function decidir(
  usos: Uso[],
  memoria: Memoria,
  ahora: number,
  u: Umbrales = UMBRALES,
): Decision[] {
  const decisiones: Decision[] = [];
  for (const uso of usos) {
    const clave = `${uso.proyecto}/${uso.servicio}`;
    const minimo = minimoDe(uso.servicio, uso.ha);
    const decidirA = (hasta: number, motivo: string) =>
      decisiones.push({
        proyecto: uso.proyecto,
        servicio: uso.servicio,
        desde: uso.instancias,
        hasta,
        motivo,
      });

    if (uso.instancias < minimo) {
      memoria.delete(clave);
      decidirA(minimo, `menos instancias que el mínimo (${minimo})`);
    } else if (uso.cpu > u.subirSobre) {
      memoria.delete(clave);
      if (uso.instancias < u.maximo) {
        decidirA(uso.instancias + 1, `procesador al ${uso.cpu.toFixed(1)} % (> ${u.subirSobre} %)`);
      }
    } else if (uso.cpu < u.bajarBajo) {
      const desde = memoria.get(clave) ?? ahora;
      memoria.set(clave, desde);
      if (ahora - desde >= u.ventanaBajaMs && uso.instancias > minimo) {
        // Vuelve a contar los 2 minutos para la próxima instancia que se saque.
        memoria.set(clave, ahora);
        decidirA(
          uso.instancias - 1,
          `procesador por debajo del ${u.bajarBajo} % durante ${Math.round(u.ventanaBajaMs / 1000)} s`,
        );
      }
    } else {
      memoria.delete(clave);
    }
  }
  return decisiones;
}

/** Un contenedor de docker ps: nombre, proyecto de compose y etiqueta trotamundos.servicio. */
export interface Contenedor {
  nombre: string;
  proyecto: string;
  servicio: string;
}

/**
 * Lee la salida de
 *   docker ps --filter label=trotamundos.servicio --format
 *     '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Label "trotamundos.servicio"}}'
 */
export function leerPs(salida: string): Contenedor[] {
  return salida
    .split(/\r?\n/)
    .map((linea) => linea.trim().split('|'))
    .filter((partes): partes is [string, string, string] => partes.length === 3 && !!partes[0])
    .map(([nombre, proyecto, servicio]) => ({ nombre, proyecto, servicio }));
}

/** Lee la salida de docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}': nombre → %. */
export function leerStats(salida: string): Map<string, number> {
  const usos = new Map<string, number>();
  for (const linea of salida.split(/\r?\n/)) {
    const [nombre, cpu] = linea.trim().split('|');
    const valor = Number.parseFloat((cpu ?? '').replace('%', ''));
    if (nombre && Number.isFinite(valor)) usos.set(nombre, valor);
  }
  return usos;
}

/** Junta docker ps y docker stats: uso promedio por servicio escalable de cada región. */
export function usosPorServicio(
  contenedores: Contenedor[],
  cpu: Map<string, number>,
  conHa: Set<string>,
): Uso[] {
  const grupos = new Map<string, { proyecto: string; servicio: string; valores: number[] }>();
  for (const c of contenedores) {
    if (!(ESCALABLES as readonly string[]).includes(c.servicio)) continue;
    const clave = `${c.proyecto}/${c.servicio}`;
    const grupo = grupos.get(clave) ?? { proyecto: c.proyecto, servicio: c.servicio, valores: [] };
    grupo.valores.push(cpu.get(c.nombre) ?? 0);
    grupos.set(clave, grupo);
  }
  return [...grupos.values()]
    .map(({ proyecto, servicio, valores }) => ({
      proyecto,
      servicio,
      instancias: valores.length,
      cpu: valores.reduce((a, b) => a + b, 0) / valores.length,
      ha: conHa.has(proyecto),
    }))
    .sort((a, b) => `${a.proyecto}/${a.servicio}`.localeCompare(`${b.proyecto}/${b.servicio}`));
}

/** Comando de docker compose que lleva un servicio de una región a `hasta` instancias. */
export function pasoEscalar(
  decision: Decision,
  env: Record<string, string>,
  ha: boolean,
): Paso | undefined {
  if (!(decision.proyecto in PROYECTOS)) return undefined;
  const proyecto = decision.proyecto as Proyecto;
  return {
    descripcion: `${proyecto} ${decision.servicio}: ${decision.desde} → ${decision.hasta} (${decision.motivo})`,
    args: [
      ...compose(proyecto, ARCHIVO_REGION),
      ...(ha ? ['--profile', 'ha'] : []),
      'up',
      '-d',
      // Solo ese servicio, sin recrear las instancias que ya están.
      '--no-deps',
      '--no-recreate',
      '--scale',
      `${decision.servicio}=${decision.hasta}`,
      decision.servicio,
    ],
    entorno: entornoRegion(proyecto, env),
  };
}
