// Pruebas de integración de P2.D2 contra PostgreSQL 17, RabbitMQ 4 (testcontainers) y los mocks
// reales de aerolínea, hotel y rentadora:
// - Aviso de la aerolínea (cambio y cancelación) -> evento ReservaActualizada en segundos.
// - Aviso repetido -> 200 repetido y NO publica un segundo evento (dedup proveedor + reserva + versión).
// - Webhook con firma inválida o vencida -> 401 firma-invalida y nada publicado.
// - Webhook con cuerpo no JSON o JSON no traducible -> guardado en no_traducidos sin PII y
//   consultable por GET /interna/no-traducidos con token de servicio `pruebas` (403 a otros).
// - Cambio y cancelación en hotel y rentadora -> evento en menos de 2 min por consulta periódica,
//   diff mínimo, sin duplicados y sin perder cambios ante 503 temporal.
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  conectarBroker,
  crearPool,
  crearValidador,
  iniciarPublicadorOutbox,
  migrar,
  MIGRACIONES_EVENTOS,
  type Broker,
  type Pool,
  type PublicadorOutbox,
  type Servidor,
  type Sobre,
} from '@trotamundos/comun';
import {
  dockerDisponible,
  firmarJwt,
  firmarTokenServicio,
  generarClaves,
  levantarPostgres,
  levantarRabbit,
  loggerDePrueba,
  type ContenedorPostgres,
  type ContenedorRabbit,
} from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearMockAerolinea, type MockAerolinea } from '../../../mocks/aerolinea/src/app.ts';
import { crearMockHotel, type MockHotel } from '../../../mocks/hotel/src/app.ts';
import { crearMockRentadora, type MockRentadora } from '../../../mocks/rentadora/src/app.ts';
import type { DatosReservaActualizada } from '../src/adaptadores/tipos.ts';
import {
  crearApp,
  crearNegocioIntegraciones,
  REGLAS_VALIDADOR_INTEGRACIONES,
  SERVICIO,
  type NegocioIntegracionesCompleto,
} from '../src/app.ts';

const hayDocker = await dockerDisponible();
const claves = await generarClaves();

const CLAVE_AEROLINEA = 'clave-api-aerolinea-int';
const SECRETO_AEROLINEA = 'secreto-webhook-aerolinea-int';
const CLAVE_HOTEL = 'clave-api-hotel-int';
const CLAVE_RENTADORA = 'clave-api-rentadora-int';

function firmarWebhook(cuerpo: Buffer | string, timestampSeg = Math.floor(Date.now() / 1000)) {
  const bytes = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo, 'utf8');
  const v1 = createHmac('sha256', SECRETO_AEROLINEA)
    .update(`${timestampSeg}.`)
    .update(bytes)
    .digest('hex');
  return `t=${timestampSeg},v1=${v1}`;
}

async function esperarQue(
  condicion: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (!(await condicion())) {
    if (Date.now() > limite) throw new Error('Tiempo agotado esperando condición en prueba');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!hayDocker)(
  'Integraciones: adaptadores de proveedores (PostgreSQL + RabbitMQ + mocks reales)',
  { timeout: 120_000 },
  () => {
    const { logger } = loggerDePrueba(SERVICIO);

    let postgres: ContenedorPostgres;
    let rabbit: ContenedorRabbit;
    let pool: Pool;
    let brokerIntegraciones: Broker;
    let brokerConsumidor: Broker;
    let outbox: PublicadorOutbox;
    let servidor: Servidor;
    let negocio: NegocioIntegracionesCompleto;

    let mockAerolinea: MockAerolinea;
    let mockHotel: MockHotel;
    let mockRentadora: MockRentadora;

    let urlIntegraciones = '';
    let urlAerolinea = '';
    let urlHotel = '';
    let urlRentadora = '';

    const eventosRecibidos: Sobre<DatosReservaActualizada>[] = [];

    beforeAll(async () => {
      [postgres, rabbit] = await Promise.all([levantarPostgres(), levantarRabbit()]);
      pool = crearPool({ url: postgres.url });
      await migrar(
        pool,
        [MIGRACIONES_EVENTOS, fileURLToPath(new URL('../migrations/', import.meta.url))],
        logger,
      );

      [brokerIntegraciones, brokerConsumidor] = await Promise.all([
        conectarBroker({ url: rabbit.url, servicio: SERVICIO, region: 'region-1', logger }),
        conectarBroker({
          url: rabbit.url,
          servicio: 'viajes-prueba',
          region: 'region-1',
          logger: loggerDePrueba('viajes-prueba').logger,
        }),
      ]);

      await brokerConsumidor.consumir<DatosReservaActualizada>({
        tipo: 'ReservaActualizada',
        pool,
        manejar: async (evento) => {
          eventosRecibidos.push(evento);
        },
      });

      mockAerolinea = crearMockAerolinea({
        puerto: 0,
        apiKey: CLAVE_AEROLINEA,
        webhookSecret: SECRETO_AEROLINEA,
        webhookUrls: [],
        logger: loggerDePrueba('mock-aerolinea').logger,
      });
      mockHotel = crearMockHotel({
        puerto: 0,
        apiKey: CLAVE_HOTEL,
        logger: loggerDePrueba('mock-hotel').logger,
      });
      mockRentadora = crearMockRentadora({
        puerto: 0,
        apiKey: CLAVE_RENTADORA,
        logger: loggerDePrueba('mock-rentadora').logger,
      });

      const [pAir, pHotel, pRent] = await Promise.all([
        mockAerolinea.iniciar(),
        mockHotel.iniciar(),
        mockRentadora.iniciar(),
      ]);
      urlAerolinea = `http://127.0.0.1:${pAir}`;
      urlHotel = `http://127.0.0.1:${pHotel}`;
      urlRentadora = `http://127.0.0.1:${pRent}`;

      const validador = crearValidador({
        servicio: SERVICIO,
        region: 'region-1',
        logger,
        claves: { 'region-1': { claves: claves.jwks } },
        registrar: () => undefined,
        reglas: REGLAS_VALIDADOR_INTEGRACIONES,
      });

      negocio = crearNegocioIntegraciones({
        pool,
        region: 'region-1',
        logger,
        env: {
          URL_AEROLINEA: urlAerolinea,
          CLAVE_API_AEROLINEA: CLAVE_AEROLINEA,
          SECRETO_WEBHOOK_AEROLINEA: SECRETO_AEROLINEA,
          URL_HOTEL: urlHotel,
          CLAVE_API_HOTEL: CLAVE_HOTEL,
          URL_RENTADORA: urlRentadora,
          CLAVE_API_RENTADORA: CLAVE_RENTADORA,
        },
        // Intervalo corto en pruebas (0,25 s) para validar polling automático mucho antes de 2 min.
        intervaloGlobalSeg: 0.25,
        ventanaInicialMs: 60_000,
        demoraInicialConsultaMs: 100,
      });

      outbox = iniciarPublicadorOutbox({
        pool,
        broker: brokerIntegraciones,
        logger,
        intervaloMs: 50,
      });

      servidor = crearApp({
        region: 'region-1',
        puerto: 0,
        logger,
        validador,
        negocio,
        manejarSenales: false,
        chequeos: {
          base: () => pool.query('SELECT 1'),
          broker: () => brokerIntegraciones.verificar(),
        },
      });
      const puertoInt = await servidor.iniciar();
      urlIntegraciones = `http://127.0.0.1:${puertoInt}`;

      // Apuntamos los webhooks del mock de aerolínea al servicio de integraciones real.
      const respWebhooks = await fetch(`${urlAerolinea}/admin/webhooks`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: [`${urlIntegraciones}/webhooks/proveedores/aerolinea-andina`],
          secreto: SECRETO_AEROLINEA,
        }),
      });
      expect(respWebhooks.status).toBe(200);
    }, 120_000);

    afterAll(async () => {
      await negocio?.consultador.detener();
      await outbox?.detener();
      await servidor?.detener();
      await Promise.all([mockAerolinea?.detener(), mockHotel?.detener(), mockRentadora?.detener()]);
      await Promise.all([brokerConsumidor?.cerrar(), brokerIntegraciones?.cerrar()]);
      await pool?.end();
      await Promise.all([rabbit?.detener(), postgres?.detener()]);
    }, 60_000);

    beforeEach(async () => {
      await negocio.consultador.detener();
      eventosRecibidos.length = 0;
      await pool.query(
        'TRUNCATE cambios_procesados, estado_reservas_proveedor, cursores_consulta, no_traducidos, opciones_reprogramacion_ofrecidas, eventos_salientes, eventos_procesados',
      );
      await Promise.all([
        fetch(`${urlAerolinea}/admin/reiniciar`, { method: 'POST' }),
        fetch(`${urlHotel}/admin/reiniciar`, { method: 'POST' }),
        fetch(`${urlRentadora}/admin/reiniciar`, { method: 'POST' }),
      ]);
    });

    it('aviso de la aerolínea (cambio y cancelación) publica ReservaActualizada en segundos y descarta repetidos', async () => {
      const inicio = Date.now();
      const respCambio = await fetch(`${urlAerolinea}/admin/ordenes/XKQ7PL/cambiar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desplazarMinutos: 165 }),
      });
      expect(respCambio.status).toBe(200);
      const { evento: eventoWebhook } = (await respCambio.json()) as {
        evento: Record<string, unknown>;
      };

      await esperarQue(() => eventosRecibidos.length === 1, 5_000);
      const demoraMs = Date.now() - inicio;
      expect(demoraMs).toBeLessThan(5_000);

      expect(eventosRecibidos[0]?.tipo).toBe('ReservaActualizada');
      expect(eventosRecibidos[0]?.datos).toMatchObject({
        proveedor: 'aerolinea-andina',
        numeroReserva: 'XKQ7PL',
        estado: 'modificada',
        origenCambio: 'proveedor',
      });
      expect(eventosRecibidos[0]?.datos.cambios.inicio).toBeDefined();
      expect(eventosRecibidos[0]?.datos.cambios.fin).toBeDefined();

      // Reenviar el mismo webhook firmado: debe responder 200 repetido y NO duplicar el evento.
      const cuerpoRepetido = JSON.stringify(eventoWebhook);
      const respDup = await fetch(`${urlIntegraciones}/webhooks/proveedores/aerolinea-andina`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': firmarWebhook(cuerpoRepetido),
        },
        body: cuerpoRepetido,
      });
      expect(respDup.status).toBe(200);
      expect(await respDup.json()).toEqual({ estado: 'repetido' });
      await outbox.publicarPendientes();
      await new Promise((r) => setTimeout(r, 200));
      expect(eventosRecibidos).toHaveLength(1);

      // Cancelación -> evento con estado cancelada y cambios vacío.
      const respCancel = await fetch(`${urlAerolinea}/admin/ordenes/XKQ7PL/cancelar`, {
        method: 'POST',
      });
      expect(respCancel.status).toBe(200);
      await esperarQue(() => eventosRecibidos.length === 2, 5_000);
      expect(eventosRecibidos[1]?.datos).toEqual({
        proveedor: 'aerolinea-andina',
        numeroReserva: 'XKQ7PL',
        estado: 'cancelada',
        cambios: {},
        origenCambio: 'proveedor',
      });
    });

    it('rechaza webhooks con firma inválida o vencida (401) y proveedores sin webhook (404)', async () => {
      const cuerpo = JSON.stringify({ id: 'wev_1' });

      // Firma incorrecta.
      const rFirmaMala = await fetch(`${urlIntegraciones}/webhooks/proveedores/aerolinea-andina`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
        },
        body: cuerpo,
      });
      expect(rFirmaMala.status).toBe(401);
      expect(rFirmaMala.headers.get('content-type')).toContain('application/problem+json');
      expect(await rFirmaMala.json()).toMatchObject({
        type: 'https://trotamundos.example/errores/firma-invalida',
        title: 'Firma inválida',
        status: 401,
      });

      // Firma vencida (10 minutos atrás).
      const rVencida = await fetch(`${urlIntegraciones}/webhooks/proveedores/aerolinea-andina`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': firmarWebhook(cuerpo, Math.floor(Date.now() / 1000) - 600),
        },
        body: cuerpo,
      });
      expect(rVencida.status).toBe(401);

      // Proveedor de consulta (hotel) y proveedor inexistente -> 404.
      const rHotel = await fetch(`${urlIntegraciones}/webhooks/proveedores/hotel-cordillera`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: cuerpo,
      });
      expect(rHotel.status).toBe(404);

      const rDesconocido = await fetch(`${urlIntegraciones}/webhooks/proveedores/inexistente`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: cuerpo,
      });
      expect(rDesconocido.status).toBe(404);

      await outbox.publicarPendientes();
      expect(eventosRecibidos).toHaveLength(0);
      const { rows } = await pool.query('SELECT count(*)::int AS total FROM no_traducidos');
      expect(rows[0]?.total).toBe(0);
    });

    it('guarda no traducidos (JSON inválido y cuerpo no JSON) sin PII y los expone solo a pruebas', async () => {
      // 1) Cuerpo no JSON con firma válida -> 400 + guardado con tamaño en bytes.
      const cuerpoNoJson = 'texto plano no json';
      const respNoJson = await fetch(`${urlIntegraciones}/webhooks/proveedores/aerolinea-andina`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': firmarWebhook(cuerpoNoJson),
        },
        body: cuerpoNoJson,
      });
      expect(respNoJson.status).toBe(400);

      // 2) JSON válido con firma válida pero no traducible (sin booking_reference y con PII).
      const cuerpoRoto = JSON.stringify({
        id: 'wev_roto_1',
        type: 'order.airline_initiated_change_detected',
        created_at: '2026-11-28T09:40:00Z',
        idempotency_key: 'roto-v1',
        data: {
          object: {
            order: {
              id: 'ord_roto',
              status: 'changed',
              version: 1,
              passengers: [
                {
                  id: 'pas_1',
                  given_name: 'Carlos',
                  family_name: 'Pérez',
                  email: 'carlos@correo.example',
                },
              ],
              segments: [],
            },
            removed: [],
            added: [],
          },
        },
      });
      const respNoTrad = await fetch(`${urlIntegraciones}/webhooks/proveedores/aerolinea-andina`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': firmarWebhook(cuerpoRoto),
        },
        body: cuerpoRoto,
      });
      expect(respNoTrad.status).toBe(200);
      expect(await respNoTrad.json()).toEqual({ estado: 'no-traducido' });

      // Token de usuario o de otro servicio -> 403.
      const tokenUsuario = await firmarJwt(claves);
      const tokenViajes = await firmarTokenServicio(claves, 'viajes');
      expect(
        (
          await fetch(`${urlIntegraciones}/interna/no-traducidos`, {
            headers: { Authorization: `Bearer ${tokenUsuario}` },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${urlIntegraciones}/interna/no-traducidos`, {
            headers: { Authorization: `Bearer ${tokenViajes}` },
          })
        ).status,
      ).toBe(403);

      // Token de servicio `pruebas` -> 200 con ambos mensajes ordenados del más nuevo al más viejo.
      const tokenPruebas = await firmarTokenServicio(claves, 'pruebas');
      const respLista = await fetch(
        `${urlIntegraciones}/interna/no-traducidos?proveedor=aerolinea-andina&limite=10`,
        { headers: { Authorization: `Bearer ${tokenPruebas}` } },
      );
      expect(respLista.status).toBe(200);
      const { mensajes } = (await respLista.json()) as {
        mensajes: Array<{
          proveedor: string;
          via: string;
          motivo: string;
          cuerpo: string;
        }>;
      };
      expect(mensajes).toHaveLength(2);
      expect(mensajes[0]?.motivo).toContain('booking_reference');
      expect(mensajes[0]?.cuerpo).not.toContain('Carlos');
      expect(mensajes[0]?.cuerpo).not.toContain('Pérez');
      expect(mensajes[0]?.cuerpo).not.toContain('carlos@correo.example');
      expect(mensajes[0]?.cuerpo).toContain('[quitado]');
      expect(mensajes[1]?.cuerpo).toBe(
        `[cuerpo no JSON de ${Buffer.byteLength(cuerpoNoJson, 'utf8')} bytes]`,
      );
    });

    it('consulta periódica de hotel: detecta cambios en < 2 min, calcula diff mínimo y resiste 503', async () => {
      // Primer cambio en el hotel sobre semilla HC-48213.
      const rCambio1 = await fetch(`${urlHotel}/admin/reservas/HC-48213/cambiar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkIn: '2026-12-11T15:00:00-03:00' }),
      });
      expect(rCambio1.status).toBe(200);

      // Arrancamos el consultador automático (intervalo 250 ms << 2 min).
      negocio.consultador.iniciar();

      await esperarQue(
        () =>
          eventosRecibidos.some(
            (e) => e.datos.proveedor === 'hotel-cordillera' && e.datos.numeroReserva === 'HC-48213',
          ),
        5_000,
      );
      await negocio.consultador.detener();

      const eventosHotel1 = eventosRecibidos.filter(
        (e) => e.datos.proveedor === 'hotel-cordillera' && e.datos.numeroReserva === 'HC-48213',
      );
      expect(eventosHotel1).toHaveLength(1);
      expect(eventosHotel1[0]?.datos).toMatchObject({
        proveedor: 'hotel-cordillera',
        numeroReserva: 'HC-48213',
        estado: 'modificada',
        origenCambio: 'proveedor',
      });
      expect(eventosHotel1[0]?.datos.cambios.inicio).toBe('2026-12-11T15:00:00-03:00');

      // Una nueva consulta sin cambios no debe duplicar el evento.
      const cicloSinCambios = await negocio.consultador.consultarProveedor('hotel-cordillera');
      expect(cicloSinCambios.aceptados).toBe(0);
      expect(cicloSinCambios.repetidos).toBeGreaterThanOrEqual(1);

      // Segundo cambio: solo cambia la descripción de habitación -> diff mínimo.
      const rCambio2 = await fetch(`${urlHotel}/admin/reservas/HC-48213/cambiar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomDescription: 'Suite cordillera vista montaña' }),
      });
      expect(rCambio2.status).toBe(200);

      const ciclo2 = await negocio.consultador.consultarProveedor('hotel-cordillera');
      expect(ciclo2.aceptados).toBe(1);
      await outbox.publicarPendientes();
      await esperarQue(
        () =>
          eventosRecibidos.filter(
            (e) => e.datos.proveedor === 'hotel-cordillera' && e.datos.numeroReserva === 'HC-48213',
          ).length === 2,
        5_000,
      );
      const eventoDiff = eventosRecibidos
        .filter(
          (e) => e.datos.proveedor === 'hotel-cordillera' && e.datos.numeroReserva === 'HC-48213',
        )
        .at(-1);
      expect(eventoDiff?.datos.cambios).toEqual({
        detalle: { habitacion: 'Suite cordillera vista montaña' },
      });

      // Resiliencia ante 503: mientras el hotel devuelve 503 ocurre una cancelación; al volver, no se pierde.
      const rFalla = await fetch(`${urlHotel}/admin/comportamiento`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modoFalla: '503' }),
      });
      expect(rFalla.status).toBe(200);
      await fetch(`${urlHotel}/admin/reservas/HC-48213/cancelar`, { method: 'POST' });

      const cicloCaido = await negocio.consultador.consultarProveedor('hotel-cordillera');
      expect(cicloCaido.error).toBeDefined();

      // Restaura el hotel -> en el siguiente ciclo la cancelación se procesa y publica.
      const rNormal = await fetch(`${urlHotel}/admin/comportamiento`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modoFalla: 'ninguna' }),
      });
      expect(rNormal.status).toBe(200);
      const cicloRecuperado = await negocio.consultador.consultarProveedor('hotel-cordillera');
      expect(cicloRecuperado.aceptados).toBe(1);
      await outbox.publicarPendientes();

      await esperarQue(
        () =>
          eventosRecibidos.some(
            (e) =>
              e.datos.proveedor === 'hotel-cordillera' &&
              e.datos.numeroReserva === 'HC-48213' &&
              e.datos.estado === 'cancelada',
          ),
        5_000,
      );
      const eventoCancel = eventosRecibidos.find(
        (e) =>
          e.datos.proveedor === 'hotel-cordillera' &&
          e.datos.numeroReserva === 'HC-48213' &&
          e.datos.estado === 'cancelada',
      );
      expect(eventoCancel?.datos.cambios).toEqual({});
    });

    it('consulta periódica de rentadora: detecta cambio, diff y cancelación sin duplicar', async () => {
      const rCambio = await fetch(`${urlRentadora}/admin/reservas/RS-77120/cambiar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleMake: 'Toyota', vehicleModel: 'Corolla' }),
      });
      expect(rCambio.status).toBe(200);

      const ciclo1 = await negocio.consultador.consultarProveedor('rentadora-sur');
      expect(ciclo1.aceptados).toBeGreaterThanOrEqual(1);
      await outbox.publicarPendientes();

      await esperarQue(
        () =>
          eventosRecibidos.some(
            (e) => e.datos.proveedor === 'rentadora-sur' && e.datos.numeroReserva === 'RS-77120',
          ),
        5_000,
      );
      const eventosRs1 = eventosRecibidos.filter(
        (e) => e.datos.proveedor === 'rentadora-sur' && e.datos.numeroReserva === 'RS-77120',
      );
      expect(eventosRs1).toHaveLength(1);
      expect(eventosRs1[0]?.datos).toMatchObject({
        proveedor: 'rentadora-sur',
        numeroReserva: 'RS-77120',
        estado: 'modificada',
        origenCambio: 'proveedor',
      });

      // Re-consulta sin cambios: repetido, no publica otro evento.
      const cicloDup = await negocio.consultador.consultarProveedor('rentadora-sur');
      expect(cicloDup.aceptados).toBe(0);
      expect(cicloDup.repetidos).toBeGreaterThanOrEqual(1);

      // Cancelación en la rentadora -> evento con estado cancelada y cambios vacío.
      const rCancel = await fetch(`${urlRentadora}/admin/reservas/RS-77120/cancelar`, {
        method: 'POST',
      });
      expect(rCancel.status).toBe(200);

      const cicloCancel = await negocio.consultador.consultarProveedor('rentadora-sur');
      expect(cicloCancel.aceptados).toBe(1);
      await outbox.publicarPendientes();

      await esperarQue(
        () =>
          eventosRecibidos.some(
            (e) =>
              e.datos.proveedor === 'rentadora-sur' &&
              e.datos.numeroReserva === 'RS-77120' &&
              e.datos.estado === 'cancelada',
          ),
        5_000,
      );
      const cancelada = eventosRecibidos.find(
        (e) =>
          e.datos.proveedor === 'rentadora-sur' &&
          e.datos.numeroReserva === 'RS-77120' &&
          e.datos.estado === 'cancelada',
      );
      expect(cancelada?.datos.cambios).toEqual({});
    });

    it('reprogramación (P2.D3): pide opciones, rechaza opción inventada, aplica opción válida idempotentemente y vuelve a entrar como ReservaActualizada', async () => {
      const tokenUsuario = await firmarJwt(claves);

      // 1) Proveedor sin reprogramación (hotel) -> 200 con opciones vacío.
      const respHotel = await fetch(`${urlIntegraciones}/interna/reprogramaciones/opciones`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUsuario}`,
        },
        body: JSON.stringify({ proveedor: 'hotel-cordillera', numeroReserva: 'HC-48213' }),
      });
      expect(respHotel.status).toBe(200);
      expect(await respHotel.json()).toEqual({
        proveedor: 'hotel-cordillera',
        numeroReserva: 'HC-48213',
        opciones: [],
      });

      // 2) Aplicar una opción inventada (nunca ofrecida) -> 404 sin llamar a la aerolínea.
      const respInventada = await fetch(`${urlIntegraciones}/interna/reprogramaciones/aplicar`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUsuario}`,
        },
        body: JSON.stringify({
          proveedor: 'aerolinea-andina',
          numeroReserva: 'XKQ7PL',
          opcionId: 'oco_inventada_999',
        }),
      });
      expect(respInventada.status).toBe(404);

      // 3) Pedir opciones reales a Aerolínea Andina.
      const respOpciones = await fetch(`${urlIntegraciones}/interna/reprogramaciones/opciones`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUsuario}`,
        },
        body: JSON.stringify({ proveedor: 'aerolinea-andina', numeroReserva: 'XKQ7PL' }),
      });
      expect(respOpciones.status).toBe(200);
      const { opciones } = (await respOpciones.json()) as {
        opciones: Array<{ opcionId: string; inicio: string; fin: string }>;
      };
      expect(opciones.length).toBeGreaterThanOrEqual(1);
      const elegida = opciones[0];
      if (!elegida) throw new Error('Se esperaba al menos una opción');

      // 4) Aplicar la opción elegida -> 200 aplicada + webhook order.updated -> ReservaActualizada en RabbitMQ.
      const respAplicar = await fetch(`${urlIntegraciones}/interna/reprogramaciones/aplicar`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUsuario}`,
        },
        body: JSON.stringify({
          proveedor: 'aerolinea-andina',
          numeroReserva: 'XKQ7PL',
          opcionId: elegida.opcionId,
        }),
      });
      expect(respAplicar.status).toBe(200);
      const resultadoAplicar = (await respAplicar.json()) as {
        estado: string;
        aplicadaEn: string;
        opcionId: string;
      };
      expect(resultadoAplicar).toMatchObject({
        proveedor: 'aerolinea-andina',
        numeroReserva: 'XKQ7PL',
        opcionId: elegida.opcionId,
        estado: 'aplicada',
      });

      // El mock de aerolínea disparó webhook order.updated -> llega ReservaActualizada a RabbitMQ.
      await esperarQue(
        () =>
          eventosRecibidos.some(
            (e) =>
              e.datos.proveedor === 'aerolinea-andina' &&
              e.datos.numeroReserva === 'XKQ7PL' &&
              e.datos.estado === 'modificada' &&
              e.datos.cambios.inicio === elegida.inicio,
          ),
        5_000,
      );

      // 5) Repetir aplicar la misma opción -> 200 idempotente con el mismo aplicadaEn.
      const respRepetida = await fetch(`${urlIntegraciones}/interna/reprogramaciones/aplicar`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUsuario}`,
        },
        body: JSON.stringify({
          proveedor: 'aerolinea-andina',
          numeroReserva: 'XKQ7PL',
          opcionId: elegida.opcionId,
        }),
      });
      expect(respRepetida.status).toBe(200);
      expect(await respRepetida.json()).toEqual(resultadoAplicar);

      // 6) Opción vencida -> 409 opcion-vencida.
      const segunda = opciones[1];
      if (segunda) {
        await pool.query(
          `UPDATE opciones_reprogramacion_ofrecidas
              SET vence_en = now() - interval '1 minute'
            WHERE proveedor = $1 AND numero_reserva = $2 AND opcion_id = $3`,
          ['aerolinea-andina', 'XKQ7PL', segunda.opcionId],
        );
        const respVencida = await fetch(`${urlIntegraciones}/interna/reprogramaciones/aplicar`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenUsuario}`,
          },
          body: JSON.stringify({
            proveedor: 'aerolinea-andina',
            numeroReserva: 'XKQ7PL',
            opcionId: segunda.opcionId,
          }),
        });
        expect(respVencida.status).toBe(409);
        expect(await respVencida.json()).toMatchObject({
          type: 'https://trotamundos.example/errores/opcion-vencida',
          status: 409,
        });
      }

      // 7) Aerolínea caída (503) al pedir opciones -> 503 tercero-no-disponible.
      await fetch(`${urlAerolinea}/admin/comportamiento`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modoFalla: '503' }),
      });
      const resp503 = await fetch(`${urlIntegraciones}/interna/reprogramaciones/opciones`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUsuario}`,
        },
        body: JSON.stringify({ proveedor: 'aerolinea-andina', numeroReserva: 'XKQ7PL' }),
      });
      expect(resp503.status).toBe(503);
    });
  },
);
