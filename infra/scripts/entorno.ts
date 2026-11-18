// Lógica de los scripts de infraestructura (secretos.ts e infra.ts), separada para poder probarla
// sin Docker: generación de secretos, lectura del .env y los comandos de docker compose de cada paso.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Los valores de .env.example que empiezan así se reemplazan por uno generado. */
export const PREFIJO_EJEMPLO = 'cambiar-';

/** Genera un valor de desarrollo según el nombre de la variable. */
export function generarValor(clave: string): string {
  if (clave.startsWith('JWT_CLAVE_PRIVADA')) {
    // RS256 (ADR-014): PEM PKCS#8 en base64, para que entre en una sola línea del .env.
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    return Buffer.from(privateKey).toString('base64');
  }
  // AES-256: 32 bytes.
  if (clave === 'CLAVE_TOKENS_CORREO') return randomBytes(32).toString('base64');
  // Contraseñas y secretos: hexadecimal, así entran en una URL sin escaparlos.
  return randomBytes(24).toString('hex');
}

const LINEA_VARIABLE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

/** Lee un archivo .env (CLAVE=valor por línea; ignora comentarios y líneas vacías). */
export function leerEnv(texto: string): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const linea of texto.split(/\r?\n/)) {
    const encontrada = LINEA_VARIABLE.exec(linea.trim());
    if (encontrada?.[1] !== undefined) variables[encontrada[1]] = encontrada[2] ?? '';
  }
  return variables;
}

/**
 * Arma el .env a partir de .env.example: cada valor "cambiar-..." se reemplaza por uno generado,
 * salvo que ya exista en `actuales` (así se pueden completar las variables nuevas sin cambiar las
 * claves que ya usan las bases). El resto de las líneas y los comentarios quedan iguales.
 */
export function generarSecretos(
  ejemplo: string,
  actuales: Record<string, string> = {},
  generar: (clave: string) => string = generarValor,
): { texto: string; generadas: string[] } {
  const generadas: string[] = [];
  const lineas = ejemplo.split(/\r?\n/).map((linea) => {
    const [, clave, valor] = LINEA_VARIABLE.exec(linea) ?? [];
    if (clave === undefined || valor === undefined) return linea;
    const actual = actuales[clave];
    if (actual !== undefined) return `${clave}=${actual}`;
    if (!valor.startsWith(PREFIJO_EJEMPLO)) return linea;
    generadas.push(clave);
    return `${clave}=${generar(clave)}`;
  });
  return { texto: lineas.join('\n'), generadas };
}

/**
 * Escribe <raiz>/.env desde .env.example. Si ya existe, solo agrega las variables que falten (las
 * claves de las bases quedan en los volúmenes: cambiarlas obliga a npm run infra:reset). Con
 * `regenerar` vuelve a generar todo.
 */
export function escribirSecretos(raiz: string, regenerar = false): { generadas: string[] } {
  const destino = join(raiz, '.env');
  const actuales = existsSync(destino) && !regenerar ? leerEnv(readFileSync(destino, 'utf8')) : {};
  const { texto, generadas } = generarSecretos(
    readFileSync(join(raiz, '.env.example'), 'utf8'),
    actuales,
  );
  writeFileSync(destino, texto);
  return { generadas };
}

/** Proyectos de docker compose de cada región. */
export const PROYECTOS = { r1: 'region-1', r2: 'region-2' } as const;
export type Proyecto = keyof typeof PROYECTOS;
export const PROYECTO_GLOBAL = 'global';
export const ARCHIVO_REGION = 'infra/region.compose.yaml';
export const ARCHIVO_GLOBAL = 'infra/global.compose.yaml';
/** Red que crea global.compose.yaml y usan las dos regiones. */
export const RED_GLOBAL = 'trotamundos-global';

export interface Opciones {
  /** Regiones sobre las que se trabaja (las dos, o la de --solo). */
  regiones: Proyecto[];
  /** --solo: no se toca lo global al bajar (la otra región lo puede estar usando). */
  solo: boolean;
  /** --ha: perfil ha (RabbitMQ con 3 nodos). */
  ha: boolean;
  /** El resto de los argumentos se pasan a docker compose (por ejemplo --scale gateway=3). */
  resto: string[];
}

export function leerOpciones(args: string[]): Opciones {
  const opciones: Opciones = { regiones: ['r1', 'r2'], solo: false, ha: false, resto: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--solo') {
      const proyecto = args[++i] ?? '';
      if (!(proyecto in PROYECTOS))
        throw new Error(`--solo va seguido de r1 o r2 (llegó "${proyecto}")`);
      opciones.regiones = [proyecto as Proyecto];
      opciones.solo = true;
    } else if (arg === '--ha') {
      opciones.ha = true;
    } else {
      opciones.resto.push(arg);
    }
  }
  return opciones;
}

/** Un comando de docker con las variables de entorno que necesita. */
export interface Paso {
  descripcion: string;
  args: string[];
  entorno: Record<string, string>;
}

function compose(proyecto: string, archivo: string): string[] {
  return ['compose', '-p', proyecto, '-f', archivo, '--env-file', '.env'];
}

/**
 * Variables que distinguen a una región. El .env es uno solo, así que lo propio de cada región
 * (puerto de nginx y clave del JWT) se elige acá según el proyecto.
 */
export function entornoRegion(
  proyecto: Proyecto,
  env: Record<string, string>,
): Record<string, string> {
  const region = PROYECTOS[proyecto];
  const otra = region === 'region-1' ? 'region-2' : 'region-1';
  const sufijo = (r: string) => r.toUpperCase().replace('-', '_');
  return {
    REGION: region,
    OTRA_REGION: otra,
    PUERTO_NGINX: env[`PUERTO_NGINX_${sufijo(region)}`] ?? '',
    PUERTO_NGINX_OTRA_REGION: env[`PUERTO_NGINX_${sufijo(otra)}`] ?? '',
    JWT_CLAVE_PRIVADA: env[`JWT_CLAVE_PRIVADA_${sufijo(region)}`] ?? '',
  };
}

/**
 * Pasos de npm run infra:levantar. `conHa`: regiones que ya se levantaron con el perfil ha. Siguen
 * con los 3 nodos de RabbitMQ aunque no se pase --ha, porque el nodo 1 quedó en un cluster y solo
 * no arranca (para volver a un nodo: npm run infra:reset).
 */
export function pasosLevantar(
  opciones: Opciones,
  env: Record<string, string>,
  conHa: Proyecto[] = [],
): Paso[] {
  const [primera] = opciones.regiones;
  if (!primera) return [];
  const perfil = (proyecto: Proyecto) =>
    opciones.ha || conHa.includes(proyecto) ? ['--profile', 'ha'] : [];
  return [
    {
      descripcion: 'Global: red global y base de analítica',
      args: [...compose(PROYECTO_GLOBAL, ARCHIVO_GLOBAL), 'up', '-d', '--wait'],
      entorno: {},
    },
    {
      // Una sola vez: las dos regiones usan las mismas imágenes.
      descripcion: 'Imágenes de los servicios',
      args: [...compose(primera, ARCHIVO_REGION), 'build'],
      entorno: entornoRegion(primera, env),
    },
    ...opciones.regiones.flatMap((proyecto) => [
      {
        descripcion: `Región ${proyecto} (${PROYECTOS[proyecto]})`,
        args: [
          ...compose(proyecto, ARCHIVO_REGION),
          ...perfil(proyecto),
          'up',
          '-d',
          '--wait',
          '--wait-timeout',
          '300',
          ...opciones.resto,
        ],
        entorno: entornoRegion(proyecto, env),
      },
      {
        // Analista de prueba (se puede correr varias veces).
        descripcion: `Semillas de Autenticación en ${proyecto}`,
        args: [
          ...compose(proyecto, ARCHIVO_REGION),
          'exec',
          '-T',
          'autenticacion',
          'node',
          'services/autenticacion/src/semillas.ts',
        ],
        entorno: entornoRegion(proyecto, env),
      },
    ]),
  ];
}

/** Baja las regiones y, si no es --solo, lo global. Con `volumenes` borra también los datos. */
export function pasosBajar(
  opciones: Opciones,
  env: Record<string, string>,
  volumenes: boolean,
): Paso[] {
  const extra = ['--remove-orphans', ...(volumenes ? ['--volumes'] : []), ...opciones.resto];
  const pasos: Paso[] = opciones.regiones.map((proyecto) => ({
    descripcion: `Región ${proyecto} (${PROYECTOS[proyecto]})`,
    // Con el perfil ha activo, así también se bajan los nodos 2 y 3 de RabbitMQ.
    args: [...compose(proyecto, ARCHIVO_REGION), '--profile', 'ha', 'down', ...extra],
    entorno: entornoRegion(proyecto, env),
  }));
  if (!opciones.solo) {
    pasos.push({
      descripcion: 'Global',
      args: [...compose(PROYECTO_GLOBAL, ARCHIVO_GLOBAL), 'down', ...extra],
      entorno: {},
    });
  }
  return pasos;
}

/** Logs de cada región (opciones.resto: servicios, por ejemplo gateway viajes). */
export function pasosLogs(opciones: Opciones, env: Record<string, string>): Paso[] {
  return opciones.regiones.map((proyecto) => ({
    descripcion: proyecto,
    args: [
      ...compose(proyecto, ARCHIVO_REGION),
      '--profile',
      'ha',
      'logs',
      '--follow',
      '--tail',
      '50',
      ...opciones.resto,
    ],
    entorno: entornoRegion(proyecto, env),
  }));
}
