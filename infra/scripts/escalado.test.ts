import { describe, expect, it } from 'vitest';
import {
  decidir,
  leerPs,
  leerStats,
  minimoDe,
  pasoEscalar,
  usosPorServicio,
  type Memoria,
  type Uso,
} from './escalado.ts';

const uso = (u: Partial<Uso>): Uso => ({
  proyecto: 'r1',
  servicio: 'viajes',
  instancias: 2,
  cpu: 50,
  ha: false,
  ...u,
});
const MIN = 60_000;

describe('decidir (ADR-006 y ADR-008)', () => {
  it('con más del 70 % de procesador agrega una instancia', () => {
    expect(decidir([uso({ cpu: 85 })], new Map(), 0)).toMatchObject([
      { proyecto: 'r1', servicio: 'viajes', desde: 2, hasta: 3 },
    ]);
  });

  it('entre 30 % y 70 % no cambia nada', () => {
    expect(decidir([uso({ cpu: 50 })], new Map(), 0)).toEqual([]);
  });

  it('con menos del 30 % saca una recién a los 2 minutos seguidos', () => {
    const memoria: Memoria = new Map();
    expect(decidir([uso({ cpu: 10 })], memoria, 0)).toEqual([]);
    expect(decidir([uso({ cpu: 10 })], memoria, 1.5 * MIN)).toEqual([]);
    expect(decidir([uso({ cpu: 10 })], memoria, 2 * MIN)).toMatchObject([{ desde: 2, hasta: 1 }]);
    // Los 2 minutos se vuelven a contar para la siguiente.
    expect(decidir([uso({ cpu: 10, instancias: 3 })], memoria, 2.5 * MIN)).toEqual([]);
  });

  it('si sube en el medio, los 2 minutos empiezan de nuevo', () => {
    const memoria: Memoria = new Map();
    decidir([uso({ cpu: 10 })], memoria, 0);
    decidir([uso({ cpu: 50 })], memoria, 1 * MIN);
    expect(decidir([uso({ cpu: 10 })], memoria, 2 * MIN)).toEqual([]);
    expect(decidir([uso({ cpu: 10 })], memoria, 4 * MIN)).toMatchObject([{ hasta: 1 }]);
  });

  it('nunca baja del mínimo: 1, 2 del gateway y 3 con el perfil ha', () => {
    expect(minimoDe('viajes', false)).toBe(1);
    expect(minimoDe('gateway', false)).toBe(2);
    expect(minimoDe('viajes', true)).toBe(3);
    expect(minimoDe('gateway', true)).toBe(3);
    const memoria: Memoria = new Map();
    decidir([uso({ cpu: 1, instancias: 3, ha: true })], memoria, 0);
    expect(decidir([uso({ cpu: 1, instancias: 3, ha: true })], memoria, 10 * MIN)).toEqual([]);
  });

  it('con el perfil ha y menos de 3 instancias, sube a 3', () => {
    expect(decidir([uso({ instancias: 1, ha: true })], new Map(), 0)).toMatchObject([
      { desde: 1, hasta: 3 },
    ]);
  });

  it('no pasa del máximo', () => {
    expect(decidir([uso({ cpu: 99, instancias: 10 })], new Map(), 0)).toEqual([]);
  });
});

describe('lectura de docker ps y docker stats', () => {
  it('promedia el procesador de las instancias de cada servicio escalable', () => {
    const contenedores = leerPs(
      [
        'r1-gateway-1|r1|gateway',
        'r1-gateway-2|r1|gateway',
        'r1-nginx-1|r1|nginx',
        'r1-monitor-1|r1|monitor',
        'r2-viajes-1|r2|viajes',
        '',
      ].join('\n'),
    );
    const cpu = leerStats('r1-gateway-1|80.5%\nr1-gateway-2|60.5%\nr1-nginx-1|99%\nbasura\n');
    expect(usosPorServicio(contenedores, cpu, new Set(['r2']))).toEqual([
      { proyecto: 'r1', servicio: 'gateway', instancias: 2, cpu: 70.5, ha: false },
      { proyecto: 'r2', servicio: 'viajes', instancias: 1, cpu: 0, ha: true },
    ]);
  });
});

describe('pasoEscalar', () => {
  it('escala solo ese servicio con docker compose --scale, con el entorno de la región', () => {
    const paso = pasoEscalar(
      { proyecto: 'r2', servicio: 'viajes', desde: 3, hasta: 4, motivo: 'prueba' },
      { PUERTO_NGINX_REGION_2: '8082' },
      true,
    );
    expect(paso?.args).toEqual([
      'compose',
      '-p',
      'r2',
      '-f',
      'infra/region.compose.yaml',
      '--env-file',
      '.env',
      '--profile',
      'ha',
      'up',
      '-d',
      '--no-deps',
      '--no-recreate',
      '--scale',
      'viajes=4',
      'viajes',
    ]);
    expect(paso?.entorno).toMatchObject({ REGION: 'region-2', PUERTO_NGINX: '8082' });
  });

  it('un proyecto que no es una región no se toca', () => {
    expect(
      pasoEscalar({ proyecto: 'global', servicio: 'x', desde: 1, hasta: 2, motivo: '' }, {}, false),
    ).toBeUndefined();
  });
});
