// Pruebas de integración de P2.C3 contra PostgreSQL 17 y Redis 8 reales (testcontainers):
// - Tarea de archivado con lock distribuido en PostgreSQL (seguro entre 2 instancias, 409 si ya
//   corre, publica ViajeActualizado con origenCambio 'archivado', invalida cache y alimenta GET /archivados).
// - Itinerario compartido GET /viajes/{viajeId} con validador duenoODesignado (dueño, designado,
//   otro usuario -> 403 + AccesoRechazado, revocación y falla cerrada 503 si Usuarios cae).
// - Publicación en red social POST /viajes/{viajeId}/compartir-red sin números de reserva y solo dueño.
// - Rutas internas para Correo (/interna/usuarios-con-viaje-proximo) y Asistente (/interna/reservas*).
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  crearPool,
  crearValidador,
  migrar,
  MIGRACIONES_EVENTOS,
  type AccesoRechazado,
  type Pool,
} from '@trotamundos/comun';
import {
  dockerDisponible,
  firmarJwt,
  firmarTokenServicio,
  generarClaves,
  levantarPostgres,
  loggerDePrueba,
  type ContenedorPostgres,
} from '@trotamundos/comun/pruebas';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearApp, SERVICIO } from '../src/app.ts';
import { crearTareaArchivado, type TareaArchivado } from '../src/archivado.ts';
import { crearCacheRedis, type CachePanel } from '../src/cache.ts';
import { crearGestorViajes } from '../src/gestor.ts';
import type {
  ListaReservasPublica,
  ListaViajesPublica,
  PublicacionRed,
  ReservaPublica,
  ResultadoArchivado,
  SolicitudPublicacionRed,
  UsuariosConViajeProximoRespuesta,
  ViajeActualizadoDatos,
  ViajePublico,
} from '../src/modelo.ts';
import { crearNegocioViajes, REGLAS_VALIDADOR_VIAJES } from '../src/rutas.ts';

const hayDocker = await dockerDisponible();
const claves = await generarClaves();

describe.skipIf(!hayDocker)(
  'Archivado, Itinerario Compartido, Redes Sociales y Rutas Internas (PostgreSQL + Redis)',
  { timeout: 120_000 },
  () => {
    const { logger } = loggerDePrueba(SERVICIO);
    const rechazos: AccesoRechazado[] = [];
    const reloj = { ahora: Date.parse('2026-12-15T03:00:00Z') };

    let postgres: ContenedorPostgres;
    let redisContenedor: StartedTestContainer;
    let pool: Pool;
    let cache: CachePanel;
    let tareaArchivado: TareaArchivado;
    let urlViajes = '';
    let detenerApp: (() => Promise<void>) | undefined;

    // Estado controlado del servidor interno simulado de Usuarios (permisos de itinerarios).
    let servidorUsuarios: Server;
    let urlUsuarios = '';
    const designadosPorViaje = new Map<string, Set<string>>();
    let usuariosCaido = false;
    let llamadasUsuarios: { viajeId: string; usuarioId: string; auth?: string }[] = [];

    // Estado controlado del servidor interno simulado de Integraciones (/interna/redes/publicar).
    let servidorIntegraciones: Server;
    let urlIntegraciones = '';
    let integracionesEstado: 'ok' | '404' | '503' = 'ok';
    let publicacionesRecibidas: { cuerpo: SolicitudPublicacionRed; auth?: string }[] = [];

    // Gancho controlable para mantener tomado el lock durante la prueba de concurrencia.
    let promesaRetencionLock: Promise<void> | undefined;
    let avisarLockTomado: (() => void) | undefined;

    beforeAll(async () => {
      servidorUsuarios = createServer((req, res) => {
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
        const match = /^\/interna\/permisos\/itinerarios\/([^/]+)$/.exec(parsed.pathname);
        if (!match) {
          res.writeHead(404).end();
          return;
        }
        const viajeId = decodeURIComponent(match[1] ?? '');
        const usuarioId = parsed.searchParams.get('usuarioId') ?? '';
        llamadasUsuarios.push({
          viajeId,
          usuarioId,
          ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
        });
        if (usuariosCaido) {
          res.writeHead(503, { 'content-type': 'application/problem+json' }).end(
            JSON.stringify({
              type: 'https://trotamundos.example/errores/no-disponible',
              title: 'No disponible',
              status: 503,
            }),
          );
          return;
        }
        const puedeVer = designadosPorViaje.get(viajeId)?.has(usuarioId) === true;
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            viajeId,
            usuarioId,
            puedeVer,
            motivo: puedeVer ? 'designado' : 'ninguno',
          }),
        );
      });
      const puertoUsuarios = await new Promise<number>((resolver) => {
        servidorUsuarios.listen(0, () => {
          const addr = servidorUsuarios.address();
          resolver(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });
      urlUsuarios = `http://127.0.0.1:${puertoUsuarios}`;

      servidorIntegraciones = createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/interna/redes/publicar') {
          res.writeHead(404).end();
          return;
        }
        const trozos: Buffer[] = [];
        req.on('data', (c: Buffer) => trozos.push(c));
        req.on('end', () => {
          const cuerpo = JSON.parse(
            Buffer.concat(trozos).toString('utf8'),
          ) as SolicitudPublicacionRed;
          publicacionesRecibidas.push({
            cuerpo,
            ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
          });
          if (integracionesEstado === '404') {
            res.writeHead(404, { 'content-type': 'application/problem+json' }).end(
              JSON.stringify({
                type: 'https://trotamundos.example/errores/no-encontrado',
                title: 'No encontrado',
                status: 404,
                detail: `No hay un adaptador para la red ${cuerpo.red}.`,
              }),
            );
            return;
          }
          if (integracionesEstado === '503') {
            res.writeHead(503, { 'content-type': 'application/problem+json' }).end(
              JSON.stringify({
                type: 'https://trotamundos.example/errores/tercero-no-disponible',
                title: 'Tercero no disponible',
                status: 503,
                detail: 'La red social no respondió a tiempo.',
              }),
            );
            return;
          }
          const respuesta: PublicacionRed = {
            red: cuerpo.red,
            url: `https://redsocial.example/@trotamundos/${cuerpo.itinerario.viajeId}`,
            publicadaEn: new Date(reloj.ahora).toISOString(),
          };
          res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(respuesta));
        });
      });
      const puertoIntegraciones = await new Promise<number>((resolver) => {
        servidorIntegraciones.listen(0, () => {
          const addr = servidorIntegraciones.address();
          resolver(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });
      urlIntegraciones = `http://127.0.0.1:${puertoIntegraciones}`;

      [postgres, redisContenedor] = await Promise.all([
        levantarPostgres(),
        new GenericContainer('redis:8-alpine').withExposedPorts(6379).start(),
      ]);
      const urlRedis = `redis://${redisContenedor.getHost()}:${redisContenedor.getMappedPort(6379)}`;
      pool = crearPool({ url: postgres.url, maximo: 15 });
      pool.on('error', () => undefined);

      await migrar(pool, [
        MIGRACIONES_EVENTOS,
        fileURLToPath(new URL('../migrations/', import.meta.url)),
      ]);

      cache = await crearCacheRedis({
        url: urlRedis,
        logger,
        ttlSegundos: 600,
        timeoutMs: 300,
      });

      const gestor = crearGestorViajes({
        region: 'region-1',
        logger,
        ahora: () => reloj.ahora,
      });
      tareaArchivado = crearTareaArchivado({
        pool,
        cache,
        region: 'region-1',
        logger,
        cron: '0 3 * * *',
        ahora: () => reloj.ahora,
        ganchoDuranteLock: async () => {
          avisarLockTomado?.();
          if (promesaRetencionLock) {
            await promesaRetencionLock;
          }
        },
      });

      const registrar = (r: AccesoRechazado) => {
        rechazos.push(r);
      };
      const validador = crearValidador({
        servicio: SERVICIO,
        region: 'region-1',
        logger,
        claves: { 'region-1': { claves: claves.jwks } },
        registrar,
        reglas: REGLAS_VALIDADOR_VIAJES,
      });
      const negocio = crearNegocioViajes({
        poolPrincipal: pool,
        cache,
        gestor,
        logger,
        registrar,
        tareaArchivado,
        urlUsuarios,
        urlIntegraciones,
        ahora: () => reloj.ahora,
      });

      const app = crearApp({
        region: 'region-1',
        puerto: 0,
        logger,
        validador,
        negocio,
        manejarSenales: false,
      });
      urlViajes = `http://127.0.0.1:${await app.iniciar()}`;
      detenerApp = () => app.detener();
    }, 90_000);

    afterAll(async () => {
      await tareaArchivado?.detener();
      await detenerApp?.();
      await cache?.cerrar();
      await pool?.end();
      await new Promise<void>((r) => servidorUsuarios?.close(() => r()));
      await new Promise<void>((r) => servidorIntegraciones?.close(() => r()));
      await redisContenedor?.stop().catch(() => undefined);
      await postgres?.detener();
    }, 30_000);

    beforeEach(async () => {
      reloj.ahora = Date.parse('2026-12-15T03:00:00Z');
      rechazos.length = 0;
      designadosPorViaje.clear();
      usuariosCaido = false;
      llamadasUsuarios = [];
      integracionesEstado = 'ok';
      publicacionesRecibidas = [];
      promesaRetencionLock = undefined;
      avisarLockTomado = undefined;
      await pool.query('TRUNCATE reservas, viajes, eventos_procesados, eventos_salientes CASCADE');
    });

    async function crearReservaHttp(
      jwt: string,
      datos: {
        proveedor: string;
        tipoReserva: 'vuelo' | 'hotel' | 'auto';
        numeroReserva: string;
        inicio: string;
        fin: string;
        origen?: string;
        destino: string;
        detalle?: Record<string, unknown>;
      },
    ): Promise<ReservaPublica> {
      const res = await fetch(`${urlViajes}/reservas`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        body: JSON.stringify(datos),
      });
      expect(res.status).toBe(201);
      return (await res.json()) as ReservaPublica;
    }

    it('archiva viajes terminados bajo lock distribuido (2 instancias + 409), publica ViajeActualizado, invalida cache y responde GET /archivados', async () => {
      const userA = randomUUID();
      const userB = randomUUID();
      const jwtA = await firmarJwt(claves, { sub: userA });
      const jwtB = await firmarJwt(claves, { sub: userB });
      const tokenPruebas = await firmarTokenServicio(claves, 'pruebas');
      const tokenCorreo = await firmarTokenServicio(claves, 'correo');

      // Viaje terminado de userA (terminó el 10/12, > 2 días antes del viaje activo; ahora es 15/12 03:00Z): vuelo + hotel.
      await crearReservaHttp(jwtA, {
        proveedor: 'aerolinea-andina',
        tipoReserva: 'vuelo',
        numeroReserva: 'ARCH-V1',
        inicio: '2026-12-07T08:00:00Z',
        fin: '2026-12-07T10:30:00Z',
        origen: 'EZE',
        destino: 'SCL',
      });
      await crearReservaHttp(jwtA, {
        proveedor: 'hotel-cordillera',
        tipoReserva: 'hotel',
        numeroReserva: 'ARCH-H1',
        inicio: '2026-12-07T15:00:00Z',
        fin: '2026-12-10T11:00:00Z',
        destino: 'Santiago',
      });

      // Viaje todavía en curso de userA (empezó ayer 14/12, termina el 18/12): NO debe archivarse.
      await crearReservaHttp(jwtA, {
        proveedor: 'hotel-cordillera',
        tipoReserva: 'hotel',
        numeroReserva: 'ACTIVO-1',
        inicio: '2026-12-14T15:00:00Z',
        fin: '2026-12-18T11:00:00Z',
        destino: 'Mendoza',
      });

      // Viaje terminado de userB (terminó el 05/12).
      await crearReservaHttp(jwtB, {
        proveedor: 'rentadora-sur',
        tipoReserva: 'auto',
        numeroReserva: 'ARCH-B1',
        inicio: '2026-12-03T09:00:00Z',
        fin: '2026-12-05T18:00:00Z',
        origen: 'BRC',
        destino: 'Bariloche',
      });

      // Calentamos la cache Redis del panel de userA y verificamos hit.
      const p1 = await fetch(`${urlViajes}/panel`, {
        headers: { authorization: `Bearer ${jwtA}` },
      });
      expect(p1.headers.get('x-origen-dato')).toBe('replica');
      const p2 = await fetch(`${urlViajes}/panel`, {
        headers: { authorization: `Bearer ${jwtA}` },
      });
      expect(p2.headers.get('x-origen-dato')).toBe('cache');
      expect(((await p2.json()) as { viajes: ViajePublico[] }).viajes).toHaveLength(2);

      // Seguridad de /interna/archivado/ejecutar: solo token de servicio 'pruebas'.
      expect(
        (
          await fetch(`${urlViajes}/interna/archivado/ejecutar`, {
            method: 'POST',
            headers: { authorization: `Bearer ${jwtA}` },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${urlViajes}/interna/archivado/ejecutar`, {
            method: 'POST',
            headers: { authorization: `Bearer ${tokenCorreo}` },
          })
        ).status,
      ).toBe(403);

      // Retenemos el lock de la instancia 1 para probar concurrencia contra instancia 2 y HTTP 409.
      let soltarLock: (() => void) | undefined;
      promesaRetencionLock = new Promise<void>((r) => {
        soltarLock = r;
      });
      const lockTomado = new Promise<void>((r) => {
        avisarLockTomado = r;
      });

      const instancia2 = crearTareaArchivado({
        pool,
        cache,
        region: 'region-1',
        logger,
        cron: '0 3 * * *',
        ahora: () => reloj.ahora,
      });

      // Limpiamos outbox previo (altas manuales) para contar exactamente los eventos de archivado.
      await pool.query('TRUNCATE eventos_salientes');

      const corridaInstancia1 = tareaArchivado.evaluarProgramacion();
      await lockTomado;

      // Mientras instancia 1 sostiene el lock:
      // - instancia 2 omite la corrida sin error y devuelve null;
      // - POST /interna/archivado/ejecutar responde 409 Conflict.
      expect(await instancia2.ejecutar()).toBeNull();
      const res409 = await fetch(`${urlViajes}/interna/archivado/ejecutar`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenPruebas}` },
      });
      expect(res409.status).toBe(409);

      soltarLock?.();
      const resultado1 = await corridaInstancia1;
      expect(resultado1).toEqual({
        viajesArchivados: 2,
        reservasArchivadas: 3,
        ejecutadoEn: '2026-12-15T03:00:00.000Z',
      });

      // Mismo minuto del cron no vuelve a disparar; y una ejecución manual posterior archiva 0 (no repite).
      promesaRetencionLock = undefined;
      avisarLockTomado = undefined;
      expect(await tareaArchivado.evaluarProgramacion()).toBeNull();

      const resRepetida = await fetch(`${urlViajes}/interna/archivado/ejecutar`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenPruebas}` },
      });
      expect(resRepetida.status).toBe(200);
      expect((await resRepetida.json()) as ResultadoArchivado).toEqual({
        viajesArchivados: 0,
        reservasArchivadas: 0,
        ejecutadoEn: '2026-12-15T03:00:00.000Z',
      });

      // Outbox recibió exactamente 3 eventos ViajeActualizado con origenCambio 'archivado'.
      const outbox = (
        await pool.query<{ sobre: { datos: ViajeActualizadoDatos } }>(
          `SELECT sobre FROM eventos_salientes WHERE tipo = 'ViajeActualizado' ORDER BY id ASC`,
        )
      ).rows;
      expect(outbox).toHaveLength(3);
      expect(outbox.every((r) => r.sobre.datos.origenCambio === 'archivado')).toBe(true);
      expect(outbox.map((r) => r.sobre.datos.numeroReserva).sort()).toEqual([
        'ARCH-B1',
        'ARCH-H1',
        'ARCH-V1',
      ]);

      // La cache del panel de userA fue invalidada y ahora solo muestra el viaje en curso.
      const p3 = await fetch(`${urlViajes}/panel`, {
        headers: { authorization: `Bearer ${jwtA}` },
      });
      expect(p3.status).toBe(200);
      expect(p3.headers.get('x-origen-dato')).toBe('replica');
      const panelDespues = (await p3.json()) as { viajes: ViajePublico[] };
      expect(panelDespues.viajes).toHaveLength(1);
      expect(panelDespues.viajes[0]?.destino).toBe('Mendoza');

      // GET /archivados de userA devuelve el viaje archivado con origenCambio 'archivado'.
      const resArch = await fetch(`${urlViajes}/archivados`, {
        headers: { authorization: `Bearer ${jwtA}` },
      });
      expect(resArch.status).toBe(200);
      const archivados = (await resArch.json()) as ListaViajesPublica;
      expect(archivados.viajes).toHaveLength(1);
      expect(archivados.viajes[0]?.estado).toBe('archivado');
      expect(archivados.viajes[0]?.destino).toBe('Santiago');
      expect(archivados.viajes[0]?.reservas.every((r) => r.origenCambio === 'archivado')).toBe(
        true,
      );

      await instancia2.detener();
    });

    it('controla GET /viajes/{viajeId} para dueño y designado, rechaza con 403 + registro a terceros y falla cerrado con 503 si Usuarios cae', async () => {
      const duenoId = randomUUID();
      const designadoId = randomUUID();
      const intrusoId = randomUUID();
      const jwtDueno = await firmarJwt(claves, { sub: duenoId });
      const jwtDesignado = await firmarJwt(claves, { sub: designadoId });
      const jwtIntruso = await firmarJwt(claves, { sub: intrusoId });

      const creada = await crearReservaHttp(jwtDueno, {
        proveedor: 'aerolinea-andina',
        tipoReserva: 'vuelo',
        numeroReserva: 'COMP-1',
        inicio: '2026-12-20T08:00:00Z',
        fin: '2026-12-20T10:30:00Z',
        origen: 'EZE',
        destino: 'SCL',
      });
      const { viajeId } = creada;
      designadosPorViaje.set(viajeId, new Set([designadoId]));

      // 1) Dueño accede directo sin consultar a Usuarios.
      const resDueno = await fetch(`${urlViajes}/viajes/${viajeId}`, {
        headers: { authorization: `Bearer ${jwtDueno}` },
      });
      expect(resDueno.status).toBe(200);
      expect(((await resDueno.json()) as ViajePublico).viajeId).toBe(viajeId);
      expect(llamadasUsuarios).toHaveLength(0);

      // 2) Designado accede consultando a Usuarios con su JWT propagado.
      const resDesignado = await fetch(`${urlViajes}/viajes/${viajeId}`, {
        headers: { authorization: `Bearer ${jwtDesignado}` },
      });
      expect(resDesignado.status).toBe(200);
      expect(((await resDesignado.json()) as ViajePublico).reservas).toHaveLength(1);
      expect(llamadasUsuarios).toHaveLength(1);
      expect(llamadasUsuarios[0]).toMatchObject({
        viajeId,
        usuarioId: designadoId,
        auth: `Bearer ${jwtDesignado}`,
      });

      // 3) Otro usuario (no designado) recibe 403 y queda registrado en AccesoRechazado.
      const resIntruso = await fetch(`${urlViajes}/viajes/${viajeId}`, {
        headers: { authorization: `Bearer ${jwtIntruso}` },
      });
      expect(resIntruso.status).toBe(403);
      expect(resIntruso.headers.get('content-type')).toContain('application/problem+json');
      expect(
        rechazos.filter(
          (r) => r.status === 403 && r.usuarioId === intrusoId && r.motivo === 'sin-permiso',
        ),
      ).toHaveLength(1);

      // 4) Si se revoca el permiso del designado, la siguiente consulta se bloquea con 403.
      designadosPorViaje.get(viajeId)?.delete(designadoId);
      const resRevocado = await fetch(`${urlViajes}/viajes/${viajeId}`, {
        headers: { authorization: `Bearer ${jwtDesignado}` },
      });
      expect(resRevocado.status).toBe(403);

      // 5) Si Usuarios cae, no se permite acceso por defecto -> 503 (falla cerrada).
      usuariosCaido = true;
      const resSinUsuarios = await fetch(`${urlViajes}/viajes/${viajeId}`, {
        headers: { authorization: `Bearer ${jwtDesignado}` },
      });
      expect(resSinUsuarios.status).toBe(503);

      // 6) Viaje inexistente -> 404.
      expect(
        (
          await fetch(`${urlViajes}/viajes/${randomUUID()}`, {
            headers: { authorization: `Bearer ${jwtDueno}` },
          })
        ).status,
      ).toBe(404);
    });

    it('publica el itinerario en red social sin números de reserva (solo dueño) y degrada con 503 ante falla de Integraciones', async () => {
      const duenoId = randomUUID();
      const otroId = randomUUID();
      const jwtDueno = await firmarJwt(claves, { sub: duenoId });
      const jwtOtro = await firmarJwt(claves, { sub: otroId });

      const vuelo = await crearReservaHttp(jwtDueno, {
        proveedor: 'aerolinea-andina',
        tipoReserva: 'vuelo',
        numeroReserva: 'PNR-SECRETO-77',
        inicio: '2026-12-20T08:30:00Z',
        fin: '2026-12-20T10:40:00Z',
        origen: 'Buenos Aires (EZE)',
        destino: 'Santiago (SCL)',
        detalle: { numeroVuelo: 'AN 1234' },
      });
      await crearReservaHttp(jwtDueno, {
        proveedor: 'hotel-cordillera',
        tipoReserva: 'hotel',
        numeroReserva: 'CONF-HOTEL-999',
        inicio: '2026-12-20T15:00:00Z',
        fin: '2026-12-23T11:00:00Z',
        destino: 'Santiago',
        detalle: { nombreHotel: 'Hotel Cordillera' },
      });

      // Otro usuario intenta publicar -> 403 + rechazo registrado.
      const resAjeno = await fetch(`${urlViajes}/viajes/${vuelo.viajeId}/compartir-red`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwtOtro}`, 'content-type': 'application/json' },
        body: JSON.stringify({ red: 'redsocial' }),
      });
      expect(resAjeno.status).toBe(403);
      expect(rechazos.filter((r) => r.status === 403 && r.usuarioId === otroId)).toHaveLength(1);
      expect(publicacionesRecibidas).toHaveLength(0);

      // Dueño publica -> 201 y payload enviado a Integraciones no incluye ningún número de reserva ni usuarioId.
      const resOk = await fetch(`${urlViajes}/viajes/${vuelo.viajeId}/compartir-red`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwtDueno}`, 'content-type': 'application/json' },
        body: JSON.stringify({ red: 'redsocial' }),
      });
      expect(resOk.status).toBe(201);
      const publicacion = (await resOk.json()) as PublicacionRed;
      expect(publicacion.red).toBe('redsocial');
      expect(publicacion.url).toContain(vuelo.viajeId);

      expect(publicacionesRecibidas).toHaveLength(1);
      const enviado = publicacionesRecibidas[0];
      expect(enviado?.auth).toBe(`Bearer ${jwtDueno}`);
      expect(enviado?.cuerpo.itinerario.reservas).toHaveLength(2);
      const textoEnviado = JSON.stringify(enviado?.cuerpo);
      expect(textoEnviado).not.toContain('PNR-SECRETO-77');
      expect(textoEnviado).not.toContain('CONF-HOTEL-999');
      expect(textoEnviado).not.toContain(duenoId);
      expect(textoEnviado).not.toContain('numeroReserva');

      // Red inexistente (404 desde Integraciones) -> 404.
      integracionesEstado = '404';
      expect(
        (
          await fetch(`${urlViajes}/viajes/${vuelo.viajeId}/compartir-red`, {
            method: 'POST',
            headers: { authorization: `Bearer ${jwtDueno}`, 'content-type': 'application/json' },
            body: JSON.stringify({ red: 'red-desconocida' }),
          })
        ).status,
      ).toBe(404);

      // Integraciones / red social caída -> 503.
      integracionesEstado = '503';
      expect(
        (
          await fetch(`${urlViajes}/viajes/${vuelo.viajeId}/compartir-red`, {
            method: 'POST',
            headers: { authorization: `Bearer ${jwtDueno}`, 'content-type': 'application/json' },
            body: JSON.stringify({ red: 'redsocial' }),
          })
        ).status,
      ).toBe(503);
    });

    it('atiende rutas internas para Correo (usuarios-con-viaje-proximo) y Asistente (reservas por usuario y por número)', async () => {
      const userEnCurso = randomUUID();
      const userProximo = randomUUID();
      const userLejano = randomUUID();
      const userPasado = randomUUID();
      const jwtEnCurso = await firmarJwt(claves, { sub: userEnCurso });
      const jwtProximo = await firmarJwt(claves, { sub: userProximo });
      const jwtLejano = await firmarJwt(claves, { sub: userLejano });
      const jwtPasado = await firmarJwt(claves, { sub: userPasado });

      const tokenCorreo = await firmarTokenServicio(claves, 'correo');
      const tokenAsistente = await firmarTokenServicio(claves, 'asistente');

      // Ahora = 2026-12-15T03:00:00Z.
      await crearReservaHttp(jwtEnCurso, {
        proveedor: 'hotel-cordillera',
        tipoReserva: 'hotel',
        numeroReserva: 'INT-CURSO',
        inicio: '2026-12-14T12:00:00Z',
        fin: '2026-12-17T11:00:00Z',
        destino: 'Córdoba',
      });
      const rProx1 = await crearReservaHttp(jwtProximo, {
        proveedor: 'aerolinea-andina',
        tipoReserva: 'vuelo',
        numeroReserva: 'INT-PROX-1',
        inicio: '2026-12-18T08:00:00Z',
        fin: '2026-12-18T10:30:00Z',
        origen: 'EZE',
        destino: 'SCL',
      });
      await crearReservaHttp(jwtProximo, {
        proveedor: 'hotel-cordillera',
        tipoReserva: 'hotel',
        numeroReserva: 'INT-PROX-2',
        inicio: '2026-12-18T15:00:00Z',
        fin: '2026-12-20T11:00:00Z',
        destino: 'Santiago',
      });
      // Marcamos la 1ª reserva como cancelada para probar el filtro ?estado=confirmada.
      expect(
        (
          await fetch(`${urlViajes}/reservas/${rProx1.reservaId}`, {
            method: 'PATCH',
            headers: { authorization: `Bearer ${jwtProximo}`, 'content-type': 'application/json' },
            body: JSON.stringify({ estado: 'cancelada' }),
          })
        ).status,
      ).toBe(200);

      await crearReservaHttp(jwtLejano, {
        proveedor: 'hotel-cordillera',
        tipoReserva: 'hotel',
        numeroReserva: 'INT-LEJANO',
        inicio: '2027-01-10T15:00:00Z',
        fin: '2027-01-14T11:00:00Z',
        destino: 'Madrid',
      });
      await crearReservaHttp(jwtPasado, {
        proveedor: 'hotel-cordillera',
        tipoReserva: 'hotel',
        numeroReserva: 'INT-PASADO',
        inicio: '2026-12-01T15:00:00Z',
        fin: '2026-12-03T11:00:00Z',
        destino: 'Lima',
      });

      // 1) GET /interna/usuarios-con-viaje-proximo?dias=7
      expect(
        (
          await fetch(`${urlViajes}/interna/usuarios-con-viaje-proximo?dias=7`, {
            headers: { authorization: `Bearer ${jwtProximo}` },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${urlViajes}/interna/usuarios-con-viaje-proximo?dias=7`, {
            headers: { authorization: `Bearer ${tokenAsistente}` },
          })
        ).status,
      ).toBe(403);

      const resProximos = await fetch(`${urlViajes}/interna/usuarios-con-viaje-proximo?dias=7`, {
        headers: { authorization: `Bearer ${tokenCorreo}` },
      });
      expect(resProximos.status).toBe(200);
      const proximos = (await resProximos.json()) as UsuariosConViajeProximoRespuesta;
      expect(proximos.dias).toBe(7);
      expect(proximos.usuarioIds.sort()).toEqual([userEnCurso, userProximo].sort());

      // 2) GET /interna/reservas?usuarioId=...&estado=...
      const resTodas = await fetch(`${urlViajes}/interna/reservas?usuarioId=${userProximo}`, {
        headers: { authorization: `Bearer ${jwtProximo}` },
      });
      expect(resTodas.status).toBe(200);
      expect(((await resTodas.json()) as ListaReservasPublica).reservas).toHaveLength(2);

      const resConfirmadas = await fetch(
        `${urlViajes}/interna/reservas?usuarioId=${userProximo}&estado=confirmada`,
        { headers: { authorization: `Bearer ${jwtProximo}` } },
      );
      expect(resConfirmadas.status).toBe(200);
      const soloConfirmadas = (await resConfirmadas.json()) as ListaReservasPublica;
      expect(soloConfirmadas.reservas.map((r) => r.numeroReserva)).toEqual(['INT-PROX-2']);

      // Pedir reservas de otro usuario -> 403 + rechazo registrado.
      const resAjeno = await fetch(`${urlViajes}/interna/reservas?usuarioId=${userEnCurso}`, {
        headers: { authorization: `Bearer ${jwtProximo}` },
      });
      expect(resAjeno.status).toBe(403);
      expect(
        rechazos.filter(
          (r) => r.status === 403 && r.usuarioId === userProximo && r.ruta === '/interna/reservas',
        ),
      ).toHaveLength(1);

      // 3) GET /interna/reservas/{numeroReserva}?proveedor=...
      const resPorNumero = await fetch(
        `${urlViajes}/interna/reservas/INT-PROX-2?proveedor=hotel-cordillera`,
        { headers: { authorization: `Bearer ${jwtProximo}` } },
      );
      expect(resPorNumero.status).toBe(200);
      expect(((await resPorNumero.json()) as ReservaPublica).numeroReserva).toBe('INT-PROX-2');

      // Reserva de otro usuario -> 404 (no filtra existencia).
      expect(
        (
          await fetch(`${urlViajes}/interna/reservas/INT-CURSO?proveedor=hotel-cordillera`, {
            headers: { authorization: `Bearer ${jwtProximo}` },
          })
        ).status,
      ).toBe(404);
    });
  },
);
