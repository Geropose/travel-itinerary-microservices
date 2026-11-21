// QA-2 (el panel responde en menos de 800 ms), prueba de carga con k6 (P4.1).
//
// Análisis inicial, sección 7: en el pico llegan 20.000 solicitudes por segundo y una instancia de
// un microservicio atiende 500 por segundo. Iteración 4, Paso 7: el panel se responde desde la
// cache (red 100 ms + gateway 20 ms + cache 10 ms, unos 150 ms) y, si no está en la cache, desde la
// read replica (unos 300 ms); en el pico, el 90 % sale de la cache.
//
// El prototipo tiene una instancia del Servicio de Viajes por región (el gateway tiene 2). La carga
// proporcional es la de una instancia: 500 paneles por segundo a la región 1. Subimos en escalones
// (100, 250, 500 y 1.000 por segundo, 60 s cada uno) para ver también hasta dónde aguanta.
//
// Para que no todo salga de la cache, en cada escalón corren a la vez cambios manuales de reservas
// (PATCH /reservas/{reservaId}) al 10 % de la tasa del panel: cada cambio invalida la cache de ese
// usuario y su próximo panel se lee de la read replica, como el 10 % de la wiki.
//
// Camino medido: k6 → enrutador global → nginx de la región 1 → gateway (Validador de
// Intercepción) → Servicio de Viajes (cache Redis o read replica), y vuelta.
//
// Uso (k6 en Docker, sin instalar nada): npm run carga:panel
/* global __ENV */
import http from 'k6/http';
import { check } from 'k6';

const URL = __ENV.URL_API || 'http://localhost:8000';
const REGION = 'region-1';
const ESCALONES = [100, 250, 500, 1000];
const DURACION_S = 60;
const PAUSA_S = 10;
const USUARIOS = Number(__ENV.USUARIOS || 500);
const DE_A = 25;

const nombre = (porSegundo) => `panel_${String(porSegundo).padStart(4, '0')}_por_s`;

export const options = {
  setupTimeout: '10m',
  scenarios: Object.fromEntries(
    ESCALONES.flatMap((porSegundo, i) => {
      const comun = {
        executor: 'constant-arrival-rate',
        timeUnit: '1s',
        duration: `${DURACION_S}s`,
        startTime: `${i * (DURACION_S + PAUSA_S)}s`,
      };
      return [
        [
          nombre(porSegundo),
          {
            ...comun,
            rate: porSegundo,
            preAllocatedVUs: porSegundo,
            maxVUs: porSegundo * 4,
            exec: 'panel',
          },
        ],
        [
          `cambios_${nombre(porSegundo)}`,
          {
            ...comun,
            rate: porSegundo / 10,
            preAllocatedVUs: porSegundo / 5,
            maxVUs: porSegundo,
            exec: 'cambio',
          },
        ],
      ];
    }),
  ),
  // QA-2: p95 del panel debajo de 800 ms en cada escalón, y sin errores.
  thresholds: Object.fromEntries(
    ESCALONES.flatMap((porSegundo) => [
      [`http_req_duration{scenario:${nombre(porSegundo)}}`, ['p(95)<800']],
      [`http_req_failed{scenario:${nombre(porSegundo)}}`, ['rate<0.01']],
    ]),
  ),
  summaryTrendStats: ['min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const opciones = (jwt, tag) => ({
  headers: {
    'Content-Type': 'application/json',
    'X-Region': REGION,
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  },
  tags: { name: tag },
});

/** Manda una tanda de pedidos en paralelo (http.batch) y devuelve las respuestas. */
const enTanda = (pedidos) => http.batch(pedidos);

/** Usuarios de prueba, cada uno con un viaje de una reserva manual (se crean de a 25 en paralelo). */
export function setup() {
  const usuarios = [];
  const marca = Date.now();
  for (let desde = 0; desde < USUARIOS; desde += DE_A) {
    const tanda = [];
    for (let i = desde; i < Math.min(USUARIOS, desde + DE_A); i += 1) {
      tanda.push({
        i,
        email: `carga-panel-${marca}-${i}@correo.example`,
        contrasena: 'Viajar-Carga-2026!',
      });
    }
    const registros = enTanda(
      tanda.map((u) => [
        'POST',
        `${URL}/api/autenticacion/registro`,
        JSON.stringify({
          nombre: `Viajera Panel ${u.i}`,
          email: u.email,
          contrasena: u.contrasena,
          region: REGION,
          idioma: 'es',
        }),
        opciones(null, 'preparacion'),
      ]),
    );
    registros.forEach((r) => check(r, { 'registro 201': (x) => x.status === 201 }));
    const logins = enTanda(
      tanda.map((u) => [
        'POST',
        `${URL}/api/autenticacion/login`,
        JSON.stringify({ email: u.email, contrasena: u.contrasena }),
        opciones(null, 'preparacion'),
      ]),
    );
    const jwts = logins.map((r) => r.json('jwt'));
    const reservas = enTanda(
      tanda.map((u, k) => [
        'POST',
        `${URL}/api/viajes/reservas`,
        JSON.stringify({
          proveedor: 'aerolinea-andina',
          tipoReserva: 'vuelo',
          numeroReserva: `PN${String(marca).slice(-6)}${String(u.i).padStart(4, '0')}`,
          inicio: '2026-12-20T08:30:00Z',
          fin: '2026-12-20T10:40:00Z',
          origen: 'Buenos Aires (EZE)',
          destino: 'Santiago (SCL)',
        }),
        opciones(jwts[k], 'preparacion'),
      ]),
    );
    reservas.forEach((r, k) => {
      check(r, { 'reserva 201': (x) => x.status === 201 });
      usuarios.push({ jwt: jwts[k], reservaId: r.json('reservaId') });
    });
  }
  return { usuarios };
}

const alAzar = (usuarios) => usuarios[Math.floor(Math.random() * usuarios.length)];

/** Un usuario pide su panel. */
export function panel({ usuarios }) {
  const { jwt } = alAzar(usuarios);
  const respuesta = http.get(`${URL}/api/viajes/panel`, opciones(jwt, 'panel'));
  check(respuesta, { 'panel 200': (r) => r.status === 200 });
}

/** Un usuario cambia a mano su reserva: invalida su panel en la cache. */
export function cambio({ usuarios }) {
  const { jwt, reservaId } = alAzar(usuarios);
  const respuesta = http.patch(
    `${URL}/api/viajes/reservas/${reservaId}`,
    JSON.stringify({ destino: `Santiago (SCL) ${Math.floor(Math.random() * 1000)}` }),
    opciones(jwt, 'cambio'),
  );
  check(respuesta, { 'cambio 200': (r) => r.status === 200 });
}
