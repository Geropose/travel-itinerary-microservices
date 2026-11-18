// Prueba de carga escalable del Servicio de Viajes (P2.C1, ADR-009, QA-5):
// Simula una tormenta de actualizaciones procesada por 50 consumidores en paralelo sin perder ni
// duplicar eventos. Por defecto corre en escala reducida (250 eventos) para CI y local, y escala a
// 500.000 eventos mediante EVENTOS_CARGA_VIAJES=500000 CONSUMIDORES_CARGA_VIAJES=50.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  crearPool,
  enTransaccion,
  migrar,
  MIGRACIONES_EVENTOS,
  validadorEventos,
  type Pool,
} from '@trotamundos/comun';
import {
  dockerDisponible,
  levantarPostgres,
  loggerDePrueba,
  type ContenedorPostgres,
} from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVICIO } from '../src/app.ts';
import { crearGestorViajes } from '../src/gestor.ts';
import type { ReservaActualizadaDatos } from '../src/modelo.ts';

const hayDocker = await dockerDisponible();
const TOTAL_EVENTOS = Math.max(10, Number(process.env.EVENTOS_CARGA_VIAJES ?? 250));
const CANTIDAD_CONSUMIDORES = Math.max(1, Number(process.env.CONSUMIDORES_CARGA_VIAJES ?? 50));

interface TrabajoEvento {
  eventId: string;
  datos: ReservaActualizadaDatos;
}

describe.skipIf(!hayDocker)(
  `Prueba de carga de Viajes (${CANTIDAD_CONSUMIDORES} consumidores, ${TOTAL_EVENTOS} eventos)`,
  { timeout: 180_000 },
  () => {
    const { logger } = loggerDePrueba(SERVICIO);
    let postgres: ContenedorPostgres;
    let pool: Pool;

    beforeAll(async () => {
      postgres = await levantarPostgres();
      pool = crearPool({ url: postgres.url, maximo: Math.min(30, CANTIDAD_CONSUMIDORES) });
      await migrar(pool, [
        MIGRACIONES_EVENTOS,
        fileURLToPath(new URL('../migrations/', import.meta.url)),
      ]);
    }, 90_000);

    afterAll(async () => {
      await pool?.end();
      await postgres?.detener();
    }, 30_000);

    it('procesa los eventos en paralelo con 50 consumidores sin perder ni duplicar cambios', async () => {
      const cantidadUsuarios = Math.min(TOTAL_EVENTOS, 100);
      const usuarios = Array.from({ length: cantidadUsuarios }, () => randomUUID());

      // Sembramos las reservas base en lotes rápidos para simular reservas ya detectadas por correo.
      const viajeIds: string[] = [];
      const viajeUsuarioIds: string[] = [];
      const reservaIds: string[] = [];
      const numeros: string[] = [];
      for (let i = 0; i < TOTAL_EVENTOS; i++) {
        const u = usuarios[i % cantidadUsuarios];
        if (!u) throw new Error('Usuario no disponible');
        viajeIds.push(randomUUID());
        viajeUsuarioIds.push(u);
        reservaIds.push(randomUUID());
        numeros.push(`STORM-${String(i).padStart(6, '0')}`);
      }

      const TAMANO_SEMILLA = 2000;
      for (let offset = 0; offset < TOTAL_EVENTOS; offset += TAMANO_SEMILLA) {
        const vSlice = viajeIds.slice(offset, offset + TAMANO_SEMILLA);
        const uSlice = viajeUsuarioIds.slice(offset, offset + TAMANO_SEMILLA);
        const rSlice = reservaIds.slice(offset, offset + TAMANO_SEMILLA);
        const nSlice = numeros.slice(offset, offset + TAMANO_SEMILLA);

        await pool.query(
          `INSERT INTO viajes (id, usuario_id, nombre, destino, inicio, fin, estado)
           SELECT u.id, u.usuario_id, 'Viaje a SCL', 'SCL',
                  '2026-12-20T08:00:00Z'::timestamptz, '2026-12-20T10:30:00Z'::timestamptz, 'activo'
           FROM unnest($1::uuid[], $2::uuid[]) AS u(id, usuario_id)`,
          [vSlice, uSlice],
        );
        await pool.query(
          `INSERT INTO reservas (
             id, viaje_id, usuario_id, proveedor, tipo_reserva, numero_reserva,
             inicio, fin, origen, destino, detalle, estado, origen_cambio
           )
           SELECT u.id, u.viaje_id, u.usuario_id, 'aerolinea-andina', 'vuelo', u.numero,
                  '2026-12-20T08:00:00Z'::timestamptz, '2026-12-20T10:30:00Z'::timestamptz,
                  'EZE', 'SCL', '{}'::jsonb, 'confirmada', 'correo'
           FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[])
             AS u(id, viaje_id, usuario_id, numero)`,
          [rSlice, vSlice, uSlice, nSlice],
        );
      }

      // Cola simulada con TOTAL_EVENTOS cancelaciones + 10 % de eventos repetidos (mismo eventId).
      const trabajos: TrabajoEvento[] = numeros.map((numeroReserva) => ({
        eventId: randomUUID(),
        datos: {
          proveedor: 'aerolinea-andina',
          numeroReserva,
          estado: 'cancelada',
          cambios: {},
          origenCambio: 'proveedor',
        },
      }));
      const duplicados = trabajos.slice(0, Math.min(25, Math.floor(TOTAL_EVENTOS / 10)));
      const cola: TrabajoEvento[] = [...trabajos, ...duplicados];

      const gestor = crearGestorViajes({
        region: 'region-1',
        logger,
        validador: validadorEventos(),
      });

      let cursor = 0;
      const consumirUno = async (trabajo: TrabajoEvento) => {
        await enTransaccion(pool, async (cliente) => {
          const marca = await cliente.query(
            `INSERT INTO eventos_procesados (event_id, cola)
             VALUES ($1, 'viajes.ReservaActualizada')
             ON CONFLICT DO NOTHING`,
            [trabajo.eventId],
          );
          if (marca.rowCount === 0) return;
          await gestor.procesarReservaActualizada(cliente, trabajo.datos);
        });
      };

      // Lanzamos CANTIDAD_CONSUMIDORES (por defecto 50) trabajadores en paralelo.
      await Promise.all(
        Array.from({ length: CANTIDAD_CONSUMIDORES }, async () => {
          while (cursor < cola.length) {
            const idx = cursor++;
            const trabajo = cola[idx];
            if (trabajo) await consumirUno(trabajo);
          }
        }),
      );

      const [{ rows: resCanceladas }, { rows: resOutbox }, { rows: resProcesados }] =
        await Promise.all([
          pool.query<{ total: string }>(
            `SELECT COUNT(*)::text AS total FROM reservas WHERE estado = 'cancelada' AND origen_cambio = 'proveedor'`,
          ),
          pool.query<{ total: string }>(
            `SELECT COUNT(*)::text AS total FROM eventos_salientes WHERE tipo = 'ViajeActualizado'`,
          ),
          pool.query<{ total: string }>(
            `SELECT COUNT(*)::text AS total FROM eventos_procesados WHERE cola = 'viajes.ReservaActualizada'`,
          ),
        ]);

      expect(Number(resCanceladas[0]?.total ?? 0)).toBe(TOTAL_EVENTOS);
      expect(Number(resOutbox[0]?.total ?? 0)).toBe(TOTAL_EVENTOS);
      expect(Number(resProcesados[0]?.total ?? 0)).toBe(TOTAL_EVENTOS);
    });
  },
);
