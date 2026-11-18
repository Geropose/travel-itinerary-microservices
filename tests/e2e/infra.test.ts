// Infraestructura levantada con npm run infra:levantar (P1.3): salud de cada servicio a través del
// nginx de cada región, una base por servicio sin acceso cruzado (ADR-001), read replica de Viajes
// en standby (ADR-012) y regiones aisladas: desde r1 no se llega a las bases de r2 (CONST-6).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { leerEnv, PROYECTOS, type Proyecto } from '../../infra/scripts/entorno.ts';

const env = leerEnv(readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8'));

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

/** Contenedores de un servicio de un proyecto de compose. */
function contenedores(proyecto: string, servicio: string): string[] {
  return docker(
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${proyecto}`,
    '--filter',
    `label=com.docker.compose.service=${servicio}`,
  )
    .split('\n')
    .filter(Boolean);
}

const arriba = (Object.keys(PROYECTOS) as Proyecto[]).filter(
  (p) => contenedores(p, 'nginx').length > 0,
);
const SERVICIOS = [
  'gateway',
  'autenticacion',
  'usuarios',
  'correo',
  'viajes',
  'integraciones',
  'analitica',
  'asistente',
  'monitor',
];
/** Base de cada usuario del servidor postgres de la región. */
const BASES: Record<string, string> = {
  gateway: 'registro_accesos',
  autenticacion: 'autenticacion',
  usuarios: 'usuarios',
  correo: 'correo',
  integraciones: 'integraciones',
  analitica: 'analitica',
  asistente: 'asistente',
};
/** Bases, broker y cache de cada región, con su puerto. */
const DATOS: Record<string, number> = {
  postgres: 5432,
  'postgres-viajes': 5432,
  'postgres-viajes-replica': 5432,
  redis: 6379,
  rabbitmq: 5672,
};

const psql = (contenedor: string, base: string, sql: string) =>
  docker('exec', contenedor, 'psql', '-U', 'admin', '-d', base, '-tAc', sql);

/**
 * Desde un contenedor de servicio (tiene Node), intenta abrir una conexión TCP a cada destino a la
 * vez. Devuelve "conecta" o "sin-acceso" por destino.
 */
function probarConexiones(contenedor: string, destinos: [string, number][]): string[] {
  const codigo = `
    const net = require('node:net');
    const destinos = JSON.parse(process.argv[1]);
    Promise.all(destinos.map(([host, puerto]) => new Promise((listo) => {
      const s = net.connect(puerto, host);
      s.setTimeout(2000);
      s.on('connect', () => { s.destroy(); listo('conecta'); });
      s.on('timeout', () => { s.destroy(); listo('sin-acceso'); });
      s.on('error', () => listo('sin-acceso'));
    }))).then((r) => console.log(JSON.stringify(r)));`;
  return JSON.parse(
    docker('exec', contenedor, 'node', '-e', codigo, JSON.stringify(destinos)),
  ) as string[];
}

/** IPs de un contenedor en todas sus redes. */
const ips = (contenedor: string) =>
  docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', contenedor)
    .split(' ')
    .filter(Boolean);

describe('sistema levantado', () => {
  it('hay al menos una región arriba (npm run infra:levantar)', () => {
    expect(arriba.length).toBeGreaterThan(0);
  });
});

describe.each(arriba)('región %s', (proyecto) => {
  const puerto = env[`PUERTO_NGINX_REGION_${proyecto.slice(1)}`];
  const nginx = `http://localhost:${puerto}`;

  it('el gateway responde GET /health a través de nginx, con 2 instancias o más', async () => {
    const respuesta = await fetch(`${nginx}/health`);
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toEqual({ estado: 'ok' });
    expect(contenedores(proyecto, 'gateway').length).toBeGreaterThanOrEqual(2);
  });

  it.each(SERVICIOS)('GET /health de %s responde 200 a través de nginx', async (servicio) => {
    const respuesta = await fetch(`${nginx}/salud/${servicio}`);
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toEqual({ estado: 'ok' });
  });

  it('cada usuario entra solo a la base de su servicio (ADR-001)', () => {
    // Cada usuario intenta conectarse y leer cada base; la contraseña está en el entorno del
    // contenedor (CLAVE_BD_<USUARIO>).
    const script = `
      for u in ${Object.keys(BASES).join(' ')}; do
        for b in ${Object.values(BASES).join(' ')}; do
          v=CLAVE_BD_$(echo $u | tr a-z A-Z); eval c=\\$$v
          if PGPASSWORD=$c psql -h 127.0.0.1 -U $u -d $b -tAc 'SELECT 1' >/dev/null 2>&1
          then echo "$u $b"; fi
        done
      done`;
    const accesos = docker('exec', `${proyecto}-postgres-1`, 'sh', '-c', script).split('\n');
    expect(accesos.sort()).toEqual(
      Object.entries(BASES)
        .map(([u, b]) => `${u} ${b}`)
        .sort(),
    );
  });

  it('leer la base de otro servicio falla por permisos', () => {
    let error = '';
    try {
      docker(
        'exec',
        `${proyecto}-postgres-1`,
        'sh',
        '-c',
        'PGPASSWORD=$CLAVE_BD_USUARIOS psql -h 127.0.0.1 -U usuarios -d autenticacion -c "SELECT * FROM migraciones"',
      );
    } catch (e) {
      error = String((e as { stderr?: string }).stderr);
    }
    expect(error).toContain('permission denied for database "autenticacion"');
  });

  it('la read replica de Viajes está en standby y recibe los datos de la principal (ADR-012)', () => {
    const principal = `${proyecto}-postgres-viajes-1`;
    const replica = `${proyecto}-postgres-viajes-replica-1`;
    expect(psql(principal, 'postgres', 'SELECT pg_is_in_recovery()')).toBe('f');
    expect(psql(replica, 'postgres', 'SELECT pg_is_in_recovery()')).toBe('t');
    expect(psql(principal, 'postgres', 'SELECT state FROM pg_stat_replication')).toBe('streaming');
    // Las migraciones que Viajes corrió en la principal están en la réplica.
    expect(Number(psql(replica, 'viajes', 'SELECT count(*) FROM migraciones'))).toBeGreaterThan(0);
    // Y la réplica no acepta escrituras.
    expect(() => psql(replica, 'viajes', 'CREATE TABLE prueba (id int)')).toThrow();
  });
});

describe.skipIf(arriba.length < 2)('regiones aisladas (CONST-6)', () => {
  const pares: [Proyecto, Proyecto][] = [
    ['r1', 'r2'],
    ['r2', 'r1'],
  ];

  it.each(pares)(
    'desde %s no se llega a las bases, el broker ni la cache de %s',
    (desde, hacia) => {
      const destinos = Object.entries(DATOS).flatMap(([servicio, puerto]) =>
        ips(`${hacia}-${servicio}-1`).map((ip): [string, number] => [ip, puerto]),
      );
      expect(destinos.length).toBeGreaterThanOrEqual(5);
      // analitica está también en la red global; gateway solo en la de su región.
      for (const servicio of ['analitica', 'gateway']) {
        const resultado = probarConexiones(`${desde}-${servicio}-1`, destinos);
        expect(resultado, `${desde}-${servicio}-1`).toEqual(destinos.map(() => 'sin-acceso'));
      }
    },
  );

  it.each(pares)('%s sí llega a sus propias bases y a la base de analítica global', (desde) => {
    const propias = Object.entries(DATOS).map(([s, p]): [string, number] => [s, p]);
    expect(
      probarConexiones(`${desde}-analitica-1`, [...propias, ['postgres-analitica', 5432]]),
    ).toEqual([...propias, 0].map(() => 'conecta'));
  });

  it('el nombre "postgres" se resuelve a la base de la propia región', () => {
    const codigo = `require('node:dns').promises.lookup('postgres', { all: true })
      .then((a) => console.log(JSON.stringify(a.map((x) => x.address))))`;
    const resuelto = JSON.parse(docker('exec', 'r1-analitica-1', 'node', '-e', codigo)) as string[];
    expect(resuelto).toEqual(ips('r1-postgres-1'));
  });
});
