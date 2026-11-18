// Escalado horizontal simple (ADR-006 y ADR-008). Cada 15 s lee docker stats y, por servicio de
// cada región:
//   - si el procesador promedio de sus instancias pasa el 70 %, agrega una (docker compose --scale);
//   - si queda por debajo del 30 % durante 2 minutos, saca una;
//   - nunca baja del mínimo: 3 por servicio con el perfil ha (ADR-006), 2 del gateway sin él.
// nginx ve las instancias nuevas del gateway en 5 s (resolve); los demás servicios se reparten por
// el DNS de Docker.
//
//   npm run infra:escalador                  las dos regiones, hasta Ctrl+C
//   npm run infra:escalador -- --solo r1     una sola región
//   npm run infra:escalador -- --cada 30     cada 30 s
//   npm run infra:escalador -- --una-vez     una sola lectura (para probar)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { leerEnv, PROYECTOS, type Proyecto } from './entorno.ts';
import {
  decidir,
  leerPs,
  leerStats,
  minimoDe,
  pasoEscalar,
  usosPorServicio,
  type Memoria,
} from './escalado.ts';

const raiz = fileURLToPath(new URL('../../', import.meta.url));
process.chdir(raiz);

function salir(mensaje: string): never {
  process.stderr.write(`${mensaje}\n`);
  process.exit(1);
}

function docker(args: string[], entorno: Record<string, string> = {}): string {
  const r = spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, ...entorno } });
  if (r.error) salir(`No se pudo ejecutar docker: ${r.error.message}. ¿Está corriendo?`);
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout;
}

// Argumentos.
const args = process.argv.slice(2);
let regiones: Proyecto[] = ['r1', 'r2'];
let cadaSeg = 15;
let unaVez = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--solo') {
    const p = args[++i] ?? '';
    if (!(p in PROYECTOS)) salir(`--solo va seguido de r1 o r2 (llegó "${p}")`);
    regiones = [p as Proyecto];
  } else if (arg === '--cada') {
    cadaSeg = Number(args[++i]);
    if (!Number.isFinite(cadaSeg) || cadaSeg < 5)
      salir('--cada va seguido de los segundos (5 o más)');
  } else if (arg === '--una-vez') {
    unaVez = true;
  } else {
    salir(`Argumento desconocido: ${arg ?? ''}`);
  }
}
if (!existsSync('.env')) salir('No existe .env: corré npm run infra:levantar.');
const env = leerEnv(readFileSync('.env', 'utf8'));
const memoria: Memoria = new Map();

/** Regiones que corren con el perfil ha (el nodo 2 de RabbitMQ está andando). */
function regionesConHa(): Set<string> {
  return new Set(
    regiones.filter(
      (p) =>
        docker([
          'ps',
          '-q',
          '--filter',
          `label=com.docker.compose.project=${p}`,
          '--filter',
          'label=com.docker.compose.service=rabbitmq-2',
        ]).trim() !== '',
    ),
  );
}

function ciclo(): void {
  const contenedores = leerPs(
    docker([
      'ps',
      '--filter',
      'label=trotamundos.servicio',
      '--format',
      '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Label "trotamundos.servicio"}}',
    ]),
  ).filter((c) => (regiones as string[]).includes(c.proyecto));
  if (contenedores.length === 0) {
    process.stdout.write('No hay ninguna región levantada (npm run infra:levantar).\n');
    return;
  }
  const cpu = leerStats(
    docker([
      'stats',
      '--no-stream',
      '--format',
      '{{.Name}}|{{.CPUPerc}}',
      ...contenedores.map((c) => c.nombre),
    ]),
  );
  const conHa = regionesConHa();
  const usos = usosPorServicio(contenedores, cpu, conHa);
  const hora = new Date().toLocaleTimeString();
  process.stdout.write(`\n[${hora}] procesador promedio por servicio:\n`);
  for (const u of usos) {
    process.stdout.write(
      `  ${u.proyecto} ${u.servicio.padEnd(14)} ${String(u.instancias).padStart(2)} inst. ` +
        `${u.cpu.toFixed(1).padStart(6)} %  (mín. ${minimoDe(u.servicio, u.ha)})\n`,
    );
  }
  for (const decision of decidir(usos, memoria, Date.now())) {
    const paso = pasoEscalar(decision, env, conHa.has(decision.proyecto));
    if (!paso) continue;
    process.stdout.write(`▶ ${paso.descripcion}\n`);
    try {
      docker(paso.args, paso.entorno);
    } catch (error) {
      process.stderr.write(`No se pudo escalar: ${(error as Error).message}\n`);
    }
  }
}

process.stdout.write(
  `Escalador: ${regiones.join(' y ')}, cada ${cadaSeg} s (Ctrl+C para terminar).\n`,
);
ciclo();
if (!unaVez) setInterval(ciclo, cadaSeg * 1000);
