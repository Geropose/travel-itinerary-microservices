// Pruebas de integración del Anonimizador y la base global de analítica (P2.C4) contra
// PostgreSQL 17 y RabbitMQ 4 reales (testcontainers):
// - Dos regiones (region-1 y region-2) con secretos distintos y bases regionales separadas alimentan
//   UNA base global de analítica con tabla particionada por mes.
// - Recorrido exhaustivo de TODAS las columnas y TODAS las filas de la base de analítica: ninguna
//   contiene emails, nombres, usuarioId ni números de reserva; inicio y fin son DATE sin hora.
// - Cambio (incluso cruzando de mes/partición) y cancelación de la misma reserva quedan en UNA sola fila.
// - Evento repetido (mismo eventId) no duplica.
// - Fila con campo extra es rechazada contra ViajeAnonimizado.json y no se guarda.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  conectarBroker,
  crearPool,
  migrar,
  MIGRACIONES_EVENTOS,
  type Broker,
  type Pool,
} from '@trotamundos/comun';
import {
  dockerDisponible,
  levantarPostgres,
  levantarRabbit,
  loggerDePrueba,
  type ContenedorPostgres,
  type ContenedorRabbit,
} from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { calcularCodigoReserva, ErrorFilaAnonimizadaInvalida } from '../src/anonimizador.ts';
import { SERVICIO } from '../src/app.ts';
import { registrarConsumidorAnonimizador } from '../src/consumidor.ts';
import type { ViajeActualizadoDatos } from '../src/modelo.ts';
import * as repositorio from '../src/repositorio.ts';

const hayDocker = await dockerDisponible();
const SECRETO_R1 = 'secreto-analitica-r1-prueba-integracion';
const SECRETO_R2 = 'secreto-analitica-r2-prueba-integracion';

async function esperarQue(
  condicion: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (!(await condicion())) {
    if (Date.now() > limite) {
      throw new Error('Tiempo agotado esperando condición en prueba de analítica');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function reemplazarBaseEnUrl(urlOriginal: string, nombreBase: string): string {
  const u = new URL(urlOriginal);
  u.pathname = `/${nombreBase}`;
  return u.toString();
}

describe.skipIf(!hayDocker)(
  'Anonimizador regional y base global particionada de Analítica (PostgreSQL + RabbitMQ)',
  { timeout: 120_000 },
  () => {
    const bitacoraR1 = loggerDePrueba(SERVICIO, 'region-1');
    const bitacoraR2 = loggerDePrueba(SERVICIO, 'region-2');

    let postgres: ContenedorPostgres;
    let rabbitR1: ContenedorRabbit;
    let rabbitR2: ContenedorRabbit;

    let poolAdmin: Pool;
    let poolRegionalR1: Pool;
    let poolRegionalR2: Pool;
    let poolGlobal: Pool;

    let brokerAnaliticaR1: Broker;
    let brokerViajesR1: Broker;
    let brokerAnaliticaR2: Broker;
    let brokerViajesR2: Broker;

    beforeAll(async () => {
      [postgres, rabbitR1, rabbitR2] = await Promise.all([
        levantarPostgres(),
        levantarRabbit(),
        levantarRabbit(),
      ]);

      poolAdmin = crearPool({ url: postgres.url, maximo: 4 });
      poolAdmin.on('error', () => undefined);
      await poolAdmin.query('CREATE DATABASE analitica_r1');
      await poolAdmin.query('CREATE DATABASE analitica_r2');
      await poolAdmin.query('CREATE DATABASE analitica_global');

      poolRegionalR1 = crearPool({ url: reemplazarBaseEnUrl(postgres.url, 'analitica_r1') });
      poolRegionalR2 = crearPool({ url: reemplazarBaseEnUrl(postgres.url, 'analitica_r2') });
      poolGlobal = crearPool({
        url: reemplazarBaseEnUrl(postgres.url, 'analitica_global'),
        maximo: 15,
      });
      poolRegionalR1.on('error', () => undefined);
      poolRegionalR2.on('error', () => undefined);
      poolGlobal.on('error', () => undefined);

      const dirMigraciones = fileURLToPath(new URL('../migrations/', import.meta.url));
      await Promise.all([
        migrar(poolRegionalR1, [MIGRACIONES_EVENTOS]),
        migrar(poolRegionalR2, [MIGRACIONES_EVENTOS]),
        migrar(poolGlobal, [dirMigraciones]),
      ]);

      [brokerAnaliticaR1, brokerViajesR1, brokerAnaliticaR2, brokerViajesR2] = await Promise.all([
        conectarBroker({
          url: rabbitR1.url,
          servicio: SERVICIO,
          region: 'region-1',
          logger: bitacoraR1.logger,
        }),
        conectarBroker({
          url: rabbitR1.url,
          servicio: 'viajes',
          region: 'region-1',
          logger: bitacoraR1.logger,
        }),
        conectarBroker({
          url: rabbitR2.url,
          servicio: SERVICIO,
          region: 'region-2',
          logger: bitacoraR2.logger,
        }),
        conectarBroker({
          url: rabbitR2.url,
          servicio: 'viajes',
          region: 'region-2',
          logger: bitacoraR2.logger,
        }),
      ]);

      await Promise.all([
        registrarConsumidorAnonimizador({
          broker: brokerAnaliticaR1,
          poolRegional: poolRegionalR1,
          poolAnalitica: poolGlobal,
          region: 'region-1',
          secretoAnalitica: SECRETO_R1,
          logger: bitacoraR1.logger,
          cantidadConsumidores: 2,
        }),
        registrarConsumidorAnonimizador({
          broker: brokerAnaliticaR2,
          poolRegional: poolRegionalR2,
          poolAnalitica: poolGlobal,
          region: 'region-2',
          secretoAnalitica: SECRETO_R2,
          logger: bitacoraR2.logger,
          cantidadConsumidores: 2,
        }),
      ]);
    }, 120_000);

    afterAll(async () => {
      await Promise.allSettled([
        brokerViajesR1?.cerrar(),
        brokerAnaliticaR1?.cerrar(),
        brokerViajesR2?.cerrar(),
        brokerAnaliticaR2?.cerrar(),
      ]);
      await Promise.allSettled([
        poolRegionalR1?.end(),
        poolRegionalR2?.end(),
        poolGlobal?.end(),
        poolAdmin?.end(),
      ]);
      await Promise.allSettled([rabbitR1?.detener(), rabbitR2?.detener(), postgres?.detener()]);
    }, 30_000);

    beforeEach(async () => {
      await Promise.all([
        poolRegionalR1.query('TRUNCATE eventos_procesados, eventos_salientes CASCADE'),
        poolRegionalR2.query('TRUNCATE eventos_procesados, eventos_salientes CASCADE'),
        poolGlobal.query('TRUNCATE reservas_anonimizadas'),
      ]);
      bitacoraR1.lineas.length = 0;
      bitacoraR2.lineas.length = 0;
    });

    it('anonimiza eventos de ambas regiones en la tabla particionada por mes sin ningún dato personal en ninguna columna ni fila', async () => {
      const pnrR1Vuelo = 'XKQ7PL';
      const pnrR1Hotel = 'HC-48213';
      const pnrR2Auto = 'EU-AUTO-901';

      await brokerViajesR1.publicarEvento<ViajeActualizadoDatos>('ViajeActualizado', {
        numeroReserva: pnrR1Vuelo,
        proveedor: 'aerolinea-andina',
        tipoReserva: 'vuelo',
        origen: 'Buenos Aires (EZE)',
        destino: 'Santiago (SCL)',
        inicio: '2026-12-10T08:30:00Z',
        fin: '2026-12-10T10:45:00Z',
        estado: 'confirmada',
        origenCambio: 'correo',
      });
      await brokerViajesR1.publicarEvento<ViajeActualizadoDatos>('ViajeActualizado', {
        numeroReserva: pnrR1Hotel,
        proveedor: 'hotel-cordillera',
        tipoReserva: 'hotel',
        destino: 'Santiago',
        inicio: '2027-01-15T15:00:00Z',
        fin: '2027-01-19T11:00:00Z',
        estado: 'confirmada',
        origenCambio: 'manual',
      });
      // Fecha fuera del rango pre-creado (2031-05) para probar creación automática de partición mensual.
      await brokerViajesR2.publicarEvento<ViajeActualizadoDatos>('ViajeActualizado', {
        numeroReserva: pnrR2Auto,
        proveedor: 'rentadora-sur',
        tipoReserva: 'auto',
        origen: 'Madrid Barajas',
        destino: 'Madrid',
        inicio: '2031-05-04T09:00:00Z',
        fin: '2031-05-08T18:00:00Z',
        estado: 'confirmada',
        origenCambio: 'correo',
      });

      await esperarQue(async () => {
        const res = await poolGlobal.query<{ total: string }>(
          'SELECT COUNT(*)::text AS total FROM reservas_anonimizadas',
        );
        return Number(res.rows[0]?.total ?? 0) === 3;
      });

      // 1) Verificamos el esquema de columnas de la base global: ninguna columna personal, fechas como DATE.
      const columnas = (
        await poolGlobal.query<{ column_name: string; data_type: string }>(
          `SELECT column_name, data_type
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'reservas_anonimizadas'
           ORDER BY ordinal_position`,
        )
      ).rows;
      const nombresColumnas = columnas.map((c) => c.column_name);
      expect(nombresColumnas).toEqual([
        'codigo_reserva',
        'region',
        'proveedor',
        'tipo_reserva',
        'origen',
        'destino',
        'inicio',
        'fin',
        'estado',
        'origen_cambio',
        'actualizado_en',
      ]);
      expect(columnas.find((c) => c.column_name === 'inicio')?.data_type).toBe('date');
      expect(columnas.find((c) => c.column_name === 'fin')?.data_type).toBe('date');

      // 2) Recorremos TODAS las filas y TODAS sus columnas: cero emails, nombres, usuarioId ni PNRs.
      const todas = (
        await poolGlobal.query<Record<string, unknown>>(
          `SELECT tableoid::regclass::text AS particion,
                  codigo_reserva, region, proveedor, tipo_reserva, origen, destino,
                  to_char(inicio, 'YYYY-MM-DD') AS inicio, to_char(fin, 'YYYY-MM-DD') AS fin,
                  estado, origen_cambio
           FROM reservas_anonimizadas
           ORDER BY inicio ASC`,
        )
      ).rows;
      expect(todas).toHaveLength(3);

      const sensibles = [pnrR1Vuelo, pnrR1Hotel, pnrR2Auto, SECRETO_R1, SECRETO_R2];
      const regexEmail = /\S+@\S+\.\S+/;
      const regexUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      for (const fila of todas) {
        expect(String(fila.codigo_reserva)).toMatch(/^[0-9a-f]{64}$/);
        expect(String(fila.inicio)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(String(fila.fin)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        for (const valor of Object.values(fila)) {
          if (valor === null || valor === undefined) continue;
          const texto = String(valor);
          expect(regexEmail.test(texto)).toBe(false);
          expect(regexUuid.test(texto)).toBe(false);
          for (const secreto of sensibles) {
            expect(texto).not.toContain(secreto);
          }
        }
      }

      // 3) Cada fila quedó en su partición mensual exacta (incluyendo la partición dinámica 2031_05).
      expect(todas.map((f) => [f.region, f.particion, f.codigo_reserva])).toEqual([
        [
          'region-1',
          'reservas_anonimizadas_2026_12',
          calcularCodigoReserva(pnrR1Vuelo, SECRETO_R1),
        ],
        [
          'region-1',
          'reservas_anonimizadas_2027_01',
          calcularCodigoReserva(pnrR1Hotel, SECRETO_R1),
        ],
        ['region-2', 'reservas_anonimizadas_2031_05', calcularCodigoReserva(pnrR2Auto, SECRETO_R2)],
      ]);

      const particiones = await repositorio.listarParticionesMensuales(poolGlobal);
      expect(particiones).toContain('reservas_anonimizadas_2026_12');
      expect(particiones).toContain('reservas_anonimizadas_2027_01');
      expect(particiones).toContain('reservas_anonimizadas_2031_05');

      // Ningún log contiene el número de reserva ni el secreto regional.
      const logsCombinados = [...bitacoraR1.lineas, ...bitacoraR2.lineas]
        .map((l) => JSON.stringify(l))
        .join('\n');
      for (const secreto of sensibles) {
        expect(logsCombinados).not.toContain(secreto);
      }
    });

    it('mantiene una sola fila ante cambio de fecha entre meses y cancelación de la misma reserva', async () => {
      const pnr = 'MOVER-MES-77';
      const codigo = calcularCodigoReserva(pnr, SECRETO_R1);

      // 1) Alta inicial en diciembre 2026.
      await brokerViajesR1.publicarEvento<ViajeActualizadoDatos>('ViajeActualizado', {
        numeroReserva: pnr,
        proveedor: 'aerolinea-andina',
        tipoReserva: 'vuelo',
        origen: 'EZE',
        destino: 'SCL',
        inicio: '2026-12-30T22:00:00Z',
        fin: '2026-12-31T00:30:00Z',
        estado: 'confirmada',
        origenCambio: 'correo',
      });
      await esperarQue(
        async () =>
          (await repositorio.buscarFilaAnonimizada(
            poolGlobal,
            'region-1',
            'aerolinea-andina',
            codigo,
          )) !== null,
      );

      // 2) Reprogramación del proveedor: pasa a enero 2027 (otra partición mensual).
      await brokerViajesR1.publicarEvento<ViajeActualizadoDatos>('ViajeActualizado', {
        numeroReserva: pnr,
        proveedor: 'aerolinea-andina',
        tipoReserva: 'vuelo',
        origen: 'EZE',
        destino: 'SCL',
        inicio: '2027-01-02T10:00:00Z',
        fin: '2027-01-02T12:30:00Z',
        estado: 'modificada',
        origenCambio: 'proveedor',
      });
      await esperarQue(async () => {
        const fila = await repositorio.buscarFilaAnonimizada(
          poolGlobal,
          'region-1',
          'aerolinea-andina',
          codigo,
        );
        return fila?.estado === 'modificada' && fila.inicio === '2027-01-02';
      });

      // 3) Cancelación posterior de la misma reserva.
      await brokerViajesR1.publicarEvento<ViajeActualizadoDatos>('ViajeActualizado', {
        numeroReserva: pnr,
        proveedor: 'aerolinea-andina',
        tipoReserva: 'vuelo',
        origen: 'EZE',
        destino: 'SCL',
        inicio: '2027-01-02T10:00:00Z',
        fin: '2027-01-02T12:30:00Z',
        estado: 'cancelada',
        origenCambio: 'proveedor',
      });
      await esperarQue(async () => {
        const fila = await repositorio.buscarFilaAnonimizada(
          poolGlobal,
          'region-1',
          'aerolinea-andina',
          codigo,
        );
        return fila?.estado === 'cancelada';
      });

      // Comprobamos que hay EXACTAMENTE 1 fila en toda la tabla particionada (0 en 2026_12, 1 en 2027_01).
      const total = await poolGlobal.query<{ total: string; particion: string }>(
        `SELECT tableoid::regclass::text AS particion, COUNT(*)::text AS total
         FROM reservas_anonimizadas
         GROUP BY tableoid`,
      );
      expect(total.rows).toEqual([{ particion: 'reservas_anonimizadas_2027_01', total: '1' }]);

      const final = await repositorio.buscarFilaAnonimizada(
        poolGlobal,
        'region-1',
        'aerolinea-andina',
        codigo,
      );
      expect(final).toMatchObject({
        codigoReserva: codigo,
        region: 'region-1',
        inicio: '2027-01-02',
        fin: '2027-01-02',
        estado: 'cancelada',
        origenCambio: 'proveedor',
      });
    });

    it('ignora eventos repetidos sin duplicar y rechaza filas con campos de más sin guardarlas', async () => {
      const pnr = 'IDEM-999';
      const sobre = await brokerViajesR1.publicarEvento<ViajeActualizadoDatos>('ViajeActualizado', {
        numeroReserva: pnr,
        proveedor: 'hotel-cordillera',
        tipoReserva: 'hotel',
        destino: 'Bariloche',
        inicio: '2026-12-20T15:00:00Z',
        fin: '2026-12-24T11:00:00Z',
        estado: 'confirmada',
        origenCambio: 'correo',
      });

      await esperarQue(async () => {
        const res = await poolGlobal.query<{ total: string }>(
          'SELECT COUNT(*)::text AS total FROM reservas_anonimizadas',
        );
        return Number(res.rows[0]?.total ?? 0) === 1;
      });

      // Reenviamos exactamente el mismo sobre (mismo eventId).
      await brokerViajesR1.publicar(sobre);
      await new Promise((r) => setTimeout(r, 250));

      const filasTrasRepetido = await poolGlobal.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM reservas_anonimizadas',
      );
      expect(Number(filasTrasRepetido.rows[0]?.total ?? 0)).toBe(1);

      // Una fila con campo extra (usuarioId o email) falla la validación contra ViajeAnonimizado.json y NO se guarda.
      const filaConUsuario = {
        codigoReserva: calcularCodigoReserva('EXTRA-1', SECRETO_R1),
        region: 'region-1',
        proveedor: 'hotel-cordillera',
        tipoReserva: 'hotel',
        destino: 'Mendoza',
        inicio: '2026-12-22',
        fin: '2026-12-25',
        estado: 'confirmada',
        origenCambio: 'manual',
        usuarioId: randomUUID(),
      };
      await expect(repositorio.guardarFilaAnonimizada(poolGlobal, filaConUsuario)).rejects.toThrow(
        ErrorFilaAnonimizadaInvalida,
      );

      const filasTrasInvalida = await poolGlobal.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM reservas_anonimizadas',
      );
      expect(Number(filasTrasInvalida.rows[0]?.total ?? 0)).toBe(1);
    });
  },
);
