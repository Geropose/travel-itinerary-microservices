// QA-1: cuánto tarda en verse en el panel un cambio de un proveedor que no avisa (P4.1).
//
// Análisis inicial, SEI 1: "el cambio se ve en la aplicación dentro de los 5 minutos posteriores a
// su generación". Iteración 3, Paso 7: "Peor caso: proveedor sin aviso, consultado cada 2 min, más
// segundos de traducción y broker, más 100 s de cola en un pico (Iteración 2): alrededor de
// 3 min 50 s."
//
// El proveedor sin aviso es el mock del hotel: el Servicio de Integraciones de cada región le pide
// los cambios cada 2 min (modifiedSince). Cómo mide:
// 1. Una reserva "faro" del mock cambia cada segundo. Así cada consulta de Integraciones (región 1)
//    encuentra un cambio y actualiza su cursor (cursores_consulta.actualizado_en): de ahí sale la
//    hora de cada consulta.
// 2. Varios usuarios con una reserva del hotel cada uno (en el mock y en Viajes, mismo número).
// 3. Justo después de una consulta, cada reserva cambia su salida (checkOut) en el mock, una a los
//    0 s (el peor caso: espera la consulta siguiente entera) y las otras a los 20, 40, 60, 80 y 100 s.
// 4. Para cada cambio se mira el panel del usuario (GET /api/viajes/panel) hasta que muestra la
//    salida nueva. Se separa la espera hasta la consulta y lo que tarda de la consulta al panel.
//
// El pico (la cola de 100 s de la tormenta) se mide con la tormenta de QA-5.
//
// Uso: node tests/carga/proveedor-sin-aviso.ts   (con npm run infra:levantar)
import { duracion } from './calculos.ts';
import {
  CONFIG_E2E,
  consultar,
  eliminarReservasUsuario,
  escribir,
  esperar,
  idAleatorio,
  pedirJson,
  registrarYLogin,
  renovarSesion,
  sistemaDisponible,
  type SesionE2E,
} from './comun.ts';

const PROVEEDOR = 'hotel-cordillera';
const URL_HOTEL = CONFIG_E2E.urlMockHotel;
/** Segundos después de una consulta en que cambia cada reserva (0 = peor caso). */
const MOMENTOS_S = [0, 20, 40, 60, 80, 100];
const ENTRADA = '2026-12-20T15:00:00-03:00';
const SALIDA = '2026-12-23T11:00:00-03:00';
const SALIDA_NUEVA = '2026-12-24T11:00:00-03:00';
const ESPERA_MAXIMA_MS = 6 * 60_000;

if (!(await sistemaDisponible())) {
  escribir('El sistema no está levantado: corré npm run infra:levantar.');
  process.exit(1);
}

async function admin(ruta: string, cuerpo: object) {
  const r = await fetch(`${URL_HOTEL}/admin${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  if (!r.ok) throw new Error(`Mock del hotel ${ruta}: HTTP ${r.status}`);
}

// --- Reloj de la base contra el de esta computadora ------------------------------------------
const msDeBase = (sql: string) => Number(consultar('r1', 'integraciones', sql)[0] ?? NaN);
const antes = Date.now();
const ahoraBase = msDeBase('SELECT extract(epoch FROM clock_timestamp()) * 1000');
const diferenciaReloj = ahoraBase - (antes + Date.now()) / 2;

// --- 1. Faro: un cambio por segundo para ver cada consulta -----------------------------------
const faro = `HC-FARO-${idAleatorio()}`;
await admin('/reservas', { reservationId: faro, checkIn: ENTRADA, checkOut: SALIDA });
let vuelta = 0;
const latido = setInterval(() => {
  vuelta += 1;
  void admin(`/reservas/${faro}/cambiar`, { roomDescription: `Faro ${vuelta}` }).catch(() => {});
}, 1000);

const consultas: number[] = [];
let vigilando = true;
const vigilancia = (async () => {
  let ultima = NaN;
  while (vigilando) {
    const marca = msDeBase(
      `SELECT extract(epoch FROM actualizado_en) * 1000 FROM cursores_consulta WHERE proveedor = '${PROVEEDOR}'`,
    );
    if (Number.isFinite(marca) && marca !== ultima) {
      if (Number.isFinite(ultima)) consultas.push(marca - diferenciaReloj);
      ultima = marca;
    }
    await esperar(250);
  }
})();
const proximaConsulta = async (despuesDe: number) => {
  while (!consultas.some((c) => c > despuesDe)) await esperar(100);
  return consultas.find((c) => c > despuesDe) ?? NaN;
};

// --- 2. Un usuario por momento, con una reserva del hotel -----------------------------------
interface Muestra {
  momentoS: number;
  sesion: SesionE2E;
  numero: string;
  cambio?: number;
  consulta?: number;
  visible?: number;
}
const muestras: Muestra[] = [];
for (const momentoS of MOMENTOS_S) {
  const sesion = await registrarYLogin({ nombre: `Viajera QA1 ${momentoS}` });
  const numero = `HC-QA1-${idAleatorio()}`;
  await admin('/reservas', { reservationId: numero, checkIn: ENTRADA, checkOut: SALIDA });
  const alta = await pedirJson(`${CONFIG_E2E.urlEnrutador}/api/viajes/reservas`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sesion.jwt}`,
      'X-Region': sesion.region,
    },
    body: JSON.stringify({
      proveedor: PROVEEDOR,
      tipoReserva: 'hotel',
      numeroReserva: numero,
      inicio: new Date(ENTRADA).toISOString(),
      fin: new Date(SALIDA).toISOString(),
      destino: 'Santiago',
    }),
  });
  if (alta.status !== 201) throw new Error(`Reserva: HTTP ${alta.status}`);
  muestras.push({ momentoS, sesion, numero });
}

/** Salida (fin) de la reserva en el panel del usuario, o undefined si todavía no está. */
async function salidaEnPanel(m: Muestra): Promise<number | undefined> {
  const pedir = () =>
    pedirJson<{ viajes: { reservas: { numeroReserva: string; fin: string }[] }[] }>(
      `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
      { headers: { Authorization: `Bearer ${m.sesion.jwt}`, 'X-Region': m.sesion.region } },
    );
  let panel = await pedir();
  if (panel.status === 401) {
    await renovarSesion(m.sesion);
    panel = await pedir();
  }
  const reserva = panel.datos?.viajes
    .flatMap((v) => v.reservas)
    .find((r) => r.numeroReserva === m.numero);
  return reserva ? Date.parse(reserva.fin) : undefined;
}

try {
  // La primera consulta después del alta trae las reservas nuevas; se deja pasar.
  const alta = await proximaConsulta(Date.now());
  escribir(`Altas tomadas en la consulta de las ${new Date(alta).toISOString()}`);
  await esperar(10_000);

  // --- 3. Cambios a los 0, 20, 40, 60, 80 y 100 s de una consulta ---------------------------
  const base = await proximaConsulta(Date.now());
  escribir(`Consulta de referencia: ${new Date(base).toISOString()}`);
  const cambios = muestras.map(async (m) => {
    await esperar(Math.max(0, base + m.momentoS * 1000 - Date.now()));
    await admin(`/reservas/${m.numero}/cambiar`, { checkOut: SALIDA_NUEVA });
    m.cambio = Date.now();
    // --- 4. Hasta que el panel muestra la salida nueva --------------------------------------
    while (Date.now() - m.cambio < ESPERA_MAXIMA_MS) {
      if ((await salidaEnPanel(m)) === Date.parse(SALIDA_NUEVA)) {
        m.visible = Date.now();
        break;
      }
      await esperar(250);
    }
    m.consulta = consultas.find((c) => c > (m.cambio ?? 0));
  });
  await Promise.all(cambios);

  const intervalos = consultas.slice(1).map((c, i) => c - (consultas[i] ?? c));
  escribir('QA-1: cambio de un proveedor sin aviso (hotel, consulta cada 2 min), región 1');
  escribir(
    `  Consultas vistas: ${consultas.length}, cada ${intervalos.map((i) => duracion(i)).join(', ')}`,
  );
  escribir('  Cambio a los | Espera a la consulta | Consulta → panel | Total');
  for (const m of muestras) {
    const total = (m.visible ?? NaN) - (m.cambio ?? NaN);
    const espera = (m.consulta ?? NaN) - (m.cambio ?? NaN);
    const resto = (m.visible ?? NaN) - (m.consulta ?? NaN);
    escribir(
      `  ${String(m.momentoS).padStart(3)} s       | ${duracion(espera).padEnd(20)} | ${duracion(resto).padEnd(16)} | ${duracion(total)}`,
    );
  }
  escribir(
    JSON.stringify({
      intervalosMs: intervalos,
      muestras: muestras.map((m) => ({
        momentoS: m.momentoS,
        esperaMs: (m.consulta ?? NaN) - (m.cambio ?? NaN),
        consultaAPanelMs: (m.visible ?? NaN) - (m.consulta ?? NaN),
        totalMs: (m.visible ?? NaN) - (m.cambio ?? NaN),
      })),
    }),
  );
} finally {
  clearInterval(latido);
  vigilando = false;
  await vigilancia;
  for (const m of muestras) await eliminarReservasUsuario(m.sesion);
}
