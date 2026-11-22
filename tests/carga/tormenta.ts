// QA-5: tormenta de cancelaciones a escala (P4.1).
//
// Análisis inicial, SEI 5: un evento disruptivo genera un pico masivo; el sistema sigue atendiendo y
// el panel sigue respondiendo (QA-2) durante el pico. Iteración 2, Paso 7: 50.000 vuelos cancelados
// generan 500.000 actualizaciones; 50 consumidores a 100 eventos/s cada uno (5.000/s) las procesan
// en 100 s (ADR-009).
//
// El prototipo corre en una sola computadora, con una instancia del Servicio de Viajes por región y
// 4 consumidores por instancia (CANTIDAD_CONSUMIDORES). La carga proporcional es la de 4
// consumidores de 50: 4/50 de 500.000 = 40.000 actualizaciones (por defecto, --cantidad).
//
// Cómo mide:
// 1. Crea usuarios de la región 1 con reservas de vuelo de la aerolínea (--usuarios, 10 reservas
//    cada uno por defecto), con los mismos números que va a cancelar la tormenta del mock.
// 2. Pide al mock de la aerolínea la tormenta (POST /admin/tormenta), una tanda por segundo
//    (--por-s, 500 por defecto; el mock no aguanta mandar miles de webhooks juntos): cada vuelo
//    cancelado sale por webhook firmado a Integraciones de las dos regiones.
// 3. Cada segundo cuenta, en la región 1, cuántas cancelaciones tradujo Integraciones
//    (cambios_procesados) y cuántas reservas ya quedaron canceladas en Viajes; cada 5 s mira la cola
//    viajes.ReservaActualizada de RabbitMQ.
// 4. Mientras tanto, usuarios de prueba piden su panel (--panel-por-s) para ver si QA-2 (p95 menor a
//    800 ms) se sigue cumpliendo en el pico. También se mide antes de la tormenta, como referencia.
// Al final borra las reservas creadas.
//
// Uso: node tests/carga/tormenta.ts [--cantidad 40000] [--usuarios 4000] [--por-s 500]
import { execFileSync } from 'node:child_process';
import { duracion, resumir } from './calculos.ts';
import {
  argumento,
  CONFIG_E2E,
  consultar,
  escribir,
  esperar,
  registrarYLogin,
  renovarSesion,
  sistemaDisponible,
  type SesionE2E,
} from './comun.ts';

const CANTIDAD = Number(argumento('cantidad', '40000'));
const USUARIOS = Number(argumento('usuarios', '4000'));
/** Vuelos cancelados por segundo que pide el script al mock (cada uno sale a las dos regiones). */
const POR_SEGUNDO = Number(argumento('por-s', '500'));
const PANEL_POR_S = Number(argumento('panel-por-s', '50'));
const PROVEEDOR = 'aerolinea-andina';
const URL_AEROLINEA = CONFIG_E2E.urlMockAerolinea;
/** Si en 2 min no avanza ninguna etapa, se corta. */
const SIN_AVANCE_MAXIMO_MS = 2 * 60_000;

if (!(await sistemaDisponible())) {
  escribir('El sistema no está levantado: corré npm run infra:levantar.');
  process.exit(1);
}

/** Corre `trabajo` sobre cada elemento, con a lo sumo `cuantos` a la vez. */
async function enParalelo<T>(
  elementos: readonly T[],
  cuantos: number,
  trabajo: (elemento: T, indice: number) => Promise<void>,
): Promise<void> {
  let siguiente = 0;
  const trabajador = async () => {
    while (siguiente < elementos.length) {
      const i = siguiente;
      siguiente += 1;
      await trabajo(elementos[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cuantos, elementos.length) }, trabajador));
}

async function tormenta(cuerpo: object): Promise<{ canceladas: number; muestra: string[] }> {
  const r = await fetch(`${URL_AEROLINEA}/admin/tormenta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  if (r.status !== 202) throw new Error(`Tormenta: HTTP ${r.status} ${await r.text()}`);
  const datos = (await r.json()) as { canceladas: number; muestraReferencias: string[] };
  return { canceladas: datos.canceladas, muestra: datos.muestraReferencias };
}

// --- Números de reserva que va a cancelar la tormenta --------------------------------------
// El mock numera los vuelos sintéticos como <prefijo><secuencia>, pero antes cancela las órdenes
// activas de sus semillas. Se cancelan esas de a una (sin webhooks) hasta ver la secuencia.
const letras = Array.from({ length: 4 }, () =>
  String.fromCharCode(65 + Math.floor(Math.random() * 26)),
);
const PREFIJO = `Q5${letras.join('')}`;
let secuencia = NaN;
for (let i = 0; i < 1000 && !Number.isFinite(secuencia); i += 1) {
  const { muestra } = await tormenta({ cantidad: 1, prefijo: PREFIJO, enviarWebhooks: false });
  const ref = muestra[0] ?? '';
  if (ref.startsWith(PREFIJO)) secuencia = Number(ref.slice(PREFIJO.length));
}
if (!Number.isFinite(secuencia)) throw new Error('No se pudo saber la numeración del mock');
const numero = (k: number) => `${PREFIJO}${String(secuencia + 1 + k).padStart(5, '0')}`;

// --- 1. Usuarios y reservas -------------------------------------------------------------------
interface Creada {
  sesion: SesionE2E;
  reservaId: string;
}
const porUsuario = Math.ceil(CANTIDAD / USUARIOS);
const sesiones: SesionE2E[] = [];
let inicioPreparacion = Date.now();
await enParalelo(
  Array.from({ length: USUARIOS }, (_, i) => i),
  20,
  async (i) => {
    sesiones[i] = await registrarYLogin({ nombre: `Viajera Tormenta ${i}` });
  },
);
escribir(`${USUARIOS} usuarios creados en ${duracion(Date.now() - inicioPreparacion)}`);

async function conSesion(sesion: SesionE2E, pedir: () => Promise<Response>): Promise<Response> {
  let r = await pedir();
  if (r.status === 401) {
    await renovarSesion(sesion);
    r = await pedir();
  }
  return r;
}

const creadas: Creada[] = [];
inicioPreparacion = Date.now();
await enParalelo(
  Array.from({ length: CANTIDAD }, (_, k) => k),
  50,
  async (k) => {
    const sesion = sesiones[Math.floor(k / porUsuario)] as SesionE2E;
    // Cada reserva del usuario en un mes distinto: un viaje por reserva, como en la vida real.
    const dia = new Date(Date.UTC(2027, 0, 5) + (k % porUsuario) * 30 * 86_400_000);
    const r = await conSesion(sesion, () =>
      fetch(`${CONFIG_E2E.urlEnrutador}/api/viajes/reservas`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sesion.jwt}`,
          'X-Region': sesion.region,
        },
        body: JSON.stringify({
          proveedor: PROVEEDOR,
          tipoReserva: 'vuelo',
          numeroReserva: numero(k),
          inicio: new Date(dia.getTime() + 8 * 3_600_000).toISOString(),
          fin: new Date(dia.getTime() + 10 * 3_600_000).toISOString(),
          origen: 'Buenos Aires (EZE)',
          destino: 'Santiago (SCL)',
        }),
      }),
    );
    if (r.status !== 201) throw new Error(`Reserva ${numero(k)}: HTTP ${r.status}`);
    const { reservaId } = (await r.json()) as { reservaId: string };
    creadas.push({ sesion, reservaId });
  },
);
escribir(`${CANTIDAD} reservas creadas en ${duracion(Date.now() - inicioPreparacion)}`);

// --- Conteos y cola ---------------------------------------------------------------------------
const contarUno = (base: string, sql: string) => Number(consultar('r1', base, sql)[0] ?? 0);
/** Eventos del outbox de Integraciones (región 1) que todavía no se mandaron a RabbitMQ. */
const enOutbox = () =>
  contarUno('integraciones', 'SELECT count(*) FROM eventos_salientes WHERE enviado_en IS NULL');
const traducidas = () =>
  contarUno(
    'integraciones',
    `SELECT count(*) FROM cambios_procesados WHERE numero_reserva LIKE '${PREFIJO}%'`,
  );
/** Viajes tiene su propia base (con réplica de lectura): se cuenta en la principal. */
const canceladas = () =>
  Number(
    execFileSync(
      'docker',
      [
        'exec',
        'r1-postgres-viajes-1',
        'psql',
        '-U',
        'admin',
        '-d',
        'viajes',
        '-tAc',
        `SELECT count(*) FROM reservas WHERE numero_reserva LIKE '${PREFIJO}%' AND estado = 'cancelada'`,
      ],
      { encoding: 'utf8' },
    ).trim(),
  );
/** Mensajes en la cola viajes.ReservaActualizada de la región 1 (NaN si no se pudo leer). */
function enCola(): number {
  try {
    const salida = execFileSync(
      'docker',
      ['exec', 'r1-rabbitmq-1', 'rabbitmqctl', 'list_queues', '-q', 'name', 'messages'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const fila = salida.split('\n').find((l) => l.startsWith('viajes.ReservaActualizada\t'));
    return fila ? Number(fila.split('\t')[1]) : NaN;
  } catch {
    return NaN;
  }
}

// --- 4. Paneles durante la medición -----------------------------------------------------------
interface PedidoPanel {
  en: number;
  ms: number;
  status: number;
}
const paneles: PedidoPanel[] = [];
const muestraPanel = sesiones.slice(0, 200);
let pidiendoPaneles = true;
const pidePaneles = (async () => {
  const pendientes: Promise<void>[] = [];
  for (let i = 0; pidiendoPaneles; i += 1) {
    const sesion = muestraPanel[i % muestraPanel.length] as SesionE2E;
    pendientes.push(
      (async () => {
        const inicio = performance.now();
        let status: number;
        try {
          const r = await conSesion(sesion, () =>
            fetch(`${CONFIG_E2E.urlEnrutador}/api/viajes/panel`, {
              headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
              signal: AbortSignal.timeout(10_000),
            }),
          );
          status = r.status;
          await r.body?.cancel();
        } catch {
          status = 0;
        }
        paneles.push({ en: Date.now(), ms: performance.now() - inicio, status });
      })(),
    );
    await esperar(1000 / PANEL_POR_S);
  }
  await Promise.all(pendientes);
})();

interface Foto {
  en: number;
  traducidas: number;
  canceladas: number;
  outbox: number;
  cola?: number;
}
const fotos: Foto[] = [];
let resultado: Record<string, unknown> | undefined;
try {
  // Se empieza con el outbox vacío (si no, se mezcla con eventos anteriores).
  while (enOutbox() > 0) await esperar(1000);
  // Referencia: 15 s de paneles sin tormenta.
  await esperar(15_000);
  const inicioTormenta = Date.now();

  // --- 2. La tormenta, una tanda por segundo ---------------------------------------------
  let pedidas = 0;
  const enviando = (async () => {
    for (let segundo = 1; pedidas < CANTIDAD; segundo += 1) {
      const cantidad = Math.min(POR_SEGUNDO, CANTIDAD - pedidas);
      const { canceladas: hechas } = await tormenta({ cantidad, prefijo: PREFIJO });
      if (hechas !== cantidad) throw new Error(`El mock canceló ${hechas} de ${cantidad}`);
      pedidas += cantidad;
      await esperar(Math.max(0, inicioTormenta + segundo * 1000 - Date.now()));
    }
    return Date.now();
  })();
  // Si el mock falla, se informa al final (y la limpieza corre igual).
  let errorEnvio: unknown;
  enviando.catch((error: unknown) => {
    errorEnvio = error;
  });

  // --- 3. Conteo cada segundo -------------------------------------------------------------
  let ultimoAvance = Date.now();
  let colaEn = 0;
  for (;;) {
    const foto: Foto = {
      en: Date.now(),
      traducidas: traducidas(),
      canceladas: canceladas(),
      outbox: enOutbox(),
    };
    if (foto.en - colaEn >= 5000) {
      foto.cola = enCola();
      colaEn = foto.en;
    }
    const anterior = fotos.at(-1);
    if (
      !anterior ||
      foto.traducidas > anterior.traducidas ||
      foto.canceladas > anterior.canceladas
    ) {
      ultimoAvance = foto.en;
    }
    fotos.push(foto);
    if (foto.canceladas >= CANTIDAD) break;
    if (foto.en - ultimoAvance > SIN_AVANCE_MAXIMO_MS) {
      escribir('Sin avance en 2 min: se corta la medición.');
      break;
    }
    await esperar(1000);
  }
  const finEnvio = errorEnvio === undefined ? await enviando : NaN;
  if (errorEnvio !== undefined)
    escribir(`El mock falló después de ${pedidas} vuelos: ${String(errorEnvio)}`);
  const fin = fotos.at(-1) as Foto;
  // Referencia de después: 15 s más de paneles.
  await esperar(15_000);
  pidiendoPaneles = false;
  await pidePaneles;

  const primeraCon = (campo: 'traducidas' | 'canceladas', n: number) =>
    fotos.find((f) => f[campo] >= n)?.en ?? NaN;
  const finTraduccion = primeraCon('traducidas', CANTIDAD);
  const finViajes = primeraCon('canceladas', CANTIDAD);
  const inicioViajes = primeraCon('canceladas', 1);
  // Mejor ritmo de Viajes en 10 s seguidos.
  let mejorRitmo = 0;
  for (const f of fotos) {
    const despues = fotos.find((g) => g.en >= f.en + 10_000);
    if (despues) {
      mejorRitmo = Math.max(
        mejorRitmo,
        ((despues.canceladas - f.canceladas) * 1000) / (despues.en - f.en),
      );
    }
  }
  const colaMaxima = Math.max(...fotos.map((f) => f.cola ?? 0));
  const outboxMaximo = Math.max(...fotos.map((f) => f.outbox));

  const tramo = (desde: number, hasta: number) => {
    const pedidos = paneles.filter((p) => p.en >= desde && p.en <= hasta);
    const ok = pedidos.filter((p) => p.status === 200);
    return {
      pedidos: pedidos.length,
      errores: pedidos.length - ok.length,
      ...resumir(ok.map((p) => p.ms)),
    };
  };
  const antes = tramo(0, inicioTormenta);
  const durante = tramo(inicioTormenta, fin.en);
  const despues = tramo(fin.en + 1, Date.now());

  escribir(`QA-5: tormenta de ${CANTIDAD} cancelaciones de vuelos (proporción 4/50 de 500.000)`);
  escribir(`  Mock: todas las tandas pedidas en ${duracion(finEnvio - inicioTormenta)}`);
  escribir(
    `  Integraciones (región 1): ${fin.traducidas} traducidas; todas en ${duracion(finTraduccion - inicioTormenta)}`,
  );
  escribir(
    `  Viajes (región 1): ${fin.canceladas} de ${CANTIDAD} reservas canceladas; todas en ${duracion(finViajes - inicioTormenta)} ` +
      `desde el inicio (primera a los ${duracion(inicioViajes - inicioTormenta)})`,
  );
  escribir(
    `  Ritmo de Viajes: promedio ${Math.round((fin.canceladas * 1000) / (finViajes - inicioViajes))} por s, ` +
      `mejor 10 s ${Math.round(mejorRitmo)} por s; cola máxima vista en RabbitMQ: ${colaMaxima}; máximo en el outbox de Integraciones: ${outboxMaximo}`,
  );
  const linea = (nombre: string, t: ReturnType<typeof tramo>) =>
    escribir(
      `  Panel ${nombre}: ${t.pedidos} pedidos, ${t.errores} errores, p50 ${duracion(t.p50)}, p95 ${duracion(t.p95)}, máx ${duracion(t.max)}`,
    );
  linea('antes', antes);
  linea('durante la tormenta', durante);
  linea('después', despues);
  resultado = {
    cantidad: CANTIDAD,
    usuarios: USUARIOS,
    mockMs: finEnvio - inicioTormenta,
    traduccionMs: finTraduccion - inicioTormenta,
    viajesMs: finViajes - inicioTormenta,
    primeraMs: inicioViajes - inicioTormenta,
    mejorRitmo,
    colaMaxima,
    outboxMaximo,
    panel: { antes, durante, despues },
    fotos: fotos.map((f) => [
      f.en - inicioTormenta,
      f.traducidas,
      f.canceladas,
      f.outbox,
      f.cola ?? null,
    ]),
  };
} finally {
  pidiendoPaneles = false;
  await pidePaneles;
  // Limpieza: se borran las reservas creadas.
  await enParalelo(creadas, 50, async ({ sesion, reservaId }) => {
    try {
      await conSesion(sesion, () =>
        fetch(`${CONFIG_E2E.urlEnrutador}/api/viajes/reservas/${reservaId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
        }),
      );
    } catch {
      // Limpieza de mejor esfuerzo.
    }
  });
}
escribir(JSON.stringify(resultado ?? {}));
