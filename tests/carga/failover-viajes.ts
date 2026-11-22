// QA-4: caída de la base principal de Viajes y promoción de la read replica (P4.1).
//
// Iteración 4, Paso 7: "Caída de la base principal: la réplica pasa a principal en 1 min."
// Iteración 6, Paso 7: la read replica está en el otro centro de datos de la misma región.
//
// La prueba 4 de tests/caos/disponibilidad.test.ts hace lo mismo, pero corta en el primer error.
// Este script mide de punta a punta, sin cortar, con dos sondas cada 200 ms mientras dura la falla:
// - el panel (GET /api/viajes/panel), que depende de Viajes;
// - una ruta que no depende de Viajes (GET /api/autenticacion/.well-known/jwks.json), para ver si
//   la falla de Viajes afecta al resto de la región.
// Después de promover la réplica, escribe una reserva cada 500 ms hasta que lo acepte.
//
// Uso: node tests/carga/failover-viajes.ts   (con npm run infra:levantar; restaura todo al final)
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { leerEnv } from '../../infra/scripts/entorno.ts';
import {
  ejecutarFailoverViajes,
  restaurarPrincipalViajes,
} from '../../infra/scripts/failover-viajes.ts';
import { duracion } from './calculos.ts';
import {
  CONFIG_E2E,
  eliminarReservasUsuario,
  escribir,
  esperar,
  idAleatorio,
  registrarYLogin,
  sistemaDisponible,
} from './comun.ts';

const env = leerEnv(readFileSync(new URL('../../.env', import.meta.url), 'utf8'));
const URL_R1 = `http://localhost:${env.PUERTO_NGINX_REGION_1 ?? '8081'}`;

if (!(await sistemaDisponible())) {
  escribir('El sistema no está levantado: corré npm run infra:levantar.');
  process.exit(1);
}

interface Sonda {
  total: number;
  errores: number;
  primerError?: number;
  ultimoError?: number;
  estados: Map<number, number>;
}

/** Pide `url` cada 200 ms y anota cuántas respuestas no fueron 200 y entre qué momentos. */
function iniciarSonda(url: string, headers: Record<string, string>, inicio: number) {
  const sonda: Sonda = { total: 0, errores: 0, estados: new Map() };
  let activa = true;
  const bucle = (async () => {
    while (activa) {
      const status = await fetch(url, { headers, signal: AbortSignal.timeout(4000) })
        .then(async (r) => {
          await r.body?.cancel();
          return r.status;
        })
        .catch(() => 0);
      sonda.total += 1;
      if (status !== 200) {
        const momento = Date.now() - inicio;
        sonda.errores += 1;
        sonda.primerError ??= momento;
        sonda.ultimoError = momento;
        sonda.estados.set(status, (sonda.estados.get(status) ?? 0) + 1);
      }
      await esperar(200);
    }
  })();
  return {
    async detener(): Promise<Sonda> {
      activa = false;
      await bucle;
      return sonda;
    },
  };
}

const describir = (s: Sonda) =>
  s.errores === 0
    ? `${s.total} solicitudes, 0 errores`
    : `${s.total} solicitudes, ${s.errores} errores (${[...s.estados]
        .map(([status, n]) => `${n} × ${status === 0 ? 'sin respuesta' : status}`)
        .join(', ')}) entre ${duracion(s.primerError ?? 0)} y ${duracion(s.ultimoError ?? 0)}`;

const sesion = await registrarYLogin({ nombre: `Viajero Failover ${idAleatorio()}` });
const cabeceras = { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region };

/** Intenta guardar una reserva manual; devuelve el status HTTP. */
async function escribirReserva(): Promise<number> {
  return fetch(`${CONFIG_E2E.urlEnrutador}/api/viajes/reservas`, {
    method: 'POST',
    headers: { ...cabeceras, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proveedor: 'hotel-cordillera',
      tipoReserva: 'hotel',
      numeroReserva: `FO-${idAleatorio()}`,
      inicio: '2026-12-28T15:00:00Z',
      fin: '2026-12-29T11:00:00Z',
      destino: 'Santiago',
    }),
    signal: AbortSignal.timeout(4000),
  })
    .then((r) => r.status)
    .catch(() => 0);
}

try {
  if ((await escribirReserva()) !== 201) throw new Error('No se pudo guardar la reserva inicial.');
  await esperar(2000);

  const inicio = Date.now();
  const panel = iniciarSonda(`${CONFIG_E2E.urlEnrutador}/api/viajes/panel`, cabeceras, inicio);
  const otraRuta = iniciarSonda(`${URL_R1}/api/autenticacion/.well-known/jwks.json`, {}, inicio);
  await esperar(3000);

  // Falla: se detiene la base principal de Viajes (centro de datos A).
  const caida = Date.now();
  execFileSync('docker', ['stop', 'r1-postgres-viajes-1']);
  const failover = await ejecutarFailoverViajes('r1', env);
  const promovida = Date.now();

  // Primera escritura aceptada después de la promoción.
  let escritura = NaN;
  let intentos = 0;
  while (Date.now() - promovida < 120_000) {
    intentos += 1;
    if ((await escribirReserva()) === 201) {
      escritura = Date.now();
      break;
    }
    await esperar(500);
  }
  await esperar(20_000);
  const [sondaPanel, sondaOtra] = await Promise.all([panel.detener(), otraRuta.detener()]);

  escribir('QA-4: caída de la base principal de Viajes (r1) y promoción de la read replica');
  escribir(`  Promoción (npm run infra:failover-viajes): ${duracion(failover.duracionMs)}`);
  escribir(`  Réplica en recuperación después:            ${failover.enRecuperacionDespues}`);
  escribir(
    `  Primera escritura aceptada:                 ${duracion(escritura - caida)} desde la caída (${intentos} intentos después de promover)`,
  );
  escribir(`  Panel (depende de Viajes):                  ${describir(sondaPanel)}`);
  escribir(`  Autenticación (no depende de Viajes):       ${describir(sondaOtra)}`);
  escribir(
    JSON.stringify({
      promocionMs: failover.duracionMs,
      primeraEscrituraMs: escritura - caida,
      caidaEnMs: caida - inicio,
      panel: { ...sondaPanel, estados: Object.fromEntries(sondaPanel.estados) },
      otraRuta: { ...sondaOtra, estados: Object.fromEntries(sondaOtra.estados) },
    }),
  );
} finally {
  await restaurarPrincipalViajes('r1', env);
  await eliminarReservasUsuario(sesion);
}
