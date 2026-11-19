// Pruebas de integración de consultas analíticas, autorización por rol analista, ejecución
// asíncrona (202 + polling + 409) y paralelismo Map-Reduce real con worker_threads (P2.C5):
// - Un usuario común (rol usuario) recibe 403 y queda registrado en AccesoRechazado.
// - Consultas destinos, cancelaciones (por proveedor y destino) y tendencias (12 meses).
// - Generador de histórico realista sobre particiones mensuales.
// - Map-Reduce con 1 procesador y con 8 procesadores produce resultados idénticos y con 8
//   procesadores tarda menos al recorrer un volumen grande distribuido entre particiones.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  crearPool,
  crearValidador,
  migrar,
  type AccesoRechazado,
  type Pool,
} from '@trotamundos/comun';
import {
  dockerDisponible,
  firmarJwt,
  generarClaves,
  levantarPostgres,
  loggerDePrueba,
  type ContenedorPostgres,
} from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { calcularCodigoReserva } from '../src/anonimizador.ts';
import { crearApp, SERVICIO } from '../src/app.ts';
import { generarHistoricoAnonimizado } from '../src/generador-historico.ts';
import { ejecutarMapReduce } from '../src/mapreduce.ts';
import type {
  ConsultaLanzada,
  EjecucionPublica,
  ResultadoCancelaciones,
  ResultadoDestinos,
  ResultadoTendencias,
} from '../src/modelo.ts';
import * as repositorio from '../src/repositorio.ts';
import { crearNegocioAnalitica, type NegocioAnalitica } from '../src/rutas.ts';

const hayDocker = await dockerDisponible();
const claves = await generarClaves();
const SECRETO = 'secreto-analitica-prueba-consultas-mr';

async function esperarEjecucionFinal(
  urlAnalitica: string,
  jwtAnalista: string,
  consultaId: string,
  timeoutMs = 30_000,
): Promise<EjecucionPublica> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const res = await fetch(`${urlAnalitica}/consultas/ejecuciones/${consultaId}`, {
      headers: { authorization: `Bearer ${jwtAnalista}` },
    });
    expect(res.status).toBe(200);
    const ejecucion = (await res.json()) as EjecucionPublica;
    if (ejecucion.estado === 'terminada' || ejecucion.estado === 'fallida') {
      return ejecucion;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Tiempo agotado esperando finalización de ejecución ${consultaId}`);
}

describe.skipIf(!hayDocker)(
  'Consultas Analíticas, Rol Analista y Procesadores Map-Reduce (PostgreSQL + worker_threads)',
  { timeout: 120_000 },
  () => {
    const { logger } = loggerDePrueba(SERVICIO);
    const rechazos: AccesoRechazado[] = [];

    let postgres: ContenedorPostgres;
    let pool: Pool;
    let negocio: NegocioAnalitica;
    let urlAnalitica = '';
    let detenerApp: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      postgres = await levantarPostgres();
      pool = crearPool({ url: postgres.url, maximo: 15 });
      pool.on('error', () => undefined);

      await migrar(pool, [fileURLToPath(new URL('../migrations/', import.meta.url))]);

      const registrar = (r: AccesoRechazado) => {
        rechazos.push(r);
      };
      const validador = crearValidador({
        servicio: SERVICIO,
        region: 'region-1',
        logger,
        claves: { 'region-1': { claves: claves.jwks } },
        registrar,
        rolesPorDefecto: ['analista'],
      });
      negocio = crearNegocioAnalitica({
        poolAnalitica: pool,
        urlBaseAnalitica: postgres.url,
        logger,
        procesadoresDefecto: 4,
      });

      const app = crearApp({
        region: 'region-1',
        puerto: 0,
        logger,
        validador,
        negocio,
        manejarSenales: false,
      });
      urlAnalitica = `http://127.0.0.1:${await app.iniciar()}`;
      detenerApp = () => app.detener();
    }, 90_000);

    afterAll(async () => {
      await negocio?.detener();
      await detenerApp?.();
      await pool?.end();
      await postgres?.detener();
    }, 30_000);

    beforeEach(async () => {
      rechazos.length = 0;
      await pool.query('TRUNCATE reservas_anonimizadas, ejecuciones_consultas');
    });

    it('bloquea con 403 y registra AccesoRechazado cuando un usuario común intenta acceder a cualquier consulta', async () => {
      const usuarioComunId = randomUUID();
      const jwtUsuario = await firmarJwt(claves, { sub: usuarioComunId, roles: ['usuario'] });

      const intentos: Array<[string, string, string?]> = [
        ['GET', '/consultas/destinos?desde=2025-01-01&hasta=2025-12-31'],
        ['GET', '/consultas/cancelaciones?desde=2025-01-01&hasta=2025-12-31&agruparPor=proveedor'],
        ['GET', '/consultas/tendencias?anio=2025'],
        [
          'POST',
          '/consultas/destinos/ejecutar',
          JSON.stringify({ desde: '2025-01-01', hasta: '2025-12-31' }),
        ],
        ['GET', `/consultas/ejecuciones/${randomUUID()}`],
      ];

      for (const [metodo, ruta, cuerpo] of intentos) {
        const res = await fetch(`${urlAnalitica}${ruta}`, {
          method: metodo,
          headers: {
            authorization: `Bearer ${jwtUsuario}`,
            ...(cuerpo ? { 'content-type': 'application/json' } : {}),
          },
          ...(cuerpo ? { body: cuerpo } : {}),
        });
        expect(res.status).toBe(403);
        expect(res.headers.get('content-type')).toContain('application/problem+json');
      }

      expect(
        rechazos.filter(
          (r) => r.status === 403 && r.usuarioId === usuarioComunId && r.motivo === 'sin-permiso',
        ),
      ).toHaveLength(intentos.length);
    });

    it('calcula destinos, cancelaciones (por proveedor y destino) y tendencias (12 meses) uniendo todas las regiones y valida errores 400/404', async () => {
      const jwtAnalista = await firmarJwt(claves, { sub: randomUUID(), roles: ['analista'] });

      // Sembramos 6 reservas en 2025 repartidas entre region-1 y region-2.
      const filas = [
        {
          codigoReserva: calcularCodigoReserva('R1', SECRETO),
          region: 'region-1',
          proveedor: 'aerolinea-andina',
          tipoReserva: 'vuelo',
          origen: 'EZE',
          destino: 'SCL',
          inicio: '2025-01-10',
          fin: '2025-01-10',
          estado: 'confirmada',
          origenCambio: 'correo',
        },
        {
          codigoReserva: calcularCodigoReserva('R2', SECRETO),
          region: 'region-2',
          proveedor: 'aerolinea-andina',
          tipoReserva: 'vuelo',
          origen: 'MAD',
          destino: 'SCL',
          inicio: '2025-01-20',
          fin: '2025-01-20',
          estado: 'cancelada',
          origenCambio: 'proveedor',
        },
        {
          codigoReserva: calcularCodigoReserva('R3', SECRETO),
          region: 'region-1',
          proveedor: 'hotel-cordillera',
          tipoReserva: 'hotel',
          destino: 'SCL',
          inicio: '2025-03-05',
          fin: '2025-03-08',
          estado: 'confirmada',
          origenCambio: 'manual',
        },
        {
          codigoReserva: calcularCodigoReserva('R4', SECRETO),
          region: 'region-2',
          proveedor: 'hotel-cordillera',
          tipoReserva: 'hotel',
          destino: 'MAD',
          inicio: '2025-03-10',
          fin: '2025-03-12',
          estado: 'modificada',
          origenCambio: 'correo',
        },
        {
          codigoReserva: calcularCodigoReserva('R5', SECRETO),
          region: 'region-1',
          proveedor: 'rentadora-sur',
          tipoReserva: 'auto',
          origen: 'BRC',
          destino: 'Bariloche',
          inicio: '2025-07-15',
          fin: '2025-07-19',
          estado: 'cancelada',
          origenCambio: 'proveedor',
        },
        {
          codigoReserva: calcularCodigoReserva('R6', SECRETO),
          region: 'region-2',
          proveedor: 'rentadora-sur',
          tipoReserva: 'auto',
          origen: 'BRC',
          destino: 'Bariloche',
          inicio: '2025-07-18',
          fin: '2025-07-20',
          estado: 'confirmada',
          origenCambio: 'archivado',
        },
      ] as const;

      for (const fila of filas) {
        await repositorio.guardarFilaAnonimizada(pool, fila);
      }

      // 1) Destinos más reservados (excluye las 2 canceladas -> totalReservas = 4: SCL=2, Bariloche=1, MAD=1).
      const rDest = await fetch(
        `${urlAnalitica}/consultas/destinos?desde=2025-01-01&hasta=2025-12-31&limite=5`,
        { headers: { authorization: `Bearer ${jwtAnalista}` } },
      );
      expect(rDest.status).toBe(200);
      const dest = (await rDest.json()) as ResultadoDestinos;
      expect(dest.totalReservas).toBe(4);
      expect(dest.destinos).toEqual([
        { destino: 'SCL', reservas: 2, proporcion: 0.5 },
        { destino: 'Bariloche', reservas: 1, proporcion: 0.25 },
        { destino: 'MAD', reservas: 1, proporcion: 0.25 },
      ]);

      // 2) Cancelaciones por proveedor (rentadora-sur 1/2=0.5, aerolinea-andina 1/2=0.5, hotel-cordillera 0/2=0).
      const rCancProv = await fetch(
        `${urlAnalitica}/consultas/cancelaciones?desde=2025-01-01&hasta=2025-12-31&agruparPor=proveedor`,
        { headers: { authorization: `Bearer ${jwtAnalista}` } },
      );
      expect(rCancProv.status).toBe(200);
      const cancProv = (await rCancProv.json()) as ResultadoCancelaciones;
      expect(cancProv.total).toEqual({ reservas: 6, canceladas: 2, tasaCancelacion: 0.333333 });
      expect(cancProv.grupos.map((g) => [g.clave, g.tasaCancelacion])).toEqual([
        ['aerolinea-andina', 0.5],
        ['rentadora-sur', 0.5],
        ['hotel-cordillera', 0],
      ]);

      // Cancelaciones por destino.
      const rCancDest = await fetch(
        `${urlAnalitica}/consultas/cancelaciones?desde=2025-01-01&hasta=2025-12-31&agruparPor=destino`,
        { headers: { authorization: `Bearer ${jwtAnalista}` } },
      );
      expect(rCancDest.status).toBe(200);
      const cancDest = (await rCancDest.json()) as ResultadoCancelaciones;
      expect(cancDest.grupos.map((g) => [g.clave, g.canceladas, g.reservas])).toEqual([
        ['Bariloche', 1, 2],
        ['SCL', 1, 3],
        ['MAD', 0, 1],
      ]);

      // 3) Tendencias: siempre los 12 meses.
      const rTend = await fetch(`${urlAnalitica}/consultas/tendencias?anio=2025`, {
        headers: { authorization: `Bearer ${jwtAnalista}` },
      });
      expect(rTend.status).toBe(200);
      const tend = (await rTend.json()) as ResultadoTendencias;
      expect(tend.periodos).toHaveLength(12);
      expect(tend.periodos[0]).toEqual({
        mes: 1,
        reservas: 2,
        canceladas: 1,
        porTipoReserva: { vuelo: 2, hotel: 0, auto: 0 },
      });
      expect(tend.periodos[1]).toEqual({
        mes: 2,
        reservas: 0,
        canceladas: 0,
        porTipoReserva: { vuelo: 0, hotel: 0, auto: 0 },
      });
      expect(tend.periodos[2]).toEqual({
        mes: 3,
        reservas: 2,
        canceladas: 0,
        porTipoReserva: { vuelo: 0, hotel: 2, auto: 0 },
      });
      expect(tend.periodos[6]).toEqual({
        mes: 7,
        reservas: 2,
        canceladas: 1,
        porTipoReserva: { vuelo: 0, hotel: 0, auto: 2 },
      });

      // Validaciones 400 (hasta < desde y cuerpo que no coincide con tipo) y 404.
      expect(
        (
          await fetch(`${urlAnalitica}/consultas/destinos?desde=2025-12-31&hasta=2025-01-01`, {
            headers: { authorization: `Bearer ${jwtAnalista}` },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(`${urlAnalitica}/consultas/destinos/ejecutar`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${jwtAnalista}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ anio: 2025 }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(`${urlAnalitica}/consultas/ejecuciones/${randomUUID()}`, {
            headers: { authorization: `Bearer ${jwtAnalista}` },
          })
        ).status,
      ).toBe(404);
    });

    it('ejecuta Map-Reduce asíncrono (202 + 409 duplicado + polling), da resultados idénticos con 1 y 8 procesadores y acelera con más procesadores', async () => {
      const jwtAnalista = await firmarJwt(claves, { sub: randomUUID(), roles: ['analista'] });

      // Generamos 120.000 filas anonimizadas realistas repartidas en 36 particiones mensuales (2023–2025).
      const generado = await generarHistoricoAnonimizado(pool, {
        cantidad: 120_000,
        desdeAnio: 2023,
        hastaAnio: 2025,
        tamanoLote: 60_000,
        semilla: 42,
      });
      expect(generado.insertadas).toBe(120_000);

      // 1) Comparamos resultado y tiempo neto Map-Reduce con 1 procesador vs 8 procesadores (worker_threads).
      const consultaCancelaciones = {
        tipo: 'cancelaciones' as const,
        parametros: {
          desde: '2023-01-01',
          hasta: '2025-12-31',
          agruparPor: 'destino' as const,
        },
      };
      // Warmup breve de caché de buffers de PostgreSQL para que la comparación sea justa.
      await ejecutarMapReduce({
        urlBaseAnalitica: postgres.url,
        consulta: consultaCancelaciones,
        procesadores: 2,
      });

      const res1 = await ejecutarMapReduce({
        urlBaseAnalitica: postgres.url,
        consulta: consultaCancelaciones,
        procesadores: 1,
      });
      const res8 = await ejecutarMapReduce({
        urlBaseAnalitica: postgres.url,
        consulta: consultaCancelaciones,
        procesadores: 8,
      });

      expect(res1.procesadores).toBe(1);
      expect(res8.procesadores).toBe(8);
      expect(res1.bloques).toBe(36);
      expect(res8.bloques).toBe(36);

      // Resultados bit a bit idénticos (ignorando timestamp generadoEn).
      const sinFecha1 = { ...res1.resultado, generadoEn: 'FIJO' };
      const sinFecha8 = { ...res8.resultado, generadoEn: 'FIJO' };
      expect(sinFecha8).toEqual(sinFecha1);

      // 8 procesadores en paralelo sobre 36 particiones procesan más rápido que 1 secuencial.
      expect(res8.duracionProcesamientoMs).toBeLessThan(res1.duracionProcesamientoMs);

      // También verificamos paridad exacta en destinos y tendencias entre 1 y 8 procesadores.
      const dest1 = await ejecutarMapReduce({
        urlBaseAnalitica: postgres.url,
        consulta: {
          tipo: 'destinos',
          parametros: { desde: '2023-01-01', hasta: '2025-12-31', limite: 10 },
        },
        procesadores: 1,
      });
      const dest8 = await ejecutarMapReduce({
        urlBaseAnalitica: postgres.url,
        consulta: {
          tipo: 'destinos',
          parametros: { desde: '2023-01-01', hasta: '2025-12-31', limite: 10 },
        },
        procesadores: 8,
      });
      expect({ ...dest8.resultado, generadoEn: 'FIJO' }).toEqual({
        ...dest1.resultado,
        generadoEn: 'FIJO',
      });

      const tend1 = await ejecutarMapReduce({
        urlBaseAnalitica: postgres.url,
        consulta: { tipo: 'tendencias', parametros: { anio: 2024 } },
        procesadores: 1,
      });
      const tend8 = await ejecutarMapReduce({
        urlBaseAnalitica: postgres.url,
        consulta: { tipo: 'tendencias', parametros: { anio: 2024 } },
        procesadores: 8,
      });
      expect({ ...tend8.resultado, generadoEn: 'FIJO' }).toEqual({
        ...tend1.resultado,
        generadoEn: 'FIJO',
      });

      // 2) Flujo HTTP asíncrono completo: POST 202 + Location + 409 ante duplicado concurrente + GET polling.
      const cuerpo = JSON.stringify({
        desde: '2023-01-01',
        hasta: '2025-12-31',
        agruparPor: 'proveedor',
        procesadores: 8,
      });
      const headers = {
        authorization: `Bearer ${jwtAnalista}`,
        'content-type': 'application/json',
      };

      const [resPost1, resPost2] = await Promise.all([
        fetch(`${urlAnalitica}/consultas/cancelaciones/ejecutar`, {
          method: 'POST',
          headers,
          body: cuerpo,
        }),
        fetch(`${urlAnalitica}/consultas/cancelaciones/ejecutar`, {
          method: 'POST',
          headers,
          body: cuerpo,
        }),
      ]);
      const estados = [resPost1.status, resPost2.status].sort();
      expect(estados).toEqual([202, 409]);

      const respuestaAceptada = resPost1.status === 202 ? resPost1 : resPost2;
      const respuestaConflicto = resPost1.status === 409 ? resPost1 : resPost2;
      const lanzada = (await respuestaAceptada.json()) as ConsultaLanzada;
      expect(respuestaAceptada.headers.get('location')).toBe(
        `/api/analitica/consultas/ejecuciones/${lanzada.consultaId}`,
      );
      expect(lanzada.tipo).toBe('cancelaciones');
      expect(lanzada.estado).toBe('pendiente');

      const problema409 = (await respuestaConflicto.json()) as { detail?: string };
      expect(problema409.detail).toContain(lanzada.consultaId);

      const finalizada = await esperarEjecucionFinal(urlAnalitica, jwtAnalista, lanzada.consultaId);
      expect(finalizada.estado).toBe('terminada');
      expect(finalizada.procesadores).toBe(8);
      expect(finalizada.progreso).toBe(1);
      expect(finalizada.duracionMs).toBeGreaterThanOrEqual(0);
      expect(finalizada.resultado).toBeDefined();

      // El resultado asíncrono Map-Reduce coincide exactamente con el endpoint síncrono GET.
      const resSync = await fetch(
        `${urlAnalitica}/consultas/cancelaciones?desde=2023-01-01&hasta=2025-12-31&agruparPor=proveedor`,
        { headers: { authorization: `Bearer ${jwtAnalista}` } },
      );
      expect(resSync.status).toBe(200);
      const syncData = (await resSync.json()) as ResultadoCancelaciones;
      expect({ ...(finalizada.resultado as ResultadoCancelaciones), generadoEn: 'FIJO' }).toEqual({
        ...syncData,
        generadoEn: 'FIJO',
      });
    });
  },
);
