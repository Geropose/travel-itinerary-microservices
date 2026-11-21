// QA-9: cuánto agrega la seguridad a cada solicitud y cuánto tarda en quedar registrado un acceso
// rechazado (P4.1).
//
// Iteración 5, Paso 7: "registro en menos de 1 s y menos de 200 ms extra. Validar el JWT no usa la
// red (1 ms por validador) y consultar el permiso tarda 20 ms: suma unos 25 ms. El registro del
// intento es asíncrono y tarda milisegundos."
//
// Corre dentro de un contenedor en la red de la región 1 (con la imagen del gateway, que ya tiene
// Node y las dependencias), así las solicitudes van directo al nginx de la región y la base del
// registro de accesos se puede consultar cada pocos milisegundos con el mismo reloj:
// 1. Verificar el JWT: el Validador de Intercepción de packages/comun, con las claves reales de
//    Autenticación, verifica muchas veces el JWT de un usuario (sin red, como en cada solicitud).
// 2. Consultar el permiso: el mismo itinerario pedido por su dueño (no consulta a Usuarios) y por
//    una persona designada (Viajes le pregunta a Usuarios si está designada).
// 3. Registro: solicitudes rechazadas por el gateway (401 sin token, se guarda directo) y por
//    Viajes (403 de otro usuario, llega por el evento AccesoRechazado), y cuánto tarda cada una en
//    aparecer en accesos_rechazados.
//
// Uso: node tests/carga/seguridad.ts [--veces 300]   (con npm run infra:levantar)
import { randomUUID } from 'node:crypto';

const DENTRO = process.env.MEDIR_DENTRO === '1';
const escribir = (linea = '') => process.stdout.write(`${linea}\n`);

if (!DENTRO) {
  // En la computadora: lanza este mismo script en un contenedor de la red r1_region.
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { leerEnv } = await import('../../infra/scripts/entorno.ts');
  const env = leerEnv(readFileSync(new URL('../../.env', import.meta.url), 'utf8'));
  const carpeta = fileURLToPath(new URL('.', import.meta.url));
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'r1_region',
      '-e',
      'MEDIR_DENTRO=1',
      '-e',
      'CLAVE_BD_ADMIN',
      '-v',
      `${carpeta}:/app/tests/carga:ro`,
      '--entrypoint',
      'node',
      'trotamundos/gateway:dev',
      '/app/tests/carga/seguridad.ts',
      ...process.argv.slice(2),
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, CLAVE_BD_ADMIN: env.CLAVE_BD_ADMIN, MSYS_NO_PATHCONV: '1' },
    },
  );
  process.exit(0);
}

const { crearLogger, crearValidador } = await import('@trotamundos/comun');
const pg = (await import('pg')).default;
const { duracion, percentil } = await import('./calculos.ts');

const API = 'http://nginx:8080';
const i = process.argv.indexOf('--veces');
const VECES = i >= 0 ? Number(process.argv[i + 1]) : 300;
const ahora = () => performance.timeOrigin + performance.now();
const esperar = (ms: number) => new Promise((listo) => setTimeout(listo, ms));
const ms = (n: number) => `${n.toFixed(n < 10 ? 2 : 0).replace('.', ',')} ms`;

interface Usuario {
  email: string;
  jwt: string;
}

async function pedir(ruta: string, init: RequestInit & { jwt?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('X-Region', 'region-1');
  if (init.jwt) headers.set('Authorization', `Bearer ${init.jwt}`);
  const resp = await fetch(`${API}${ruta}`, { ...init, headers });
  const texto = await resp.text();
  return {
    status: resp.status,
    datos: texto ? (JSON.parse(texto) as Record<string, unknown>) : {},
  };
}

async function crearUsuario(nombre: string): Promise<Usuario> {
  const email = `seguridad-${randomUUID().slice(0, 8)}@correo.example`;
  const contrasena = 'Viajar-Seguridad-2026!';
  const registro = await pedir('/api/autenticacion/registro', {
    method: 'POST',
    body: JSON.stringify({ nombre, email, contrasena, region: 'region-1', idioma: 'es' }),
  });
  if (registro.status !== 201) throw new Error(`Registro: HTTP ${registro.status}`);
  const login = await pedir('/api/autenticacion/login', {
    method: 'POST',
    body: JSON.stringify({ email, contrasena }),
  });
  return { email, jwt: String(login.datos.jwt) };
}

const resumen = (valores: number[]) => {
  const ordenados = [...valores].sort((a, b) => a - b);
  return { p50: percentil(ordenados, 50), p95: percentil(ordenados, 95) };
};

// --- Preparación: dueño con un viaje, una persona designada y otro usuario ------------------
const dueno = await crearUsuario('Viajera Dueña');
const designado = await crearUsuario('Viajero Designado');
const otro = await crearUsuario('Viajero Ajeno');
const reserva = await pedir('/api/viajes/reservas', {
  method: 'POST',
  jwt: dueno.jwt,
  body: JSON.stringify({
    proveedor: 'aerolinea-andina',
    tipoReserva: 'vuelo',
    numeroReserva: `SEG${Date.now()}`,
    inicio: '2026-12-20T08:30:00Z',
    fin: '2026-12-20T10:40:00Z',
    origen: 'Buenos Aires (EZE)',
    destino: 'Santiago (SCL)',
  }),
});
if (reserva.status !== 201) throw new Error(`Reserva: HTTP ${reserva.status}`);
const panel = await pedir('/api/viajes/panel', { jwt: dueno.jwt });
const viajeId = String((panel.datos.viajes as { viajeId: string }[])[0]?.viajeId);
const designar = await pedir(`/api/usuarios/itinerarios/${viajeId}/designados`, {
  method: 'POST',
  jwt: dueno.jwt,
  body: JSON.stringify({ email: designado.email }),
});
if (designar.status >= 300) throw new Error(`Designar: HTTP ${designar.status}`);

// --- 1. Verificar el JWT --------------------------------------------------------------------
const validador = crearValidador({
  servicio: 'medicion',
  region: 'region-1',
  logger: crearLogger({ servicio: 'medicion', region: 'region-1', nivel: 'silent' }),
  claves: { 'region-1': { url: 'http://autenticacion:3001/.well-known/jwks.json' } },
  registrar: () => undefined,
});
await validador.iniciar();
for (let n = 0; n < 200; n += 1) await validador.verificarToken(dueno.jwt);
const verificaciones: number[] = [];
for (let n = 0; n < 5000; n += 1) {
  const t0 = performance.now();
  await validador.verificarToken(dueno.jwt);
  verificaciones.push(performance.now() - t0);
}
validador.detener();
const jwt = resumen(verificaciones);

// --- 2. Consultar el permiso: dueño contra persona designada ---------------------------------
const tiempos = { dueno: [] as number[], designado: [] as number[] };
for (let n = 0; n < 20; n += 1) {
  await pedir(`/api/viajes/viajes/${viajeId}`, { jwt: dueno.jwt });
  await pedir(`/api/viajes/viajes/${viajeId}`, { jwt: designado.jwt });
}
for (let n = 0; n < VECES; n += 1) {
  for (const [quien, usuario] of [
    ['dueno', dueno],
    ['designado', designado],
  ] as const) {
    const t0 = performance.now();
    const r = await pedir(`/api/viajes/viajes/${viajeId}`, { jwt: usuario.jwt });
    if (r.status !== 200) throw new Error(`Itinerario (${quien}): HTTP ${r.status}`);
    tiempos[quien].push(performance.now() - t0);
  }
}
const deDueno = resumen(tiempos.dueno);
const deDesignado = resumen(tiempos.designado);

// --- 3. Registro de los accesos rechazados ---------------------------------------------------
const base = new pg.Client({
  connectionString: `postgres://admin:${process.env.CLAVE_BD_ADMIN}@postgres:5432/registro_accesos`,
});
await base.connect();

/** Manda una solicitud que tiene que ser rechazada y mide cuándo aparece en el registro. */
async function medirRegistro(ruta: string, statusEsperado: number, jwtDe?: string) {
  const requestId = randomUUID();
  const enviada = ahora();
  const r = await fetch(`${API}${ruta}`, {
    headers: {
      'X-Request-Id': requestId,
      'X-Region': 'region-1',
      ...(jwtDe ? { Authorization: `Bearer ${jwtDe}` } : {}),
    },
  });
  await r.text();
  const respondida = ahora();
  if (r.status !== statusEsperado) throw new Error(`${ruta}: HTTP ${r.status}`);
  for (;;) {
    const { rowCount } = await base.query(
      'SELECT 1 FROM accesos_rechazados WHERE request_id = $1',
      [requestId],
    );
    if (rowCount) return { desdeRespuesta: ahora() - respondida, desdeEnvio: ahora() - enviada };
    if (ahora() - respondida > 10_000) return { desdeRespuesta: NaN, desdeEnvio: NaN };
    await esperar(2);
  }
}

const VECES_REGISTRO = 100;
const registro = { gateway: [] as number[], viajes: [] as number[], perdidos: 0 };
for (let n = 0; n < VECES_REGISTRO; n += 1) {
  const g = await medirRegistro('/api/viajes/panel', 401);
  const v = await medirRegistro(`/api/viajes/viajes/${viajeId}`, 403, otro.jwt);
  for (const [donde, m] of [
    ['gateway', g],
    ['viajes', v],
  ] as const) {
    if (Number.isNaN(m.desdeRespuesta)) registro.perdidos += 1;
    else registro[donde].push(m.desdeRespuesta);
  }
}
await base.end();
const regGateway = resumen(registro.gateway);
const regViajes = resumen(registro.viajes);
const maximo = (v: number[]) => Math.max(...v);

escribir('QA-9: costo de la seguridad y registro de accesos rechazados (región 1)');
escribir(`  Verificar el JWT (5.000 veces):       p50 ${ms(jwt.p50)}, p95 ${ms(jwt.p95)}`);
escribir(
  `  Itinerario, dueño (${VECES}):             p50 ${ms(deDueno.p50)}, p95 ${ms(deDueno.p95)}`,
);
escribir(
  `  Itinerario, designado (${VECES}):         p50 ${ms(deDesignado.p50)}, p95 ${ms(deDesignado.p95)}`,
);
escribir(
  `  Consultar el permiso (designado − dueño): p50 ${ms(deDesignado.p50 - deDueno.p50)}, p95 ${ms(deDesignado.p95 - deDueno.p95)}`,
);
escribir(
  `  Registro, 401 del gateway (${registro.gateway.length}):    p50 ${ms(regGateway.p50)}, p95 ${ms(regGateway.p95)}, máximo ${duracion(maximo(registro.gateway))} después de la respuesta`,
);
escribir(
  `  Registro, 403 de Viajes (${registro.viajes.length}):       p50 ${ms(regViajes.p50)}, p95 ${ms(regViajes.p95)}, máximo ${duracion(maximo(registro.viajes))} después de la respuesta`,
);
escribir(`  Rechazos que no aparecieron en 10 s:  ${registro.perdidos}`);
escribir(
  JSON.stringify({
    jwt,
    itinerario: { dueno: deDueno, designado: deDesignado },
    registro: {
      gateway: { ...regGateway, maximo: maximo(registro.gateway), n: registro.gateway.length },
      viajes: { ...regViajes, maximo: maximo(registro.viajes), n: registro.viajes.length },
      perdidos: registro.perdidos,
    },
  }),
);
