// QA-7 (publicación en la red social en menos de 3 s), prueba de carga con k6 (P4.1).
//
// Iteración 3, Paso 7: "Publicar en una red social es una llamada al adaptador de alrededor de 1 s."
// Camino medido: enrutador global → nginx → gateway (Validador de Intercepción) → Servicio de
// Viajes (POST /viajes/{viajeId}/compartir-red) → Servicio de Integraciones (adaptador de la red
// social) → mock de la red social, y la respuesta de vuelta.
//
// El prototipo corre en una sola máquina con una instancia de Viajes y una de Integraciones por
// región. La wiki no estima cuántas publicaciones por segundo hay en un pico, así que no
// inventamos un número: subimos la carga en escalones (1, 5, 10 y 20 publicaciones por segundo,
// 30 s cada uno) y vemos hasta dónde el p95 sigue debajo de 3 s.
//
// El mock de la red social responde enseguida. Con DEMORA_RED_MS=1000 el mock tarda 1 s en cada
// publicación (POST /admin/comportamiento), como la red social real que estima la wiki.
//
// Uso (k6 en Docker, sin instalar nada): npm run carga:publicacion
//      npm run carga:publicacion:demora   (con DEMORA_RED_MS=1000)
/* global __ENV */
import http from 'k6/http';
import { check } from 'k6';

const URL = __ENV.URL_API || 'http://localhost:8000';
const URL_MOCK_RED = __ENV.URL_MOCK_RED || 'http://localhost:4007';
const DEMORA_RED_MS = Number(__ENV.DEMORA_RED_MS || 0);
const REGION = 'region-1';
const ESCALONES = [1, 5, 10, 20];
const DURACION_S = 30;
const USUARIOS = 5;

export const options = {
  setupTimeout: '60s',
  scenarios: Object.fromEntries(
    ESCALONES.map((porSegundo, i) => [
      `escalon_${String(porSegundo).padStart(2, '0')}_por_s`,
      {
        executor: 'constant-arrival-rate',
        rate: porSegundo,
        timeUnit: '1s',
        duration: `${DURACION_S}s`,
        startTime: `${i * (DURACION_S + 5)}s`,
        preAllocatedVUs: porSegundo * 3,
        maxVUs: porSegundo * 10,
      },
    ]),
  ),
  // QA-7: p95 de la publicación debajo de 3 s en cada escalón, y sin errores.
  thresholds: Object.fromEntries(
    ESCALONES.flatMap((porSegundo) => {
      const escenario = `escalon_${String(porSegundo).padStart(2, '0')}_por_s`;
      return [
        [`http_req_duration{scenario:${escenario}}`, ['p(95)<3000']],
        [`http_req_failed{scenario:${escenario}}`, ['rate<0.01']],
      ];
    }),
  ),
  summaryTrendStats: ['min', 'med', 'p(95)', 'max'],
};

const json = (cuerpo, jwt) => ({
  headers: {
    'Content-Type': 'application/json',
    'X-Region': REGION,
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  },
  tags: { name: 'preparacion' },
});

/** Usuarios de prueba, cada uno con un viaje (una reserva manual) para compartir. */
export function setup() {
  const viajes = [];
  for (let i = 0; i < USUARIOS; i += 1) {
    const sufijo = `${Date.now()}-${i}`;
    const email = `carga-red-${sufijo}@correo.example`;
    const contrasena = 'Viajar-Carga-2026!';
    const registro = http.post(
      `${URL}/api/autenticacion/registro`,
      JSON.stringify({
        nombre: `Viajero Carga ${i}`,
        email,
        contrasena,
        region: REGION,
        idioma: 'es',
      }),
      json(),
    );
    check(registro, { 'registro 201': (r) => r.status === 201 });
    const login = http.post(
      `${URL}/api/autenticacion/login`,
      JSON.stringify({ email, contrasena }),
      json(),
    );
    const jwt = login.json('jwt');
    const reserva = http.post(
      `${URL}/api/viajes/reservas`,
      JSON.stringify({
        proveedor: 'aerolinea-andina',
        tipoReserva: 'vuelo',
        numeroReserva: `CR${sufijo.replace(/\D/g, '').slice(-8)}`,
        inicio: '2026-12-20T08:30:00Z',
        fin: '2026-12-20T10:40:00Z',
        origen: 'Buenos Aires (EZE)',
        destino: 'Santiago (SCL)',
      }),
      json(null, jwt),
    );
    check(reserva, { 'reserva 201': (r) => r.status === 201 });
    const panel = http.get(`${URL}/api/viajes/panel`, json(null, jwt));
    viajes.push({ jwt, viajeId: panel.json('viajes.0.viajeId') });
  }
  const comportamiento = http.post(
    `${URL_MOCK_RED}/admin/comportamiento`,
    JSON.stringify({ demoraMs: DEMORA_RED_MS }),
    json(),
  );
  check(comportamiento, { 'demora configurada': (r) => r.status === 200 });
  return { viajes };
}

/** Deja el mock de la red social sin demora. */
export function teardown() {
  http.del(`${URL_MOCK_RED}/admin/comportamiento`, null, { tags: { name: 'preparacion' } });
}

export default function ({ viajes }) {
  const { jwt, viajeId } = viajes[Math.floor(Math.random() * viajes.length)];
  const respuesta = http.post(
    `${URL}/api/viajes/viajes/${viajeId}/compartir-red`,
    JSON.stringify({ red: 'redsocial' }),
    { ...json(null, jwt), tags: { name: 'compartir-red' } },
  );
  check(respuesta, { 'publicado (201)': (r) => r.status === 201 });
}
