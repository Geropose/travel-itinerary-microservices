// Promoción de la read replica de Viajes a base principal cuando cae la principal (P3.5, QA-4,
// ADR-012, ADR-017). Promueve pg_basebackup standby mediante pg_promote(), reasigna el alias DNS
// interno `postgres-viajes` dentro de la red privada de la región y reinicia Viajes para retomar
// escrituras sin intervención manual.
//
//   npm run infra:failover-viajes                 promueve la réplica de r1
//   npm run infra:failover-viajes -- --solo r2    promueve la réplica de r2
//   npm run infra:failover-viajes -- --restaurar  restaura principal + réplica limpia
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leerEnv, PROYECTOS, type Proyecto } from './entorno.ts';

export interface OpcionesFailover {
  proyecto: Proyecto;
  restaurar: boolean;
}

export interface PasoDockerFailover {
  descripcion: string;
  args: string[];
  tolerarError?: boolean;
}

export interface ResultadoFailover {
  proyecto: Proyecto;
  duracionMs: number;
  enRecuperacionDespues: string;
}

export function leerArgumentosFailover(args: string[]): OpcionesFailover {
  let proyecto: Proyecto = 'r1';
  let restaurar = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--solo') {
      const valor = args[++i] ?? '';
      if (!(valor in PROYECTOS)) {
        throw new Error(`--solo va seguido de r1 o r2 (llegó "${valor}")`);
      }
      proyecto = valor as Proyecto;
    } else if (arg === '--restaurar') {
      restaurar = true;
    } else {
      throw new Error(`Argumento desconocido: ${arg}`);
    }
  }

  return { proyecto, restaurar };
}

export function pasosPromoverReplicaViajes(
  proyecto: Proyecto,
  instanciasViajes: string[] = [`${proyecto}-viajes-1`],
): PasoDockerFailover[] {
  const red = `${proyecto}_region`;
  const principal = `${proyecto}-postgres-viajes-1`;
  const replica = `${proyecto}-postgres-viajes-replica-1`;

  const pasos: PasoDockerFailover[] = [
    {
      descripcion: `Asegurar principal (${principal}) detenida`,
      args: ['stop', principal],
      tolerarError: true,
    },
    {
      descripcion: `Liberar alias DNS postgres-viajes en red ${red}`,
      args: ['network', 'disconnect', '-f', red, principal],
      tolerarError: true,
    },
    {
      descripcion: `Promover read replica (${replica}) con pg_promote()`,
      args: [
        'exec',
        replica,
        'psql',
        '-U',
        'admin',
        '-d',
        'postgres',
        '-tAc',
        'SELECT pg_promote(true, 30)',
      ],
    },
    {
      descripcion: `Desconectar temporalmente ${replica} de ${red} para actualizar aliases`,
      args: ['network', 'disconnect', red, replica],
      tolerarError: true,
    },
    {
      descripcion: `Asignar aliases postgres-viajes y postgres-viajes-replica a ${replica}`,
      args: [
        'network',
        'connect',
        '--alias',
        'postgres-viajes',
        '--alias',
        'postgres-viajes-replica',
        red,
        replica,
      ],
    },
  ];

  if (instanciasViajes.length > 0) {
    pasos.push({
      descripcion: `Reiniciar instancias de Viajes (${instanciasViajes.join(', ')})`,
      args: ['restart', ...instanciasViajes],
    });
  }

  return pasos;
}

function docker(args: string[], tolerarError = false): string {
  try {
    return execFileSync('docker', args, { encoding: 'utf8' }).trim();
  } catch (err) {
    if (tolerarError) return '';
    throw err;
  }
}

function listarContenedoresViajes(proyecto: Proyecto): string[] {
  const salida = docker([
    'ps',
    '-aq',
    '--filter',
    `label=com.docker.compose.project=${proyecto}`,
    '--filter',
    'label=com.docker.compose.service=viajes',
  ]);
  return salida.split(/\r?\n/).filter(Boolean);
}

async function esperarSaludViajes(proyecto: Proyecto, env: Record<string, string>): Promise<void> {
  const numero = proyecto.slice(1);
  const puerto = env[`PUERTO_NGINX_REGION_${numero}`] ?? (numero === '1' ? '8081' : '8082');
  const url = `http://localhost:${puerto}/salud/viajes`;
  const limite = Date.now() + 60_000;

  while (Date.now() < limite) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (resp.status === 200) return;
    } catch {
      // Sigue reintentando hasta que Viajes vuelva a estar sano.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Viajes en ${proyecto} no respondió 200 en ${url} antes de 60 s.`);
}

export async function ejecutarFailoverViajes(
  proyecto: Proyecto,
  env: Record<string, string>,
): Promise<ResultadoFailover> {
  const inicio = Date.now();
  const instancias = listarContenedoresViajes(proyecto);
  const replica = `${proyecto}-postgres-viajes-replica-1`;

  for (const paso of pasosPromoverReplicaViajes(proyecto, instancias)) {
    docker(paso.args, paso.tolerarError ?? false);
  }

  const enRecuperacionDespues = docker([
    'exec',
    replica,
    'psql',
    '-U',
    'admin',
    '-d',
    'postgres',
    '-tAc',
    'SELECT pg_is_in_recovery()',
  ]);
  if (enRecuperacionDespues !== 'f') {
    throw new Error(
      `La réplica ${replica} siguió en modo recovery (${enRecuperacionDespues}) tras pg_promote.`,
    );
  }

  await esperarSaludViajes(proyecto, env);
  return {
    proyecto,
    duracionMs: Date.now() - inicio,
    enRecuperacionDespues,
  };
}

/**
 * Restaura la topología normal tras un failover: reconecta y levanta `postgres-viajes` como
 * principal, reinicializa `postgres-viajes-replica` como standby vía pg_basebackup y reinicia Viajes.
 */
export async function restaurarPrincipalViajes(
  proyecto: Proyecto,
  env: Record<string, string>,
): Promise<void> {
  const red = `${proyecto}_region`;
  const principal = `${proyecto}-postgres-viajes-1`;
  const replica = `${proyecto}-postgres-viajes-replica-1`;
  const volumenReplica = `${proyecto}_postgres-viajes-replica`;

  docker(['stop', replica], true);
  docker(['network', 'disconnect', '-f', red, replica], true);
  docker(['network', 'disconnect', '-f', red, principal], true);
  docker(['network', 'connect', '--alias', 'postgres-viajes', red, principal], true);
  docker(['start', principal]);

  const limitePrincipal = Date.now() + 30_000;
  while (Date.now() < limitePrincipal) {
    try {
      docker(['exec', principal, 'pg_isready', '-h', '127.0.0.1', '-U', 'admin', '-d', 'postgres']);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Vaciar pgdata de la réplica para que iniciar-replica.sh vuelva a hacer pg_basebackup en standby.
  docker([
    'run',
    '--rm',
    '-v',
    `${volumenReplica}:/var/lib/postgresql/data`,
    'postgres:17-alpine',
    'sh',
    '-c',
    'rm -rf /var/lib/postgresql/data/*',
  ]);
  docker(['network', 'connect', '--alias', 'postgres-viajes-replica', red, replica], true);
  docker(['start', replica]);

  let replicaLista = false;
  const limiteReplica = Date.now() + 60_000;
  while (Date.now() < limiteReplica) {
    try {
      const rec = docker([
        'exec',
        replica,
        'psql',
        '-U',
        'admin',
        '-d',
        'viajes',
        '-tAc',
        'SELECT pg_is_in_recovery()',
      ]);
      const streaming = Number(
        docker([
          'exec',
          principal,
          'psql',
          '-U',
          'admin',
          '-d',
          'postgres',
          '-tAc',
          "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'",
        ]),
      );
      if (rec === 't' && streaming >= 1) {
        replicaLista = true;
        break;
      }
    } catch {
      // Aún clonando, sincronizando replicación o arrancando standby.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!replicaLista) {
    throw new Error(
      `La réplica ${replica} no quedó lista en modo standby/streaming en 60 s al restaurar ${principal}.`,
    );
  }

  const instancias = listarContenedoresViajes(proyecto);
  if (instancias.length > 0) docker(['restart', ...instancias]);
  await esperarSaludViajes(proyecto, env);
}

const esEjecucionDirecta = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (esEjecucionDirecta) {
  const raiz = fileURLToPath(new URL('../../', import.meta.url));
  process.chdir(raiz);
  if (!existsSync('.env')) {
    process.stderr.write('No existe .env: corré npm run infra:levantar.\n');
    process.exit(1);
  }
  const env = leerEnv(readFileSync('.env', 'utf8'));
  const opciones = leerArgumentosFailover(process.argv.slice(2));
  if (opciones.restaurar) {
    process.stdout.write(
      `▶ Restaurando topología principal/réplica de Viajes en ${opciones.proyecto}...\n`,
    );
    await restaurarPrincipalViajes(opciones.proyecto, env);
    process.stdout.write(`✓ Topología restaurada en ${opciones.proyecto}.\n`);
  } else {
    process.stdout.write(`▶ Ejecutando failover de Viajes en ${opciones.proyecto}...\n`);
    const resultado = await ejecutarFailoverViajes(opciones.proyecto, env);
    process.stdout.write(
      `✓ Failover completado en ${(resultado.duracionMs / 1000).toFixed(2)} s (pg_is_in_recovery=${resultado.enRecuperacionDespues}).\n`,
    );
  }
}
