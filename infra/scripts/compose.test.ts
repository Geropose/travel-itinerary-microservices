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
  it('tiene cada servicio de services/ con su Dockerfile', () => {
    const servicios = readdirSync(join(raiz, 'services')).filter((s) =>
      existsSync(join(raiz, 'services', s, 'Dockerfile')),
    );
    expect(servicios).toHaveLength(9);
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
});

describe('variables', () => {
  it('cada ${VARIABLE} de los compose está en .env.example o la pone infra.ts', () => {
    const ejemplo = leerEnv(readFileSync(join(raiz, '.env.example'), 'utf8'));
    const deInfra = ['REGION', 'PUERTO_NGINX', 'JWT_CLAVE_PRIVADA'];
    const usadas = [...`${textoRegion}\n${textoGlobal}`.matchAll(/\$\{([A-Z0-9_]+)/g)].map(
      (m) => m[1],
    );
    const faltan = [...new Set(usadas)].filter((v) => v && !(v in ejemplo) && !deInfra.includes(v));
    expect(faltan).toEqual([]);
  });
});
