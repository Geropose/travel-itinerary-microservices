// Levanta, baja y muestra los logs de la infraestructura con docker compose. Funciona igual en
// Windows, Linux y Mac (solo usa Node y el comando docker).
//
//   npm run infra:levantar                   global + r1 + r2 (genera el .env si no existe)
//   npm run infra:levantar -- --solo r1      global + una sola región
//   npm run infra:levantar -- --ha           RabbitMQ con 3 nodos en cluster (perfil ha)
//   npm run infra:levantar -- --scale gateway=3
//   npm run infra:bajar [-- --solo r1]       baja los contenedores (los datos quedan)
//   npm run infra:reset [-- --solo r1]       baja los contenedores y borra los volúmenes
//   npm run infra:logs [-- --solo r1] [servicio...]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  escribirSecretos,
  leerEnv,
  leerOpciones,
  pasosBajar,
  pasosLevantar,
  pasosLogs,
  type Paso,
  type Proyecto,
} from './entorno.ts';

const raiz = fileURLToPath(new URL('../../', import.meta.url));
process.chdir(raiz);

function salir(mensaje: string): never {
  process.stderr.write(`${mensaje}\n`);
  process.exit(1);
}

function correr(paso: Paso): void {
  process.stdout.write(`\n▶ ${paso.descripcion}\n  docker ${paso.args.join(' ')}\n`);
  const resultado = spawnSync('docker', paso.args, {
    stdio: 'inherit',
    env: { ...process.env, ...paso.entorno },
  });
  if (resultado.error)
    salir(`No se pudo ejecutar docker: ${resultado.error.message}. ¿Está instalado y corriendo?`);
  if (resultado.status !== 0)
    salir(`Falló: ${paso.descripcion} (código ${resultado.status ?? '?'}).`);
}

/** Regiones que tienen los volúmenes de los nodos 2 y 3 de RabbitMQ (se levantaron con --ha). */
function regionesConHa(regiones: Proyecto[]): Proyecto[] {
  return regiones.filter(
    (p) =>
      spawnSync('docker', ['volume', 'inspect', `${p}_rabbitmq-2`], { stdio: 'ignore' }).status ===
      0,
  );
}

/** Corre los logs de cada región a la vez, con el nombre del proyecto delante de cada línea. */
function seguirLogs(pasos: Paso[]): void {
  for (const paso of pasos) {
    const hijo = spawn('docker', paso.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...paso.entorno },
    });
    hijo.on('error', (error) => salir(`No se pudo ejecutar docker: ${error.message}`));
    for (const flujo of [hijo.stdout, hijo.stderr]) {
      createInterface({ input: flujo }).on('line', (linea) => {
        process.stdout.write(`[${paso.descripcion}] ${linea}\n`);
      });
    }
  }
}

const [comando = '', ...args] = process.argv.slice(2);
let opciones;
try {
  opciones = leerOpciones(args);
} catch (error) {
  salir((error as Error).message);
}

if (!existsSync('.env')) {
  if (comando !== 'levantar')
    salir('No existe .env: corré npm run infra:secretos o npm run infra:levantar.');
  const { generadas } = escribirSecretos(raiz);
  process.stdout.write(
    `No había .env: se generó con ${generadas.length} secretos de desarrollo.\n`,
  );
}
const env = leerEnv(readFileSync('.env', 'utf8'));

const SERVICIOS_REGIONALES = [
  'gateway',
  'autenticacion',
  'usuarios',
  'correo',
  'viajes',
  'integraciones',
  'analitica',
  'asistente',
  'monitor',
] as const;

const PUERTOS_MOCKS = [
  ['mock-gmail', 'PUERTO_MOCK_GMAIL', '4001'],
  ['mock-outlook', 'PUERTO_MOCK_OUTLOOK', '4002'],
  ['mock-aerolinea', 'PUERTO_MOCK_AEROLINEA', '4003'],
  ['mock-hotel', 'PUERTO_MOCK_HOTEL', '4004'],
  ['mock-rentadora', 'PUERTO_MOCK_RENTADORA', '4005'],
  ['mock-agencia', 'PUERTO_MOCK_AGENCIA', '4006'],
  ['mock-redsocial', 'PUERTO_MOCK_REDSOCIAL', '4007'],
] as const;

async function esperarUrlSana(nombre: string, url: string, timeoutMs = 45_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  let ultimoMotivo = 'sin respuesta';
  while (Date.now() < limite) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) return;
      ultimoMotivo = `HTTP ${resp.status}`;
    } catch (error) {
      ultimoMotivo = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  salir(`El servicio ${nombre} no respondió sano en ${url} (${ultimoMotivo}).`);
}

async function verificarSaludCompleta(
  regiones: Proyecto[],
  env: Record<string, string>,
): Promise<void> {
  process.stdout.write('\n▶ Verificando salud de enrutador, mocks y servicios regionales\n');
  const puertoEnrutador = env.PUERTO_ENRUTADOR ?? '8000';
  const chequeos: [string, string][] = [
    ['enrutador', `http://localhost:${puertoEnrutador}/health`],
  ];
  for (const [nombre, variable, defecto] of PUERTOS_MOCKS) {
    chequeos.push([nombre, `http://localhost:${env[variable] ?? defecto}/health`]);
  }
  for (const proyecto of regiones) {
    const numero = proyecto.slice(1);
    const puertoNginx = env[`PUERTO_NGINX_REGION_${numero}`] ?? (numero === '1' ? '8081' : '8082');
    chequeos.push([`${proyecto}/nginx`, `http://localhost:${puertoNginx}/nginx/salud`]);
    for (const servicio of SERVICIOS_REGIONALES) {
      chequeos.push([
        `${proyecto}/${servicio}`,
        `http://localhost:${puertoNginx}/salud/${servicio}`,
      ]);
    }
  }
  await Promise.all(chequeos.map(([nombre, url]) => esperarUrlSana(nombre, url)));
  process.stdout.write(`  ✓ ${chequeos.length}/${chequeos.length} endpoints de salud OK\n`);
}

switch (comando) {
  case 'levantar': {
    const conHa = opciones.ha ? [] : regionesConHa(opciones.regiones);
    for (const p of conHa) {
      process.stdout.write(
        `${p} se levantó antes con --ha: sigue con 3 nodos de RabbitMQ (para volver a uno: npm run infra:reset -- --solo ${p}).\n`,
      );
    }
    for (const paso of pasosLevantar(opciones, env, conHa)) correr(paso);
    await verificarSaludCompleta(opciones.regiones, env);
    process.stdout.write(
      `\nListo. Enrutador global: http://localhost:${env.PUERTO_ENRUTADOR ?? '8000'}. nginx: ${opciones.regiones
        .map((p) => `${p} http://localhost:${env[`PUERTO_NGINX_REGION_${p.slice(1)}`] ?? '?'}`)
        .join(', ')}\n`,
    );
    break;
  }
  case 'bajar':
    for (const paso of pasosBajar(opciones, env, false)) correr(paso);
    break;
  case 'reset':
    for (const paso of pasosBajar(opciones, env, true)) correr(paso);
    break;
  case 'logs':
    seguirLogs(pasosLogs(opciones, env));
    break;
  default:
    salir('Uso: node infra/scripts/infra.ts <levantar|bajar|reset|logs> [--solo r1|r2] [--ha]');
}
