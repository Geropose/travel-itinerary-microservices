import { loggerDePrueba } from '@trotamundos/comun/pruebas';
import { describe, expect, it } from 'vitest';
import { aInstancias, type ClienteDocker, type Instancia } from '../src/docker.ts';
import { crearVigilante } from '../src/vigilante.ts';

/** Docker falso: las instancias se cambian a mano y se anotan los reinicios. */
function dockerFalso(instancias: Instancia[]) {
  const reiniciados: string[] = [];
  let fallaReinicio = false;
  const docker: ClienteDocker = {
    listar: async () => instancias,
    reiniciar: async (id) => {
      reiniciados.push(id);
      if (fallaReinicio) throw new Error('Docker no pudo');
    },
  };
  return {
    docker,
    reiniciados,
    fallarReinicio: () => {
      fallaReinicio = true;
    },
  };
}

const instancia = (n: number): Instancia => ({
  id: `id-${n}`,
  nombre: `r1-gateway-${n}`,
  servicio: 'gateway',
  corriendo: true,
  url: `http://10.0.0.${n}:3000`,
});

/** Vigilante con reloj y ping falsos: cada ciclo avanza 5 s. */
function preparar(instancias: Instancia[]) {
  const falso = dockerFalso(instancias);
  const { logger, lineas } = loggerDePrueba('monitor');
  const caidas = new Set<string>();
  let reloj = Date.parse('2026-11-20T13:45:00Z');
  const vigilante = crearVigilante({
    docker: falso.docker,
    logger,
    graciaReinicioMs: 20_000,
    ping: async (url) => !caidas.has(url),
    ahora: () => new Date(reloj),
  });
  const ciclo = async () => {
    await vigilante.ciclo();
    reloj += 5000;
  };
  const de = (nombre: string) => vigilante.estado().instancias.find((i) => i.nombre === nombre);
  return { ...falso, vigilante, caidas, ciclo, de, lineas };
}

describe('ping-echo del monitor (ADR-007)', () => {
  it('una instancia sana queda sana y no se reinicia', async () => {
    const p = preparar([instancia(1)]);
    await p.ciclo();
    await p.ciclo();
    expect(p.de('r1-gateway-1')).toMatchObject({ estado: 'sana', fallasSeguidas: 0, reinicios: 0 });
    expect(p.reiniciados).toEqual([]);
    expect(p.vigilante.estado().actualizadoEn).not.toBeNull();
  });

  it('con 3 pings seguidos sin respuesta (15 s) la marca caída, la reinicia y lo registra', async () => {
    const p = preparar([instancia(1), instancia(2)]);
    await p.ciclo();
    p.caidas.add('http://10.0.0.1:3000');
    await p.ciclo();
    expect(p.de('r1-gateway-1')).toMatchObject({ estado: 'sin-respuesta', fallasSeguidas: 1 });
    await p.ciclo();
    expect(p.reiniciados).toEqual([]);
    await p.ciclo();
    expect(p.reiniciados).toEqual(['id-1']);
    expect(p.de('r1-gateway-1')).toMatchObject({
      estado: 'reiniciando',
      reinicios: 1,
      caidaDetectadaEn: '2026-11-20T13:45:15.000Z',
      ultimoReinicio: '2026-11-20T13:45:15.000Z',
    });
    // La otra instancia no se toca.
    expect(p.de('r1-gateway-2')).toMatchObject({ estado: 'sana', reinicios: 0 });
    expect(p.lineas).toContainEqual(
      expect.objectContaining({ nivel: 'warn', mensaje: 'Instancia caída: se reinicia' }),
    );
  });

  it('una instancia detenida (sin URL) cuenta como sin respuesta', async () => {
    const detenida = { ...instancia(1), corriendo: false, url: undefined };
    const p = preparar([detenida]);
    await p.ciclo();
    await p.ciclo();
    await p.ciclo();
    expect(p.reiniciados).toEqual(['id-1']);
  });

  it('después de reiniciarla le da tiempo para arrancar y vuelve a sana cuando responde', async () => {
    const p = preparar([instancia(1)]);
    p.caidas.add('http://10.0.0.1:3000');
    for (let i = 0; i < 3; i++) await p.ciclo();
    expect(p.reiniciados).toHaveLength(1);
    // Durante la gracia (20 s) no cuenta fallas ni la vuelve a reiniciar.
    for (let i = 0; i < 3; i++) await p.ciclo();
    expect(p.de('r1-gateway-1')).toMatchObject({ estado: 'reiniciando', fallasSeguidas: 0 });
    expect(p.reiniciados).toHaveLength(1);
    p.caidas.clear();
    await p.ciclo();
    expect(p.de('r1-gateway-1')).toMatchObject({ estado: 'sana', reinicios: 1 });
    expect(p.lineas).toContainEqual(expect.objectContaining({ mensaje: 'La instancia volvió' }));
  });

  it('si después de la gracia sigue sin responder, la vuelve a reiniciar', async () => {
    const p = preparar([instancia(1)]);
    p.caidas.add('http://10.0.0.1:3000');
    // 3 fallas, 4 ciclos de gracia (hasta 20 s), 3 fallas más.
    for (let i = 0; i < 3 + 4 + 3; i++) await p.ciclo();
    expect(p.reiniciados).toHaveLength(2);
  });

  it('si Docker no la puede reiniciar, queda caída y se registra el error', async () => {
    const p = preparar([instancia(1)]);
    p.fallarReinicio();
    p.caidas.add('http://10.0.0.1:3000');
    for (let i = 0; i < 3; i++) await p.ciclo();
    await new Promise((r) => setTimeout(r, 0));
    expect(p.de('r1-gateway-1')?.estado).toBe('caida');
    expect(p.lineas).toContainEqual(
      expect.objectContaining({ nivel: 'error', mensaje: 'No se pudo reiniciar la instancia' }),
    );
  });

  it('las instancias que ya no existen dejan de aparecer', async () => {
    const instancias = [instancia(1), instancia(2)];
    const p = preparar(instancias);
    await p.ciclo();
    instancias.pop();
    await p.ciclo();
    expect(p.vigilante.estado().instancias.map((i) => i.nombre)).toEqual(['r1-gateway-1']);
  });

  it('si Docker no responde, el ciclo no se rompe', async () => {
    const { logger, lineas } = loggerDePrueba('monitor');
    const vigilante = crearVigilante({
      docker: {
        listar: () => Promise.reject(new Error('sin socket')),
        reiniciar: async () => undefined,
      },
      logger,
    });
    await expect(vigilante.ciclo()).resolves.toBeUndefined();
    expect(lineas).toContainEqual(
      expect.objectContaining({ nivel: 'error', mensaje: 'No se pudo consultar a Docker' }),
    );
  });
});

describe('aInstancias', () => {
  it('toma los servicios con /health, con la IP de la red de la región', () => {
    const instancias = aInstancias(
      [
        {
          Id: 'b',
          Names: ['/r1-gateway-2'],
          State: 'running',
          Labels: { 'trotamundos.servicio': 'gateway' },
          NetworkSettings: {
            Networks: { r1_region: { IPAddress: '172.20.0.5' }, otra: { IPAddress: '10.9.9.9' } },
          },
        },
        {
          Id: 'a',
          Names: ['/r1-viajes-1'],
          State: 'exited',
          Labels: { 'trotamundos.servicio': 'viajes' },
          NetworkSettings: { Networks: {} },
        },
        {
          Id: 'c',
          Names: ['/r1-nginx-1'],
          State: 'running',
          Labels: { 'trotamundos.servicio': 'nginx' },
        },
      ],
      'r1',
    );
    expect(instancias).toEqual([
      {
        id: 'b',
        nombre: 'r1-gateway-2',
        servicio: 'gateway',
        corriendo: true,
        url: 'http://172.20.0.5:3000',
      },
      { id: 'a', nombre: 'r1-viajes-1', servicio: 'viajes', corriendo: false, url: undefined },
    ]);
  });
});
