// Pruebas de los archivos de docker compose sin levantarlos (corren en CI). Las pruebas con todo
// levantado están en tests/e2e/infra.test.ts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { leerEnv } from './entorno.ts';

interface Servicio {
  build?: { dockerfile: string };
  networks?: string[] | Record<string, unknown>;
  ports?: string[];
  environment?: Record<string, string>;
  deploy?: { replicas: number };
  volumes?: string[];
  labels?: Record<string, string>;
  profiles?: string[];
}
interface Compose {
  services: Record<string, Servicio>;
}

const raiz = fileURLToPath(new URL('../../', import.meta.url));
const textoRegion = readFileSync(join(raiz, 'infra/region.compose.yaml'), 'utf8');
const textoGlobal = readFileSync(join(raiz, 'infra/global.compose.yaml'), 'utf8');
const region = parse(textoRegion, { merge: true }) as Compose;
const global = parse(textoGlobal, { merge: true }) as Compose;
const redes = (s: Servicio) =>
  Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {});
const DATOS = /^(postgres|redis|rabbitmq)/;

describe('region.compose.yaml', () => {
  it('tiene cada servicio de services/ con su Dockerfile (menos el enrutador, que es global)', () => {
    const servicios = readdirSync(join(raiz, 'services')).filter(
      (s) => s !== 'enrutador' && existsSync(join(raiz, 'services', s, 'Dockerfile')),
    );
    expect(servicios).toHaveLength(9);
    expect(region.services.enrutador).toBeUndefined();
    for (const nombre of servicios) {
      expect(region.services[nombre]?.build?.dockerfile).toBe(`services/${nombre}/Dockerfile`);
    }
  });

  it('las bases, el broker y la cache están solo en la red de la región (CONST-6)', () => {
    const datos = Object.entries(region.services).filter(([nombre]) => DATOS.test(nombre));
    expect(datos.length).toBeGreaterThanOrEqual(7);
    for (const [, servicio] of datos) expect(redes(servicio)).toEqual(['region']);
  });

  it('en la red global solo están nginx, analitica, correo e integraciones', () => {
    const enGlobal = Object.entries(region.services)
      .filter(([, s]) => redes(s).includes('global'))
      .map(([nombre]) => nombre)
      .sort();
    expect(enGlobal).toEqual(['analitica', 'correo', 'integraciones', 'nginx']);
  });

  it('solo nginx publica un puerto, y el gateway arranca con 2 instancias', () => {
    const conPuertos = Object.entries(region.services).filter(([, s]) => s.ports);
    expect(conPuertos.map(([nombre]) => nombre)).toEqual(['nginx']);
    expect(region.services.gateway?.deploy?.replicas).toBe(2);
  });

  it('cada servicio usa una base creada para su propio usuario (ADR-001)', () => {
    const bases = new Map<string, string>();
    for (const [host, servicio] of Object.entries(region.services)) {
      for (const par of (servicio.environment?.BASES ?? '').split(/\s+/).filter(Boolean)) {
        const [base, usuario] = par.split(':');
        bases.set(`${host}/${base ?? ''}`, usuario ?? '');
        // La contraseña del usuario llega al servidor que crea la base.
        expect(servicio.environment?.[`CLAVE_BD_${(usuario ?? '').toUpperCase()}`]).toBeDefined();
      }
    }
    for (const [nombre, servicio] of Object.entries(region.services)) {
      const url = servicio.environment?.URL_BASE;
      if (!url) continue;
      const [, usuario, host, base] =
        /^postgres:\/\/([^:]+):[^@]+@([^:]+):5432\/(.+)$/.exec(url) ?? [];
      expect(bases.get(`${host ?? ''}/${base ?? ''}`), nombre).toBe(usuario);
    }
  });

  it('solo el monitor tiene el socket de Docker, y sabe qué proyecto vigilar (ADR-007)', () => {
    const conSocket = Object.entries(region.services)
      .filter(([, s]) => (s.volumes ?? []).some((v) => v.startsWith('/var/run/docker.sock:')))
      .map(([nombre]) => nombre);
    expect(conSocket).toEqual(['monitor']);
    expect(region.services.monitor?.environment?.PROYECTO_DOCKER).toBe('${COMPOSE_PROJECT_NAME:?}');
  });

  it('nginx deja de mandar al gateway caído: max_fails=3 y fail_timeout=15s (ADR-008)', () => {
    const plantilla = readFileSync(join(raiz, 'infra/nginx/region.conf.template'), 'utf8');
    expect(plantilla).toMatch(/server gateway:3000 resolve max_fails=3 fail_timeout=15s;/);
  });

  it('RabbitMQ: un nodo por defecto y dos más con el perfil ha', () => {
    const nodos = Object.entries(region.services).filter(([n]) => n.startsWith('rabbitmq'));
    expect(nodos.map(([n, s]) => [n, s.profiles ?? []])).toEqual([
      ['rabbitmq', []],
      ['rabbitmq-2', ['ha']],
      ['rabbitmq-3', ['ha']],
    ]);
  });
});

describe('global.compose.yaml', () => {
  it('la base de analítica está solo en la red global', () => {
    expect(redes(global.services['postgres-analitica'] ?? {})).toEqual(['global']);
  });

  it('el enrutador global publica el 8000 y llega al nginx de cada región por la red global', () => {
    const enrutador = global.services.enrutador ?? {};
    expect(enrutador.build?.dockerfile).toBe('services/enrutador/Dockerfile');
    expect(redes(enrutador)).toEqual(['global']);
    expect(enrutador.ports).toEqual(['${PUERTO_ENRUTADOR:-8000}:8000']);
    expect(enrutador.environment).toMatchObject({
      URL_REGION_1: 'http://nginx-region-1:8080',
      URL_REGION_2: 'http://nginx-region-2:8080',
    });
    // Las bases no se publican: solo el enrutador y los mocks que abre el navegador.
    const conPuertos = Object.entries(global.services).filter(([, s]) => s.ports);
    expect(conPuertos.map(([nombre]) => nombre)).toEqual(['enrutador', 'mock-gmail']);
  });

  it('el mock de Gmail publica el 4001 y manda los avisos de cada región por el enrutador', () => {
    const gmail = global.services['mock-gmail'] ?? {};
    expect(gmail.build?.dockerfile).toBe('mocks/gmail/Dockerfile');
    expect(redes(gmail)).toEqual(['global']);
    expect(gmail.ports).toEqual(['${PUERTO_MOCK_GMAIL:-4001}:4001']);
    const avisos = gmail.environment?.SUSCRIPCIONES_PUSH ?? '';
    for (const region of ['region-1', 'region-2']) {
      expect(avisos).toContain(
        `gmail-avisos-${region}=http://enrutador:8000/${region}/api/correo/notificaciones/gmail?token=`,
      );
    }
  });
});

describe('variables', () => {
  it('cada ${VARIABLE} de los compose está en .env.example o la pone infra.ts', () => {
    const ejemplo = leerEnv(readFileSync(join(raiz, '.env.example'), 'utf8'));
    const deInfra = [
      'REGION',
      'OTRA_REGION',
      'PUERTO_NGINX',
      'PUERTO_NGINX_OTRA_REGION',
      'JWT_CLAVE_PRIVADA',
      // La pone docker compose con -p (r1 o r2).
      'COMPOSE_PROJECT_NAME',
    ];
    const usadas = [...`${textoRegion}\n${textoGlobal}`.matchAll(/\$\{([A-Z0-9_]+)/g)].map(
      (m) => m[1],
    );
    const faltan = [...new Set(usadas)].filter((v) => v && !(v in ejemplo) && !deInfra.includes(v));
    expect(faltan).toEqual([]);
  });
});
