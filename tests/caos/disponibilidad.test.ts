// Pruebas de caos y disponibilidad (P3.5, QA-4, ADR-002, ADR-004, ADR-006, ADR-007, ADR-008,
// ADR-011, ADR-012, ADR-017). Mientras un generador hace solicitudes continuas al panel, provoca
// cinco fallas reales y mide disponibilidad, tiempos de detección, drenado de cola y failover:
//   1. Matar una instancia de un servicio (gateway) -> <= 15 s de detección y ~0 errores.
//   2. Matar un nodo de RabbitMQ (perfil --ha) -> 0 eventos perdidos en colas quorum.
//   3. Detener Viajes 2 minutos -> los eventos esperan en el broker y se procesan al volver.
//   4. Detener principal postgres-viajes -> npm run infra:failover-viajes en < 1 min.
//   5. Detener Redis -> el panel responde desde la read replica (X-Origen-Dato: replica).
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leerEnv } from '../../infra/scripts/entorno.ts';
import {
  ejecutarFailoverViajes,
  restaurarPrincipalViajes,
} from '../../infra/scripts/failover-viajes.ts';
import {
  CONFIG_E2E,
  conectarOAuthMock,
  desconectarCuentasCorreo,
  eliminarReservasUsuario,
  esperarCondicion,
  idAleatorio,
  inyectarCorreo,
  pedirJson,
  registrarYLogin,
  reiniciarMock,
  sistemaDisponible,
  type SesionE2E,
} from '../e2e/comun.ts';

const exec = promisify(execFile);
const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const RUTA_ENV = resolve(RAIZ, '.env');
const ENV_ARCHIVO = existsSync(RUTA_ENV) ? leerEnv(readFileSync(RUTA_ENV, 'utf8')) : {};
const URL_NGINX_R1 = `http://localhost:${ENV_ARCHIVO.PUERTO_NGINX_REGION_1 ?? '8081'}`;
const MARGEN_RELOJ_MS = 1500;
const PAUSA_VIAJES_MS = Number(process.env.CAOS_PAUSA_VIAJES_MS ?? 120_000);

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function docker(...args: string[]): Promise<string> {
  return (await exec('docker', args, { encoding: 'utf8' })).stdout.trim();
}

async function contenedorArriba(nombre: string): Promise<boolean> {
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

async function estadoMonitorR1(): Promise<InstanciaMonitor[]> {
  const salida = await docker(
    'exec',
    'r1-monitor-1',
    'node',
    '-e',
    "fetch('http://127.0.0.1:3010/estado').then((r) => r.text()).then(console.log)",
  );
  return (JSON.parse(salida) as { instancias: InstanciaMonitor[] }).instancias;
}

async function esperarSaludViajesR1(): Promise<void> {
  const limite = Date.now() + 60_000;
  while (Date.now() < limite) {
    try {
      const resp = await fetch(`${URL_NGINX_R1}/salud/viajes`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.status === 200) return;
    } catch {
      // Sigue esperando salud de Viajes.
    }
    await esperar(300);
  }
  throw new Error('r1/viajes no volvió a responder 200 en /salud/viajes dentro de 60 s.');
}

interface ResumenTraficoPanel {
  total: number;
  exitosas200: number;
  errores: number;
  porcentajeError: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  desdeCache: number;
  desdeReplica: number;
  duracionTotalMs: number;
}

function percentil(ordenados: number[], p: number): number {
  if (ordenados.length === 0) return 0;
  const idx = Math.min(ordenados.length - 1, Math.floor((p / 100) * (ordenados.length - 1)));
  return ordenados[idx] ?? 0;
}

/** Generador continuo de lecturas al panel autenticado (GET /api/viajes/panel). */
function iniciarGeneradorPanel(sesion: SesionE2E, intervaloMs = 150) {
  let activo = true;
  let exitosas200 = 0;
  let errores = 0;
  let desdeCache = 0;
  let desdeReplica = 0;
  const latencias200: number[] = [];
  const inicio = Date.now();

  const bucle = (async () => {
    while (activo) {
      const t0 = performance.now();
      try {
        const resp = await fetch(`${CONFIG_E2E.urlEnrutador}/api/viajes/panel`, {
          headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
          signal: AbortSignal.timeout(4000),
        });
        await resp.body?.cancel();
        const ms = Math.round(performance.now() - t0);
        if (resp.status === 200) {
          exitosas200 += 1;
          latencias200.push(ms);
          const origen = resp.headers.get('x-origen-dato');
          if (origen === 'cache') desdeCache += 1;
          else if (origen === 'replica') desdeReplica += 1;
        } else {
          errores += 1;
        }
      } catch {
        errores += 1;
      }
      await esperar(intervaloMs);
    }
  })();

  return {
    async detener(): Promise<ResumenTraficoPanel> {
      activo = false;
      await bucle;
      const duracionTotalMs = Date.now() - inicio;
      const total = exitosas200 + errores;
      const ordenadas = [...latencias200].sort((a, b) => a - b);
      return {
        total,
        exitosas200,
        errores,
        porcentajeError: total === 0 ? 0 : Math.round((errores / total) * 10_000) / 100,
        p50Ms: percentil(ordenadas, 50),
        p95Ms: percentil(ordenadas, 95),
        maxMs: ordenadas.at(-1) ?? 0,
        desdeCache,
        desdeReplica,
        duracionTotalMs,
      };
    },
  };
}

function registrarMedicion(etiqueta: string, datos: Record<string, string | number>): void {
  const pares = Object.entries(datos)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  process.stdout.write(`[CAOS QA-4] ${etiqueta}: ${pares}\n`);
}

function armarJsonLdVuelo(codigo: string, nombrePasajero: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FlightReservation',
    reservationNumber: codigo,
    reservationStatus: 'https://schema.org/ReservationConfirmed',
    underName: { '@type': 'Person', name: nombrePasajero },
    reservationFor: {
      '@type': 'Flight',
      flightNumber: 'AN 5050',
      airline: { '@type': 'Airline', name: 'Aerolínea Andina', iataCode: 'AN' },
      departureAirport: { '@type': 'Airport', name: 'Buenos Aires', iataCode: 'EZE' },
      arrivalAirport: { '@type': 'Airport', name: 'Santiago', iataCode: 'SCL' },
      departureTime: '2026-12-28T09:00:00Z',
      arrivalTime: '2026-12-28T11:15:00Z',
    },
    airplaneSeat: '11A',
  };
}

const haySistema =
  (await sistemaDisponible()) &&
  (await contenedorArriba('r1-monitor-1')) &&
  (await contenedorArriba('r1-viajes-1')) &&
  (await contenedorArriba('r1-postgres-viajes-1')) &&
  (await contenedorArriba('r1-postgres-viajes-replica-1')) &&
  (await contenedorArriba('r1-redis-1'));

const hayRabbitHa =
  haySistema &&
  (await contenedorArriba('r1-rabbitmq-1')) &&
  (await contenedorArriba('r1-rabbitmq-2-1')) &&
  (await contenedorArriba('r1-rabbitmq-3-1'));

describe.skipIf(!haySistema)('Caos y disponibilidad del sistema completo (P3.5, QA-4)', () => {
  let sesion: SesionE2E;
  const buzonGmail = `caos-${idAleatorio()}@gmail.example`;

  beforeAll(async () => {
    sesion = await registrarYLogin({ nombre: 'Viajero Caos QA4' });
    await conectarOAuthMock({
      proveedor: 'gmail',
      emailBuzon: buzonGmail,
      jwt: sesion.jwt,
      region: sesion.region,
    });
    // Sembrar una reserva manual inicial para que el panel tenga datos desde el principio.
    const alta = await pedirJson(`${CONFIG_E2E.urlEnrutador}/api/viajes/reservas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sesion.jwt}`,
        'X-Region': sesion.region,
      },
      body: JSON.stringify({
        proveedor: 'aerolinea-andina',
        tipoReserva: 'vuelo',
        numeroReserva: `CAOS-BASE-${idAleatorio()}`,
        inicio: '2026-12-27T08:00:00Z',
        fin: '2026-12-27T10:15:00Z',
        origen: 'Buenos Aires (EZE)',
        destino: 'Santiago (SCL)',
        detalle: { numeroVuelo: 'AN 1001', asiento: '3A' },
      }),
    });
    expect(alta.status).toBe(201);
  });

  afterAll(async () => {
    if (!sesion) return;
    await eliminarReservasUsuario(sesion);
    await desconectarCuentasCorreo(sesion);
    await reiniciarMock(CONFIG_E2E.urlMockAerolinea);
  });

  it('1. matar una instancia de gateway: detección <= 15 s y panel con ~0 errores (ADR-006/007/008)', async () => {
    const victima = 'r1-gateway-1';
    let estadoInicial = (await estadoMonitorR1()).find((i) => i.nombre === victima);
    for (let i = 0; i < 30 && estadoInicial?.estado !== 'sana'; i++) {
      await esperar(1000);
      estadoInicial = (await estadoMonitorR1()).find((x) => x.nombre === victima);
    }
    expect(estadoInicial?.estado).toBe('sana');

    const generador = iniciarGeneradorPanel(sesion, 100);
    const inicio = Date.now();
    let detectadaEnMs: number;

    try {
      await docker('kill', victima);

      let detectada: InstanciaMonitor | undefined;
      while (Date.now() - inicio < 30_000) {
        const actual = (await estadoMonitorR1()).find((i) => i.nombre === victima);
        if (
          actual?.caidaDetectadaEn &&
          actual.caidaDetectadaEn !== estadoInicial?.caidaDetectadaEn
        ) {
          detectada = actual;
          break;
        }
        await esperar(250);
      }
      expect(detectada, 'el monitor no detectó la caída dentro de 30 s').toBeDefined();
      detectadaEnMs = Date.parse(detectada?.caidaDetectadaEn ?? '') - inicio;
      expect(detectadaEnMs).toBeLessThanOrEqual(15_000 + MARGEN_RELOJ_MS);
      expect(detectada?.reinicios).toBe((estadoInicial?.reinicios ?? 0) + 1);

      let recuperada = (await estadoMonitorR1()).find((i) => i.nombre === victima);
      while (recuperada?.estado !== 'sana' && Date.now() - inicio < 90_000) {
        await esperar(1000);
        recuperada = (await estadoMonitorR1()).find((i) => i.nombre === victima);
      }
      expect(recuperada?.estado).toBe('sana');
    } finally {
      if (!(await contenedorArriba(victima))) {
        await docker('start', victima).catch(() => undefined);
      }
    }

    const metricas = await generador.detener();
    registrarMedicion('1_matar_instancia_gateway', {
      detectadaEnMs,
      totalSolicitudes: metricas.total,
      exitosas200: metricas.exitosas200,
      errores: metricas.errores,
      porcentajeError: metricas.porcentajeError,
      p95Ms: metricas.p95Ms,
    });
    expect(metricas.total).toBeGreaterThan(40);
    expect(metricas.errores).toBeLessThanOrEqual(1);
  });

  it.skipIf(!hayRabbitHa)(
    '2. matar un nodo de RabbitMQ (perfil ha): cero eventos perdidos y el panel sigue respondiendo (ADR-002)',
    async () => {
      // Asegurar que los 3 nodos están en el cluster antes de provocar la caída.
      const statusCluster = await docker('exec', 'r1-rabbitmq-1', 'rabbitmqctl', 'cluster_status');
      expect(statusCluster).toContain('rabbit@rabbitmq-2');

      const generador = iniciarGeneradorPanel(sesion, 150);
      const codigos = Array.from({ length: 4 }, (_, i) => `CAOS-RMQ-${i}-${idAleatorio()}`);

      try {
        await docker('kill', 'r1-rabbitmq-2-1');

        for (const codigo of codigos) {
          const jsonLd = armarJsonLdVuelo(codigo, sesion.nombre);
          await inyectarCorreo(CONFIG_E2E.urlMockGmail, buzonGmail, {
            de: 'Aerolínea Andina <reservas@aerolinea-andina.example>',
            asunto: `Vuelo RMQ ${codigo}`,
            texto: `Reserva ${codigo} confirmada.`,
            html:
              '<!doctype html><html><head><script type="application/ld+json">' +
              JSON.stringify(jsonLd) +
              '</script></head><body>Confirmado</body></html>',
          });
        }

        // Esperar a que las 4 reservas detectadas atraviesen el cluster degradado (2/3 nodos) hasta el panel.
        await esperarCondicion(
          async () => {
            const resp = await pedirJson<{ viajes: { reservas: { numeroReserva: string }[] }[] }>(
              `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
              { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
            );
            const encontradas = new Set(
              (resp.datos?.viajes ?? []).flatMap((v) => v.reservas.map((r) => r.numeroReserva)),
            );
            return codigos.every((c) => encontradas.has(c)) ? true : undefined;
          },
          35_000,
          1_000,
        );
      } finally {
        await docker('start', 'r1-rabbitmq-2-1').catch(() => undefined);
      }

      const metricas = await generador.detener();
      registrarMedicion('2_matar_nodo_rabbitmq_ha', {
        eventosEnviados: codigos.length,
        eventosProcesados: codigos.length,
        totalSolicitudesPanel: metricas.total,
        erroresPanel: metricas.errores,
        p95Ms: metricas.p95Ms,
      });
      expect(metricas.errores).toBe(0);
    },
  );

  it('3. detener Viajes 2 minutos: los eventos esperan en el broker y se procesan al volver (ADR-002)', async () => {
    const codigoBase = `CAOS-VJE-BASE-${idAleatorio()}`;
    const codigoNuevo = `CAOS-VJE-NUEVO-${idAleatorio()}`;

    // Crear orden en mock-aerolínea y confirmarla por correo antes de detener Viajes.
    const respOrden = await fetch(`${CONFIG_E2E.urlMockAerolinea}/admin/ordenes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        booking_reference: codigoBase,
        status: 'confirmed',
        passenger: { given_name: 'Viajero', family_name: 'Caos' },
        flight_number: '5050',
        origin_iata: 'EZE',
        origin_city: 'Buenos Aires',
        destination_iata: 'SCL',
        destination_city: 'Santiago',
        departing_at: '2026-12-28T09:00:00Z',
        arriving_at: '2026-12-28T11:15:00Z',
        seat: '11A',
      }),
    });
    expect(respOrden.status).toBe(201);

    await inyectarCorreo(CONFIG_E2E.urlMockGmail, buzonGmail, {
      de: 'Aerolínea Andina <reservas@aerolinea-andina.example>',
      asunto: `Vuelo base ${codigoBase}`,
      texto: `Confirmación ${codigoBase}`,
      html:
        '<!doctype html><html><head><script type="application/ld+json">' +
        JSON.stringify(armarJsonLdVuelo(codigoBase, sesion.nombre)) +
        '</script></head><body>Confirmado</body></html>',
    });

    await esperarCondicion(
      async () => {
        const resp = await pedirJson<{ viajes: { reservas: { numeroReserva: string }[] }[] }>(
          `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
          { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
        );
        const lista = (resp.datos?.viajes ?? []).flatMap((v) => v.reservas);
        return lista.some((r) => r.numeroReserva === codigoBase) ? true : undefined;
      },
      25_000,
      1_000,
    );

    const generador = iniciarGeneradorPanel(sesion, 500);
    let drenadoEnMs: number;

    try {
      // Pausar monitor para que no reinicie Viajes antes de cumplir los 2 minutos de prueba.
      await docker('pause', 'r1-monitor-1');
      await docker('stop', 'r1-viajes-1');

      // Disparar ambos eventos mientras Viajes está completamente apagado.
      await inyectarCorreo(CONFIG_E2E.urlMockGmail, buzonGmail, {
        de: 'Aerolínea Andina <reservas@aerolinea-andina.example>',
        asunto: `Nueva reserva durante caída ${codigoNuevo}`,
        texto: `Confirmación ${codigoNuevo}`,
        html:
          '<!doctype html><html><head><script type="application/ld+json">' +
          JSON.stringify(armarJsonLdVuelo(codigoNuevo, sesion.nombre)) +
          '</script></head><body>Confirmado</body></html>',
      });

      const respCambio = await fetch(
        `${CONFIG_E2E.urlMockAerolinea}/admin/ordenes/${codigoBase}/cambiar`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ desplazarMinutos: 60 }),
        },
      );
      expect(respCambio.status).toBe(200);

      await esperar(PAUSA_VIAJES_MS);

      const inicioRecuperacion = Date.now();
      await docker('start', 'r1-viajes-1');
      await docker('unpause', 'r1-monitor-1');
      await esperarSaludViajesR1();

      // Ambos eventos encolados en RabbitMQ deben aplicarse apenas regresa Viajes.
      await esperarCondicion(
        async () => {
          const resp = await pedirJson<{
            viajes: { reservas: { numeroReserva: string; estado: string }[] }[];
          }>(`${CONFIG_E2E.urlEnrutador}/api/viajes/panel`, {
            headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
          });
          if (resp.status !== 200 || !resp.datos) return undefined;
          const reservas = resp.datos.viajes.flatMap((v) => v.reservas);
          const nuevaOk = reservas.some(
            (r) => r.numeroReserva === codigoNuevo && r.estado === 'confirmada',
          );
          const modificadaOk = reservas.some(
            (r) => r.numeroReserva === codigoBase && r.estado === 'modificada',
          );
          return nuevaOk && modificadaOk ? true : undefined;
        },
        30_000,
        500,
      );
      drenadoEnMs = Date.now() - inicioRecuperacion;
    } finally {
      await docker('start', 'r1-viajes-1').catch(() => undefined);
      await docker('unpause', 'r1-monitor-1').catch(() => undefined);
    }

    const metricas = await generador.detener();
    registrarMedicion('3_detener_viajes_2_min', {
      pausaMs: PAUSA_VIAJES_MS,
      drenadoEnMs,
      totalSolicitudesPanel: metricas.total,
      exitosas200: metricas.exitosas200,
      erroresDuranteCaida: metricas.errores,
    });
    expect(metricas.exitosas200).toBeGreaterThanOrEqual(1);
    expect(drenadoEnMs).toBeLessThan(30_000);
  });

  it('4. detener base principal de Viajes: npm run infra:failover-viajes promueve réplica en < 1 min (ADR-012)', async () => {
    const generador = iniciarGeneradorPanel(sesion, 150);
    let duracionFailoverMs: number;

    try {
      await docker('stop', 'r1-postgres-viajes-1');

      const resultado = await ejecutarFailoverViajes('r1', ENV_ARCHIVO);
      duracionFailoverMs = resultado.duracionMs;
      expect(resultado.enRecuperacionDespues).toBe('f');
      expect(duracionFailoverMs).toBeLessThan(60_000);

      // Con r1-postgres-viajes-1 aún apagada, las escrituras y lecturas ya funcionan contra la réplica promovida.
      const codigoPostFailover = `CAOS-FO-${idAleatorio()}`;
      const altaPost = await pedirJson<{ reservaId: string; numeroReserva: string }>(
        `${CONFIG_E2E.urlEnrutador}/api/viajes/reservas`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sesion.jwt}`,
            'X-Region': sesion.region,
          },
          body: JSON.stringify({
            proveedor: 'hotel-cordillera',
            tipoReserva: 'hotel',
            numeroReserva: codigoPostFailover,
            inicio: '2026-12-28T15:00:00Z',
            fin: '2026-12-29T11:00:00Z',
            destino: 'Santiago',
          }),
        },
      );
      expect(altaPost.status).toBe(201);

      const panelPost = await pedirJson<{
        viajes: { reservas: { numeroReserva: string }[] }[];
      }>(`${CONFIG_E2E.urlEnrutador}/api/viajes/panel`, {
        headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
      });
      expect(panelPost.status).toBe(200);
      expect(
        (panelPost.datos?.viajes ?? []).some((v) =>
          v.reservas.some((r) => r.numeroReserva === codigoPostFailover),
        ),
      ).toBe(true);
    } finally {
      await restaurarPrincipalViajes('r1', ENV_ARCHIVO);
    }

    const metricas = await generador.detener();
    registrarMedicion('4_failover_postgres_viajes', {
      duracionFailoverMs,
      totalSolicitudesPanel: metricas.total,
      exitosas200: metricas.exitosas200,
      erroresDuranteReinicio: metricas.errores,
      p95Ms: metricas.p95Ms,
    });
  });

  it('5. Redis caído: el panel sigue respondiendo desde la read replica sin errores (ADR-004/011)', async () => {
    // Asegurar que antes de apagar Redis la cache está poblada.
    const calentar1 = await pedirJson(`${CONFIG_E2E.urlEnrutador}/api/viajes/panel`, {
      headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
    });
    expect(calentar1.status).toBe(200);
    const calentar2 = await pedirJson(`${CONFIG_E2E.urlEnrutador}/api/viajes/panel`, {
      headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
    });
    expect(calentar2.status).toBe(200);
    expect(calentar2.headers.get('x-origen-dato')).toBe('cache');

    let metricasCaido: ResumenTraficoPanel;
    const generador = iniciarGeneradorPanel(sesion, 100);

    try {
      await docker('stop', 'r1-redis-1');
      await esperar(4000);
    } finally {
      metricasCaido = await generador.detener();
      await docker('start', 'r1-redis-1').catch(() => undefined);
    }

    expect(metricasCaido.errores).toBe(0);
    expect(metricasCaido.desdeReplica).toBeGreaterThanOrEqual(5);
    expect(metricasCaido.p95Ms).toBeLessThan(800);

    // Tras levantar Redis, el servicio reconecta automáticamente y vuelve a servir desde cache.
    await esperarCondicion(
      async () => {
        const resp = await pedirJson(`${CONFIG_E2E.urlEnrutador}/api/viajes/panel`, {
          headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
        });
        return resp.status === 200 && resp.headers.get('x-origen-dato') === 'cache'
          ? true
          : undefined;
      },
      15_000,
      500,
    );

    registrarMedicion('5_redis_caido_fallback_replica', {
      totalSolicitudes: metricasCaido.total,
      errores: metricasCaido.errores,
      desdeReplica: metricasCaido.desdeReplica,
      p50Ms: metricasCaido.p50Ms,
      p95Ms: metricasCaido.p95Ms,
    });
  });
});
