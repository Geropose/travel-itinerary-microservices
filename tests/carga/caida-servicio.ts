// QA-4: qué ve el resto de la región cuando un servicio entero deja de responder (P4.1).
//
// Iteración 1, Paso 7: "la caída de una [instancia] no corta el servicio". En el prototipo cada
// servicio tiene una sola instancia, así que detenerla deja sin ese servicio. Lo que se mide acá es
// si la falla queda aislada en ese servicio (microservicios, ADR-001) o si afecta a otros.
//
// Detiene r1-viajes-1 (con el monitor de salud en pausa para que no la reinicie) y mientras tanto
// pide cada 200 ms el panel (depende de Viajes) y una ruta de Autenticación (no depende de Viajes).
//
// Uso: node tests/carga/caida-servicio.ts [--servicio viajes] [--segundos 30]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { leerEnv } from '../../infra/scripts/entorno.ts';
import { duracion } from './calculos.ts';
import {
  argumento,
  CONFIG_E2E,
  escribir,
  esperar,
  idAleatorio,
  registrarYLogin,
  sistemaDisponible,
} from './comun.ts';

const env = leerEnv(readFileSync(new URL('../../.env', import.meta.url), 'utf8'));
const URL_R1 = `http://localhost:${env.PUERTO_NGINX_REGION_1 ?? '8081'}`;
const servicio = argumento('servicio', 'viajes');
const segundos = Number(argumento('segundos', '30'));
const contenedor = `r1-${servicio}-1`;

if (!(await sistemaDisponible())) {
  escribir('El sistema no está levantado: corré npm run infra:levantar.');
  process.exit(1);
}

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' });
const sesion = await registrarYLogin({ nombre: `Viajero Caida ${idAleatorio()}` });

/** Momentos (ms desde el inicio) y status de cada respuesta que no fue 200. */
function iniciarSonda(url: string, headers: Record<string, string>, inicio: number) {
  const fallas: { momento: number; status: number }[] = [];
  let total = 0;
  let activa = true;
  const bucle = (async () => {
    while (activa) {
      const status = await fetch(url, { headers, signal: AbortSignal.timeout(4000) })
        .then(async (r) => {
          await r.body?.cancel();
          return r.status;
        })
        .catch(() => 0);
      total += 1;
      if (status !== 200) fallas.push({ momento: Date.now() - inicio, status });
      await esperar(200);
    }
  })();
  return {
    async detener() {
      activa = false;
      await bucle;
      return { total, fallas };
    },
  };
}

function describir({
  total,
  fallas,
}: {
  total: number;
  fallas: { momento: number; status: number }[];
}) {
  if (fallas.length === 0) return `${total} solicitudes, 0 errores`;
  const porStatus = new Map<number, number>();
  for (const f of fallas) porStatus.set(f.status, (porStatus.get(f.status) ?? 0) + 1);
  const detalle = [...porStatus].map(([s, n]) => `${n} × ${s === 0 ? 'sin respuesta' : s}`);
  return `${total} solicitudes, ${fallas.length} errores (${detalle.join(', ')}) entre ${duracion(fallas[0]?.momento ?? 0)} y ${duracion(fallas.at(-1)?.momento ?? 0)}`;
}

const inicio = Date.now();
const panel = iniciarSonda(
  `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
  { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
  inicio,
);
const otraRuta = iniciarSonda(`${URL_R1}/api/autenticacion/.well-known/jwks.json`, {}, inicio);
await esperar(3000);

let detenido: number;
let vuelto: number;
try {
  docker('pause', 'r1-monitor-1');
  detenido = Date.now() - inicio;
  docker('stop', contenedor);
  await esperar(segundos * 1000);
} finally {
  docker('start', contenedor);
  vuelto = Date.now() - inicio;
  docker('unpause', 'r1-monitor-1');
}
await esperar(25_000);
const [sondaPanel, sondaOtra] = await Promise.all([panel.detener(), otraRuta.detener()]);

escribir(
  `QA-4: ${contenedor} detenido ${segundos} s (de ${duracion(detenido)} a ${duracion(vuelto)})`,
);
escribir(`  Panel (depende de ${servicio}):              ${describir(sondaPanel)}`);
escribir(`  Autenticación (no depende de ${servicio}):   ${describir(sondaOtra)}`);
escribir(
  JSON.stringify({
    servicio,
    segundos,
    detenidoMs: detenido,
    vueltoMs: vuelto,
    panel: sondaPanel,
    otraRuta: sondaOtra,
  }),
);
