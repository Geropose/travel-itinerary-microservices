// Pruebas de integración del Servicio de Viajes (P2.C1) contra PostgreSQL 17 y RabbitMQ 4:
// - ReservaDetectada: agrupación por fechas (< 2 días vs >= 2 días), upsert por proveedor+numeroReserva
//   e idempotencia por eventId.
// - ReservaActualizada: modificación parcial, cancelación e ignorado con log (sin DLQ) si no existe.
// - Gestor de viajes: publicación atómica de exactamente un ViajeActualizado por cambio vía outbox.
// - Concurrencia: reservas paralelas del mismo usuario se agrupan en un solo viaje sin duplicarlo.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  conectarBroker,
  crearPool,
  iniciarPublicadorOutbox,
  migrar,
  MIGRACIONES_EVENTOS,
  type Broker,
  type Pool,
  type PublicadorOutbox,
  type Sobre,
} from '@trotamundos/comun';
import {
  dockerDisponible,
  levantarPostgres,
  levantarRabbit,
  loggerDePrueba,
  type ContenedorPostgres,
  type ContenedorRabbit,
} from '@trotamundos/comun/pruebas';
import { connect } from 'amqplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SERVICIO } from '../src/app.ts';
import { registrarConsumidoresViajes } from '../src/consumidores.ts';
import { crearGestorViajes } from '../src/gestor.ts';
import type {
  ReservaActualizadaDatos,
  ReservaDetectadaDatos,
  ViajeActualizadoDatos,
} from '../src/modelo.ts';
import * as repositorio from '../src/repositorio.ts';

const hayDocker = await dockerDisponible();

async function esperarQue(
  condicion: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (!(await condicion())) {
    if (Date.now() > limite)
      throw new Error('Tiempo agotado esperando condición en prueba de viajes');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!hayDocker)(
  'Servicio de Viajes: modelo, agrupación, consumidores y outbox (PostgreSQL + RabbitMQ)',
  { timeout: 120_000 },
  () => {
    const pruebaLogger = loggerDePrueba(SERVICIO);
    const { logger } = pruebaLogger;

    let postgres: ContenedorPostgres;
    let rabbit: ContenedorRabbit;
    let pool: Pool;
    let brokerViajes: Broker;
    let brokerCorreo: Broker;
    let brokerIntegraciones: Broker;
    let brokerAnalitica: Broker;
    let outbox: PublicadorOutbox;

    const publicadosViaje: Sobre<ViajeActualizadoDatos>[] = [];

    beforeAll(async () => {
      [postgres, rabbit] = await Promise.all([levantarPostgres(), levantarRabbit()]);
      pool = crearPool({ url: postgres.url, maximo: 20 });
      pool.on('error', () => undefined);
      await migrar(pool, [
        MIGRACIONES_EVENTOS,
        fileURLToPath(new URL('../migrations/', import.meta.url)),
      ]);

      [brokerViajes, brokerCorreo, brokerIntegraciones, brokerAnalitica] = await Promise.all([
        conectarBroker({ url: rabbit.url, servicio: SERVICIO, region: 'region-1', logger }),
        conectarBroker({ url: rabbit.url, servicio: 'correo', region: 'region-1', logger }),
        conectarBroker({ url: rabbit.url, servicio: 'integraciones', region: 'region-1', logger }),
        conectarBroker({ url: rabbit.url, servicio: 'analitica', region: 'region-1', logger }),
      ]);

      const gestor = crearGestorViajes({ region: 'region-1', logger });
      await registrarConsumidoresViajes({
        broker: brokerViajes,
        pool,
        gestor,
        logger,
        cantidadConsumidores: 4,
        prefetch: 2,
      });

      await brokerAnalitica.consumir<ViajeActualizadoDatos>({
        tipo: 'ViajeActualizado',
        pool,
        manejar: async (evento) => {
          publicadosViaje.push(evento);
        },
      });

      outbox = iniciarPublicadorOutbox({
        pool,
        broker: brokerViajes,
        logger,
        intervaloMs: 50,
        lote: 100,
      });
    }, 120_000);

    afterAll(async () => {
      await outbox?.detener();
      await brokerAnalitica?.cerrar();
      await brokerIntegraciones?.cerrar();
      await brokerCorreo?.cerrar();
      await brokerViajes?.cerrar();
      await pool?.end();
      await postgres?.detener();
      await rabbit?.detener();
    }, 30_000);

    beforeEach(async () => {
      await pool.query('TRUNCATE reservas, viajes, eventos_procesados, eventos_salientes CASCADE');
      publicadosViaje.length = 0;
      pruebaLogger.lineas.length = 0;
    });

    it('agrupa reservas por fechas, ignora eventos duplicados, hace upsert por proveedor+numeroReserva y emite exactamente un ViajeActualizado por cambio', async () => {
      const usuarioId = randomUUID();
      const vuelo: ReservaDetectadaDatos = {
        usuarioId,
        proveedor: 'aerolinea-andina',
        tipoReserva: 'vuelo',
        numeroReserva: 'XKQ7PL',
        inicio: '2026-12-10T08:30:00Z',
        fin: '2026-12-10T10:45:00Z',
        origen: 'Buenos Aires (EZE)',
        destino: 'Santiago (SCL)',
        estado: 'confirmada',
        detalle: { numeroVuelo: 'AN 1234' },
        correoId: 'msg-vuelo-1',
      };
      const hotelMismoViaje: ReservaDetectadaDatos = {
        usuarioId,
        proveedor: 'hotel-cordillera',
        tipoReserva: 'hotel',
        numeroReserva: 'HC-48213',
        inicio: '2026-12-10T15:00:00Z',
        fin: '2026-12-14T11:00:00Z',
        destino: 'Santiago',
        estado: 'confirmada',
        detalle: { habitacion: 'Doble' },
        correoId: 'msg-hotel-1',
      };
      const autoOtroViaje: ReservaDetectadaDatos = {
        usuarioId,
        proveedor: 'rentadora-sur',
        tipoReserva: 'auto',
        numeroReserva: 'RS-9001',
        inicio: '2026-12-18T09:00:00Z',
        fin: '2026-12-21T18:00:00Z',
        origen: 'Mendoza Aeropuerto',
        destino: 'Mendoza',
        estado: 'confirmada',
        detalle: { categoria: 'Compacto' },
        correoId: 'msg-auto-1',
      };

      const sobreVuelo = await brokerCorreo.publicarEvento('ReservaDetectada', vuelo);
      await esperarQue(() => publicadosViaje.length === 1);

      // Reenvío del mismo evento (idéntico eventId): idempotente, no duplica ni publica otro evento.
      await brokerCorreo.publicar(sobreVuelo);
      await new Promise((r) => setTimeout(r, 250));
      expect(publicadosViaje).toHaveLength(1);

      // Hotel en las mismas fechas -> entra en el mismo viaje; auto 4 días después -> nuevo viaje.
      await brokerCorreo.publicarEvento('ReservaDetectada', hotelMismoViaje);
      await brokerCorreo.publicarEvento('ReservaDetectada', autoOtroViaje);
      await esperarQue(() => publicadosViaje.length === 3);

      const viajes = await repositorio.listarViajesConReservas(pool, usuarioId, 'activo');
      expect(viajes).toHaveLength(2);
      expect(viajes[0]?.destino).toBe('Santiago');
      expect(viajes[0]?.nombre).toBe('Viaje a Santiago');
      expect(viajes[0]?.reservas.map((r) => r.numeroReserva)).toEqual(['XKQ7PL', 'HC-48213']);
      expect(viajes[1]?.destino).toBe('Mendoza');
      expect(viajes[1]?.reservas.map((r) => r.numeroReserva)).toEqual(['RS-9001']);

      // Upsert con nuevo eventId para la misma clave proveedor + numeroReserva (modificación por correo).
      await brokerCorreo.publicarEvento('ReservaDetectada', {
        ...vuelo,
        inicio: '2026-12-10T09:15:00Z',
        fin: '2026-12-10T11:30:00Z',
        estado: 'modificada',
        correoId: 'msg-vuelo-2',
      });
      await esperarQue(() => publicadosViaje.length === 4);

      const viajesDespues = await repositorio.listarViajesConReservas(pool, usuarioId, 'activo');
      expect(viajesDespues[0]?.reservas).toHaveLength(2);
      expect(viajesDespues[0]?.reservas[0]?.estado).toBe('modificada');
      expect(viajesDespues[0]?.inicio).toBe('2026-12-10T09:15:00.000Z');

      // Cada cambio generó exactamente un ViajeActualizado válido sin usuarioId/viajeId/reservaId.
      expect(publicadosViaje.map((e) => e.datos.origenCambio)).toEqual([
        'correo',
        'correo',
        'correo',
        'correo',
      ]);
      for (const sobre of publicadosViaje) {
        expect('usuarioId' in sobre.datos).toBe(false);
        expect('viajeId' in sobre.datos).toBe(false);
        expect('reservaId' in sobre.datos).toBe(false);
      }
    });

    it('aplica ReservaActualizada (modificación y cancelación) e ignora sin DLQ cuando la reserva no existe', async () => {
      const usuarioId = randomUUID();
      await brokerCorreo.publicarEvento<ReservaDetectadaDatos>('ReservaDetectada', {
        usuarioId,
        proveedor: 'aerolinea-andina',
        tipoReserva: 'vuelo',
        numeroReserva: 'PNR-555',
        inicio: '2026-12-20T08:00:00Z',
        fin: '2026-12-20T10:30:00Z',
        origen: 'EZE',
        destino: 'SCL',
        estado: 'confirmada',
        detalle: { numeroVuelo: 'AN 555', asiento: '12A' },
        correoId: 'msg-555',
      });
      await esperarQue(() => publicadosViaje.length === 1);

      // Cambio parcial del proveedor: mueve horario y agrega puerta preservando asiento/numeroVuelo.
      await brokerIntegraciones.publicarEvento<ReservaActualizadaDatos>('ReservaActualizada', {
        proveedor: 'aerolinea-andina',
        numeroReserva: 'PNR-555',
        estado: 'modificada',
        cambios: {
          inicio: '2026-12-20T11:00:00Z',
          fin: '2026-12-20T13:30:00Z',
          detalle: { puerta: 'B7' },
        },
        origenCambio: 'proveedor',
      });
      await esperarQue(() => publicadosViaje.length === 2);

      const trasCambio = await repositorio.buscarReservaPorClave(
        pool,
        'aerolinea-andina',
        'PNR-555',
      );
      expect(trasCambio?.estado).toBe('modificada');
      expect(trasCambio?.origenCambio).toBe('proveedor');
      expect(trasCambio?.detalle).toEqual({ numeroVuelo: 'AN 555', asiento: '12A', puerta: 'B7' });
      expect(publicadosViaje[1]?.datos).toMatchObject({
        proveedor: 'aerolinea-andina',
        numeroReserva: 'PNR-555',
        estado: 'modificada',
        origenCambio: 'proveedor',
      });

      // Cancelación por proveedor.
      await brokerIntegraciones.publicarEvento<ReservaActualizadaDatos>('ReservaActualizada', {
        proveedor: 'aerolinea-andina',
        numeroReserva: 'PNR-555',
        estado: 'cancelada',
        cambios: {},
        origenCambio: 'proveedor',
      });
      await esperarQue(() => publicadosViaje.length === 3);

      const trasCancelacion = await repositorio.buscarReservaPorClave(
        pool,
        'aerolinea-andina',
        'PNR-555',
      );
      expect(trasCancelacion?.estado).toBe('cancelada');
      expect(publicadosViaje[2]?.datos).toMatchObject({
        numeroReserva: 'PNR-555',
        estado: 'cancelada',
        origenCambio: 'proveedor',
      });

      // Evento de una reserva que no existe en esta región: se ignora, se loguea con requestId y no va a DLQ.
      const eventoAjeno = await brokerIntegraciones.publicarEvento<ReservaActualizadaDatos>(
        'ReservaActualizada',
        {
          proveedor: 'aerolinea-andina',
          numeroReserva: 'INEXISTENTE-999',
          estado: 'cancelada',
          cambios: {},
          origenCambio: 'proveedor',
        },
      );
      await esperarQue(async () => {
        const res = await pool.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM eventos_procesados WHERE event_id = $1`,
          [eventoAjeno.eventId],
        );
        return Number(res.rows[0]?.total ?? 0) === 1;
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(publicadosViaje).toHaveLength(3);
      const logIgnorado = pruebaLogger.lineas.find(
        (l) =>
          String(l.mensaje ?? '').includes('ReservaActualizada ignorada') &&
          l.proveedor === 'aerolinea-andina' &&
          typeof l.requestId === 'string' &&
          l.requestId.length > 0,
      );
      expect(logIgnorado).toBeDefined();

      // Verificamos que la DLQ está vacía.
      const conn = await connect(rabbit.url);
      try {
        const ch = await conn.createChannel();
        const dlq = await ch.checkQueue('viajes.ReservaActualizada.dlq');
        expect(dlq.messageCount).toBe(0);
        await ch.close();
      } finally {
        await conn.close();
      }
    });

    it('agrupa en un único viaje varias reservas paralelas del mismo usuario sin crear viajes duplicados', async () => {
      const usuarioId = randomUUID();
      await Promise.all([
        brokerCorreo.publicarEvento<ReservaDetectadaDatos>('ReservaDetectada', {
          usuarioId,
          proveedor: 'aerolinea-andina',
          tipoReserva: 'vuelo',
          numeroReserva: 'CONC-1',
          inicio: '2027-01-10T08:00:00Z',
          fin: '2027-01-10T10:00:00Z',
          origen: 'EZE',
          destino: 'BRC',
          estado: 'confirmada',
          detalle: {},
          correoId: 'c1',
        }),
        brokerCorreo.publicarEvento<ReservaDetectadaDatos>('ReservaDetectada', {
          usuarioId,
          proveedor: 'hotel-cordillera',
          tipoReserva: 'hotel',
          numeroReserva: 'CONC-2',
          inicio: '2027-01-10T15:00:00Z',
          fin: '2027-01-13T11:00:00Z',
          destino: 'Bariloche',
          estado: 'confirmada',
          detalle: {},
          correoId: 'c2',
        }),
        brokerCorreo.publicarEvento<ReservaDetectadaDatos>('ReservaDetectada', {
          usuarioId,
          proveedor: 'aerolinea-andina',
          tipoReserva: 'vuelo',
          numeroReserva: 'CONC-3',
          inicio: '2027-01-13T18:00:00Z',
          fin: '2027-01-13T20:00:00Z',
          origen: 'BRC',
          destino: 'EZE',
          estado: 'confirmada',
          detalle: {},
          correoId: 'c3',
        }),
      ]);

      await esperarQue(() => publicadosViaje.length === 3);
      const viajes = await repositorio.listarViajesConReservas(pool, usuarioId, 'activo');
      expect(viajes).toHaveLength(1);
      expect(viajes[0]?.destino).toBe('Bariloche');
      expect(viajes[0]?.reservas).toHaveLength(3);
    });
  },
);
