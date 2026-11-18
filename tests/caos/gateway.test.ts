// Caos (QA-4, ADR-006 a ADR-008): se mata una instancia del gateway de r1 con docker kill. Las
// solicitudes tienen que seguir respondiendo (la otra instancia atiende y nginx deja de mandarle a
// la caída) y el monitor de salud la tiene que detectar en 15 s o menos (3 pings de 5 s) y
// reiniciarla. Necesita r1 levantada: npm run infra:levantar, después npm run caos.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { leerEnv } from '../../infra/scripts/entorno.ts';

const exec = promisify(execFile);
const env = leerEnv(readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8'));
const r1 = `http://localhost:${env.PUERTO_NGINX_REGION_1}`;
const VICTIMA = 'r1-gateway-1';
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tolerancia por la diferencia entre el reloj de esta máquina y el del monitor (Docker). */
const MARGEN_RELOJ_MS = 1000;

async function docker(...args: string[]): Promise<string> {
  return (await exec('docker', args, { encoding: 'utf8' })).stdout.trim();
}

async function arriba(nombre: string): Promise<boolean> {
  try {
    return (await docker('ps', '-q', '--filter', `name=^${nombre}$`)) !== '';
  } catch {
    return false;
  }
}

interface InstanciaMonitor {
  nombre: string;
  estado: string;
  caidaDetectadaEn?: string;
  reinicios: number;
}

/** GET /estado del monitor de r1, desde adentro de su contenedor (no se publica). */
async function estadoMonitor(): Promise<InstanciaMonitor[]> {
  const salida = await docker(
    'exec',
    'r1-monitor-1',
    'node',
    '-e',
    "fetch('http://127.0.0.1:3010/estado').then((r) => r.text()).then(console.log)",
  );
  return (JSON.parse(salida) as { instancias: InstanciaMonitor[] }).instancias;
}

async function victima(): Promise<InstanciaMonitor | undefined> {
  return (await estadoMonitor()).find((i) => i.nombre === VICTIMA);
}

const hayRegion = (await arriba(VICTIMA)) && (await arriba('r1-monitor-1'));

describe.skipIf(!hayRegion)('caos: se cae una instancia del gateway', () => {
  it('las solicitudes siguen respondiendo y el monitor la detecta en 15 s o menos y la reinicia', async () => {
    // El monitor ya la ve sana antes de empezar.
    let antes = await victima();
    for (let i = 0; i < 30 && antes?.estado !== 'sana'; i++) {
      await esperar(1000);
      antes = await victima();
    }
    expect(antes?.estado).toBe('sana');

    // Tráfico continuo contra el nginx de r1 mientras dura la prueba.
    const estados: number[] = [];
    let seguir = true;
    const trafico = (async () => {
      while (seguir) {
        const status = await fetch(`${r1}/api/autenticacion/.well-known/jwks.json`, {
          signal: AbortSignal.timeout(5000),
        })
          .then((r) => r.status)
          .catch(() => 0);
        estados.push(status);
        await esperar(100);
      }
    })();

    const inicio = Date.now();
    await docker('kill', VICTIMA);

    // El monitor la marca caída (3 pings sin respuesta).
    let detectada: InstanciaMonitor | undefined;
    while (Date.now() - inicio < 30_000) {
      const actual = await victima();
      if (actual?.caidaDetectadaEn && actual.caidaDetectadaEn !== antes?.caidaDetectadaEn) {
        detectada = actual;
        break;
      }
      await esperar(250);
    }
    expect(detectada, 'el monitor no la detectó en 30 s').toBeDefined();
    const demora = Date.parse(detectada?.caidaDetectadaEn ?? '') - inicio;
    expect(demora).toBeLessThanOrEqual(15_000 + MARGEN_RELOJ_MS);
    expect(detectada?.reinicios).toBe((antes?.reinicios ?? 0) + 1);

    // La reinicia y vuelve a estar sana.
    let despues = await victima();
    while (despues?.estado !== 'sana' && Date.now() - inicio < 90_000) {
      await esperar(1000);
      despues = await victima();
    }
    expect(despues?.estado).toBe('sana');
    expect(await arriba(VICTIMA)).toBe(true);

    seguir = false;
    await trafico;
    // Ninguna solicitud falló mientras la instancia estaba caída.
    expect(estados.length).toBeGreaterThan(50);
    expect(estados.filter((s) => s !== 200)).toEqual([]);
    process.stdout.write(
      `Detectada en ${(demora / 1000).toFixed(1)} s; ${estados.length} solicitudes, todas 200.\n`,
    );
  });
});
