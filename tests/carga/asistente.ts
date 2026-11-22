// QA-12: tiempo de respuesta del asistente virtual (P4.1).
//
// Análisis inicial, SEI 12, e Iteración 7, Paso 7: el asistente responde cada mensaje en menos de
// 3 segundos en operación normal. La wiki estima: detectar la intención con reglas, unos 10 ms;
// consultar el estado, 150 a 300 ms; problemas menores, unos 50 ms. La reprogramación depende del
// proveedor y, si pasa de 3 s, el asistente responde que está consultando (no entra en esta medición).
//
// La wiki no da una cantidad de mensajes por segundo para el asistente. El prototipo corre en una sola
// computadora: medimos sin carga (un mensaje por vez) y con varios usuarios conversando a la vez, para
// ver desde dónde empieza a subir el tiempo. No se extrapola a la cantidad de usuarios real.
//
// Cómo mide:
// 1. Crea usuarios de la región 1 con agencia preferida (viajes-del-plata) y una reserva de vuelo
//    cargada a mano (POST /api/viajes/reservas).
// 2. Cada conversación nueva manda tres mensajes, como en UC-8: estado de la reserva, una pregunta de
//    equipaje (problema menor) y pedir hablar con la agencia (derivación, que crea el caso en el mock
//    de la agencia a través de Integraciones).
// 3. Mide cada mensaje de punta a punta desde el cliente, pasando por el enrutador global, y comprueba
//    que la respuesta sea la esperada (HTTP 200, intención y resultado).
// 4. Primero sin carga (--vueltas conversaciones de a una por usuario) y después con
//    --concurrencia usuarios conversando a la vez (por ejemplo 10,25,50).
// 5. Al final borra las reservas creadas y reinicia el mock de la agencia.
//
// Uso: node tests/carga/asistente.ts [--usuarios 50] [--vueltas 2] [--concurrencia 10,25,50]
//      [--conversaciones-por-nivel 100]
import { duracion, resumir } from './calculos.ts';
import {
  argumento,
  CONFIG_E2E,
  eliminarReservasUsuario,
  escribir,
  registrarYLogin,
  reiniciarMock,
  renovarSesion,
  sistemaDisponible,
  type SesionE2E,
} from './comun.ts';

const USUARIOS = Number(argumento('usuarios', '50'));
const VUELTAS = Number(argumento('vueltas', '2'));
const CONCURRENCIAS = argumento('concurrencia', '10,25,50').split(',').map(Number);
const CONVERSACIONES_POR_NIVEL = Number(argumento('conversaciones-por-nivel', '100'));
const AGENCIA = 'viajes-del-plata';
const LIMITE_MS = 3000;

if (!(await sistemaDisponible())) {
  escribir('El sistema no está levantado: corré npm run infra:levantar.');
  process.exit(1);
}

type Tipo = 'estado' | 'problemaMenor' | 'derivar';

interface Medicion {
  tipo: Tipo;
  ms: number;
  correcta: boolean;
  detalle: string;
}

interface Usuario {
  sesion: SesionE2E;
  numeroReserva: string;
}

const MENSAJES: { tipo: Tipo; texto: (u: Usuario) => string; resultado: string }[] = [
  {
    tipo: 'estado',
    texto: (u) => `¿Cuál es el estado de mi vuelo ${u.numeroReserva}?`,
    resultado: 'respondido',
  },
  {
    tipo: 'problemaMenor',
    texto: () => '¿Cuánto equipaje puedo llevar en mi vuelo?',
    resultado: 'respondido',
  },
  {
    tipo: 'derivar',
    texto: () => 'Quiero hablar con una persona de mi agencia',
    resultado: 'derivado',
  },
];

const cabeceras = (sesion: SesionE2E) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${sesion.jwt}`,
  'X-Region': sesion.region,
});

async function conSesion(sesion: SesionE2E, pedir: () => Promise<Response>): Promise<Response> {
  let r = await pedir();
  if (r.status === 401) {
    await renovarSesion(sesion);
    r = await pedir();
  }
  return r;
}

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

/** Una conversación de UC-8: abre la conversación y manda los tres mensajes, midiendo cada uno. */
async function conversar(usuario: Usuario): Promise<Medicion[]> {
  const { sesion } = usuario;
  const abierta = await conSesion(sesion, () =>
    fetch(`${CONFIG_E2E.urlEnrutador}/api/asistente/conversaciones`, {
      method: 'POST',
      headers: cabeceras(sesion),
      body: JSON.stringify({ idioma: 'es' }),
    }),
  );
  if (abierta.status !== 201) throw new Error(`Abrir conversación: HTTP ${abierta.status}`);
  const { conversacionId } = (await abierta.json()) as { conversacionId: string };

  const mediciones: Medicion[] = [];
  for (const mensaje of MENSAJES) {
    const inicio = performance.now();
    const r = await conSesion(sesion, () =>
      fetch(`${CONFIG_E2E.urlEnrutador}/api/asistente/conversaciones/${conversacionId}/mensajes`, {
        method: 'POST',
        headers: cabeceras(sesion),
        body: JSON.stringify({ texto: mensaje.texto(usuario) }),
      }),
    );
    const cuerpo = (await r.json().catch(() => undefined)) as
      { respuesta?: { intencion?: string; resultado?: string } } | undefined;
    const ms = performance.now() - inicio;
    const intencion = cuerpo?.respuesta?.intencion;
    const resultado = cuerpo?.respuesta?.resultado;
    mediciones.push({
      tipo: mensaje.tipo,
      ms,
      correcta: r.status === 200 && intencion === mensaje.tipo && resultado === mensaje.resultado,
      detalle: `HTTP ${r.status} ${intencion ?? '-'}/${resultado ?? '-'}`,
    });
  }
  return mediciones;
}

function informar(titulo: string, mediciones: Medicion[], ms: number) {
  escribir(`  ${titulo}: ${mediciones.length} mensajes en ${duracion(ms)}`);
  escribir('    Mensaje        |   n  |  p50  |  p95  |  máx  | > 3 s | incorrectos');
  for (const tipo of ['estado', 'problemaMenor', 'derivar'] as const) {
    const delTipo = mediciones.filter((m) => m.tipo === tipo);
    const r = resumir(delTipo.map((m) => m.ms));
    const lentos = delTipo.filter((m) => m.ms > LIMITE_MS).length;
    const malas = delTipo.filter((m) => !m.correcta);
    escribir(
      `    ${tipo.padEnd(14)} | ${String(r.n).padStart(4)} | ${String(Math.round(r.p50)).padStart(5)} | ${String(Math.round(r.p95)).padStart(5)} | ${String(Math.round(r.max)).padStart(5)} | ${String(lentos).padStart(5)} | ${malas.length}${malas[0] ? ` (por ejemplo ${malas[0].detalle})` : ''}`,
    );
  }
}

const usuarios: Usuario[] = [];
const resultados: Record<string, Medicion[]> = {};
try {
  // --- 1. Usuarios con agencia preferida y una reserva de vuelo ---------------------------
  const inicioPreparacion = Date.now();
  const marca = Date.now().toString(36).slice(-3).toUpperCase();
  await enParalelo(
    Array.from({ length: USUARIOS }, (_, i) => i),
    10,
    async (i) => {
      const sesion = await registrarYLogin({ nombre: `Viajera Asistente ${i}` });
      const perfil = await conSesion(sesion, () =>
        fetch(`${CONFIG_E2E.urlEnrutador}/api/usuarios/perfil`, {
          method: 'PATCH',
          headers: cabeceras(sesion),
          body: JSON.stringify({ agenciaPreferida: AGENCIA }),
        }),
      );
      if (perfil.status !== 200) throw new Error(`Perfil: HTTP ${perfil.status}`);
      // Código de 6 caracteres con un dígito, como los que reconoce el asistente.
      const numeroReserva = `${marca}${String(i).padStart(3, '0')}`;
      const reserva = await conSesion(sesion, () =>
        fetch(`${CONFIG_E2E.urlEnrutador}/api/viajes/reservas`, {
          method: 'POST',
          headers: cabeceras(sesion),
          body: JSON.stringify({
            proveedor: 'aerolinea-andina',
            tipoReserva: 'vuelo',
            numeroReserva,
            inicio: '2027-03-10T11:30:00Z',
            fin: '2027-03-10T13:40:00Z',
            origen: 'Buenos Aires (EZE)',
            destino: 'Santiago (SCL)',
          }),
        }),
      );
      if (reserva.status !== 201)
        throw new Error(`Reserva ${numeroReserva}: HTTP ${reserva.status}`);
      usuarios[i] = { sesion, numeroReserva };
    },
  );
  escribir(
    `${USUARIOS} usuarios con agencia preferida y una reserva, en ${duracion(Date.now() - inicioPreparacion)}`,
  );

  // Calentamiento (conexiones y caches), que no se cuenta.
  for (const u of usuarios.slice(0, 3)) await conversar(u);

  // --- 2. Sin carga: una conversación por vez ----------------------------------------------
  escribir('QA-12: respuesta del asistente de punta a punta (ms), por el enrutador global');
  let inicio = Date.now();
  const sinCarga: Medicion[] = [];
  for (let v = 0; v < VUELTAS; v += 1) {
    for (const u of usuarios) sinCarga.push(...(await conversar(u)));
  }
  resultados['1'] = sinCarga;
  informar('Sin carga (de a una conversación)', sinCarga, Date.now() - inicio);

  // --- 3. Con varios usuarios conversando a la vez -----------------------------------------
  for (const concurrencia of CONCURRENCIAS) {
    const mediciones: Medicion[] = [];
    inicio = Date.now();
    // Cada trabajador usa su propio usuario: nadie tiene dos conversaciones a la vez.
    let pendientes = CONVERSACIONES_POR_NIVEL;
    await Promise.all(
      usuarios.slice(0, concurrencia).map(async (u) => {
        while (pendientes > 0) {
          pendientes -= 1;
          mediciones.push(...(await conversar(u)));
        }
      }),
    );
    const ms = Date.now() - inicio;
    resultados[String(concurrencia)] = mediciones;
    informar(
      `${concurrencia} usuarios a la vez (${(mediciones.length / (ms / 1000)).toFixed(1)} mensajes/s)`,
      mediciones,
      ms,
    );
  }

  escribir(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(resultados).map(([nivel, ms]) => [
          nivel,
          Object.fromEntries(
            (['estado', 'problemaMenor', 'derivar'] as const).map((tipo) => [
              tipo,
              resumir(ms.filter((m) => m.tipo === tipo).map((m) => Math.round(m.ms))),
            ]),
          ),
        ]),
      ),
    ),
  );
} finally {
  // --- 4. Limpieza --------------------------------------------------------------------------
  await enParalelo(usuarios.filter(Boolean), 10, async (u) => {
    await renovarSesion(u.sesion).catch(() => undefined);
    await eliminarReservasUsuario(u.sesion);
  });
  await reiniciarMock(CONFIG_E2E.urlMockAgencia);
}
