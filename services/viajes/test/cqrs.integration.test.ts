// Pruebas de integración de CQRS liviano y gestión manual UC-4 (P2.C2) contra PostgreSQL 17 real
// y Redis 8 real (testcontainers):
// - Primera lectura GET /panel -> X-Origen-Dato: replica y guarda panel:{usuarioId} (TTL 10 min);
//   segunda lectura -> X-Origen-Dato: cache.
// - Escrituras manuales (POST, PATCH, DELETE /reservas) invalidan panel:{usuarioId} y publican
//   ViajeActualizado con origenCambio: "manual" (y estado "cancelada" en DELETE, borrando viaje vacío).
// - Degradación controlada: Redis caído lee de la réplica sin fallar; réplica caída lee de la principal.
// - Autorización: otro usuario recibe 403 al modificar/eliminar reserva ajena y queda registrado.
// - Consulta interna GET /interna/viajes/{viajeId}/dueno.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  crearPool,
  crearValidador,
  enTransaccion,
  migrar,
  MIGRACIONES_EVENTOS,
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
import { createClient } from 'redis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearApp, SERVICIO } from '../src/app.ts';
import { clavePanelUsuario, crearCacheRedis, type CachePanel } from '../src/cache.ts';
import { crearGestorViajes } from '../src/gestor.ts';
import type { PanelPublico, ReservaPublica, ViajeActualizadoDatos } from '../src/modelo.ts';
import { crearNegocioViajes } from '../src/rutas.ts';

const hayDocker = await dockerDisponible();
const claves = await generarClaves();

describe.skipIf(!hayDocker)(
  'CQRS liviano, Cache Redis, Read Replica y Gestión Manual UC-4 (PostgreSQL + Redis)',
  { timeout: 120_000 },
  () => {
    const { logger } = loggerDePrueba(SERVICIO);
    const rechazos: AccesoRechazado[] = [];

    let postgres: ContenedorPostgres;
    let redisContenedor: StartedTestContainer;
    let urlRedis = '';
    let poolPrincipal: Pool;
    let poolLectura: Pool;
    let cache: CachePanel;
    let urlViajes = '';
    let detenerApp: (() => Promise<void>) | undefined;
    let simularFallaReplica = false;

    beforeAll(async () => {
      [postgres, redisContenedor] = await Promise.all([
        levantarPostgres(),
        new GenericContainer('redis:8-alpine').withExposedPorts(6379).start(),
      ]);
      urlRedis = `redis://${redisContenedor.getHost()}:${redisContenedor.getMappedPort(6379)}`;
      poolPrincipal = crearPool({ url: postgres.url, maximo: 15 });
      const poolReplicaReal = crearPool({ url: postgres.url, maximo: 10 });

      // Envolvemos el pool de lectura para poder simular caída de la read replica en la prueba.
      poolLectura = new Proxy(poolReplicaReal, {
        get(objetivo, prop, receptor) {
          if (prop === 'query') {
            return (...args: Parameters<Pool['query']>) => {
              if (simularFallaReplica) {
                return Promise.reject(new Error('Read replica temporalmente caída'));
              }
              return objetivo.query(...args);
            };
          }
          const valor = Reflect.get(objetivo, prop, receptor);
          return typeof valor === 'function' ? valor.bind(objetivo) : valor;
        },
      });

      await migrar(poolPrincipal, [
        MIGRACIONES_EVENTOS,
        fileURLToPath(new URL('../migrations/', import.meta.url)),
      ]);

      cache = await crearCacheRedis({
        url: urlRedis,
        logger,
        ttlSegundos: 600,
        timeoutMs: 300,
      });

      const gestor = crearGestorViajes({ region: 'region-1', logger });
      const registrar = (r: AccesoRechazado) => {
        rechazos.push(r);
      };
      const negocio = crearNegocioViajes({
        poolPrincipal,
        poolLectura,
        cache,
        gestor,
        logger,
        registrar,
      });

      const app = crearApp({
        region: 'region-1',
        puerto: 0,
        logger,
        validador: crearValidador({
          servicio: SERVICIO,
          region: 'region-1',
          logger,
          claves: { 'region-1': { claves: claves.jwks } },
          registrar,
        }),
        negocio,
        manejarSenales: false,
      });
      urlViajes = `http://127.0.0.1:${await app.iniciar()}`;
      detenerApp = async () => {
        await app.detener();
        await poolReplicaReal.end();
      };
    }, 90_000);

    afterAll(async () => {
      await detenerApp?.();
      await cache?.cerrar();
      await poolPrincipal?.end();
      await redisContenedor?.stop().catch(() => undefined);
      await postgres?.detener();
    }, 30_000);

    beforeEach(async () => {
      simularFallaReplica = false;
      rechazos.length = 0;
      await poolPrincipal.query(
        'TRUNCATE reservas, viajes, eventos_procesados, eventos_salientes CASCADE',
      );
    });

    it('segunda lectura sale de cache Redis (panel:{usuarioId}, TTL 10 min) y las escrituras manuales la invalidan publicando ViajeActualizado', async () => {
      const usuarioId = randomUUID();
      const jwt = await firmarJwt(claves, { sub: usuarioId });
      const headersAuth = {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      };

      // 1) Alta manual de vuelo (POST /reservas)
      const resCrear = await fetch(`${urlViajes}/reservas`, {
        method: 'POST',
        headers: headersAuth,
        body: JSON.stringify({
          proveedor: 'aerolinea-andina',
          tipoReserva: 'vuelo',
          numeroReserva: 'MAN-001',
          inicio: '2026-12-10T08:30:00Z',
          fin: '2026-12-10T10:45:00Z',
          origen: 'Buenos Aires (EZE)',
          destino: 'Santiago (SCL)',
          detalle: { numeroVuelo: 'AN 100' },
        }),
      });
      expect(resCrear.status).toBe(201);
      const creada = (await resCrear.json()) as ReservaPublica;
      expect(resCrear.headers.get('location')).toBe(`/api/viajes/reservas/${creada.reservaId}`);
      expect(creada.origenCambio).toBe('manual');
      expect(creada.estado).toBe('confirmada');

      // Duplicado por proveedor + numeroReserva responde 409.
      const resDup = await fetch(`${urlViajes}/reservas`, {
        method: 'POST',
        headers: headersAuth,
        body: JSON.stringify({
          proveedor: 'aerolinea-andina',
          tipoReserva: 'vuelo',
          numeroReserva: 'MAN-001',
          inicio: '2026-12-10T08:30:00Z',
          fin: '2026-12-10T10:45:00Z',
          origen: 'EZE',
          destino: 'SCL',
        }),
      });
      expect(resDup.status).toBe(409);

      // 2) Primera consulta GET /panel -> replica y pobla Redis con clave panel:{usuarioId}
      const p1 = await fetch(`${urlViajes}/panel`, { headers: { authorization: `Bearer ${jwt}` } });
      expect(p1.status).toBe(200);
      expect(p1.headers.get('x-origen-dato')).toBe('replica');
      const bodyP1 = (await p1.json()) as PanelPublico;
      expect(bodyP1.viajes).toHaveLength(1);
      expect(bodyP1.viajes[0]?.reservas).toHaveLength(1);

      // Verificamos clave y TTL directamente en Redis.
      const inspector = createClient({ url: urlRedis });
      await inspector.connect();
      try {
        const ttl = await inspector.ttl(clavePanelUsuario(usuarioId));
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(600);
      } finally {
        await inspector.quit();
      }

      // 3) Segunda consulta GET /panel -> cache
      const p2 = await fetch(`${urlViajes}/panel`, { headers: { authorization: `Bearer ${jwt}` } });
      expect(p2.status).toBe(200);
      expect(p2.headers.get('x-origen-dato')).toBe('cache');
      expect(await p2.json()).toEqual(bodyP1);

      // 4) Modificación manual (PATCH /reservas/{reservaId}) invalida la cache y publica ViajeActualizado
      const resPatch = await fetch(`${urlViajes}/reservas/${creada.reservaId}`, {
        method: 'PATCH',
        headers: headersAuth,
        body: JSON.stringify({
          inicio: '2026-12-10T09:30:00Z',
          fin: '2026-12-10T11:45:00Z',
          estado: 'modificada',
        }),
      });
      expect(resPatch.status).toBe(200);
      const modificada = (await resPatch.json()) as ReservaPublica;
      expect(modificada.estado).toBe('modificada');
      expect(modificada.inicio).toBe('2026-12-10T09:30:00.000Z');

      // PATCH con fin < inicio responde 409.
      const resFechaInvalida = await fetch(`${urlViajes}/reservas/${creada.reservaId}`, {
        method: 'PATCH',
        headers: headersAuth,
        body: JSON.stringify({ fin: '2026-12-10T08:00:00Z' }),
      });
      expect(resFechaInvalida.status).toBe(409);

      // Siguiente lectura sale de replica (cache fue invalidada) y refleja el nuevo horario.
      const p3 = await fetch(`${urlViajes}/panel`, { headers: { authorization: `Bearer ${jwt}` } });
      expect(p3.status).toBe(200);
      expect(p3.headers.get('x-origen-dato')).toBe('replica');
      const bodyP3 = (await p3.json()) as PanelPublico;
      expect(bodyP3.viajes[0]?.reservas[0]?.estado).toBe('modificada');

      // 5) Baja manual (DELETE /reservas/{reservaId}) borra reserva + viaje vacío, invalida cache y publica cancelada
      const resDel = await fetch(`${urlViajes}/reservas/${creada.reservaId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(resDel.status).toBe(204);

      const p4 = await fetch(`${urlViajes}/panel`, { headers: { authorization: `Bearer ${jwt}` } });
      expect(p4.status).toBe(200);
      expect(p4.headers.get('x-origen-dato')).toBe('replica');
      expect(await p4.json()).toEqual({ viajes: [] });

      // Verificamos los 3 eventos ViajeActualizado en el outbox con origenCambio = manual.
      const outboxRows = (
        await poolPrincipal.query<{ sobre: { datos: ViajeActualizadoDatos } }>(
          `SELECT sobre FROM eventos_salientes WHERE tipo = 'ViajeActualizado' ORDER BY id ASC`,
        )
      ).rows;
      expect(outboxRows.map((r) => [r.sobre.datos.estado, r.sobre.datos.origenCambio])).toEqual([
        ['confirmada', 'manual'],
        ['modificada', 'manual'],
        ['cancelada', 'manual'],
      ]);
    });

    it('otro usuario recibe 403 al intentar modificar o eliminar una reserva ajena y queda registrado', async () => {
      const duenoId = randomUUID();
      const otroId = randomUUID();
      const jwtDueno = await firmarJwt(claves, { sub: duenoId });
      const jwtOtro = await firmarJwt(claves, { sub: otroId });

      const resCrear = await fetch(`${urlViajes}/reservas`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwtDueno}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          proveedor: 'hotel-cordillera',
          tipoReserva: 'hotel',
          numeroReserva: 'PRIV-1',
          inicio: '2026-12-15T15:00:00Z',
          fin: '2026-12-18T11:00:00Z',
          destino: 'Bariloche',
        }),
      });
      expect(resCrear.status).toBe(201);
      const creada = (await resCrear.json()) as ReservaPublica;

      // Consulta interna de dueño (usada por Usuarios para designados).
      const rDuenoSi = await fetch(`${urlViajes}/interna/viajes/${creada.viajeId}/dueno`, {
        headers: { authorization: `Bearer ${jwtDueno}` },
      });
      expect(rDuenoSi.status).toBe(200);
      expect(await rDuenoSi.json()).toEqual({ viajeId: creada.viajeId, esDueno: true });

      const rDuenoNo = await fetch(`${urlViajes}/interna/viajes/${creada.viajeId}/dueno`, {
        headers: { authorization: `Bearer ${jwtOtro}` },
      });
      expect(rDuenoNo.status).toBe(200);
      expect(await rDuenoNo.json()).toEqual({ viajeId: creada.viajeId, esDueno: false });

      // Otro usuario intenta modificar y eliminar -> 403 y rechazo registrado.
      const resPatchAjeno = await fetch(`${urlViajes}/reservas/${creada.reservaId}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${jwtOtro}`, 'content-type': 'application/json' },
        body: JSON.stringify({ destino: 'Hackeado' }),
      });
      expect(resPatchAjeno.status).toBe(403);
      expect(resPatchAjeno.headers.get('content-type')).toContain('application/problem+json');

      const resDelAjeno = await fetch(`${urlViajes}/reservas/${creada.reservaId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${jwtOtro}` },
      });
      expect(resDelAjeno.status).toBe(403);

      expect(rechazos.filter((r) => r.status === 403 && r.usuarioId === otroId)).toHaveLength(2);

      // La reserva del dueño sigue intacta.
      const resPanel = await fetch(`${urlViajes}/panel`, {
        headers: { authorization: `Bearer ${jwtDueno}` },
      });
      const panel = (await resPanel.json()) as PanelPublico;
      expect(panel.viajes[0]?.reservas[0]?.destino).toBe('Bariloche');
    });

    it('degrada sin fallar cuando la read replica cae y cuando Redis cae', async () => {
      const usuarioId = randomUUID();
      const jwt = await firmarJwt(claves, { sub: usuarioId });

      // Creamos una reserva directamente vía gestor para verificar también la invalidación desde eventos.
      const gestor = crearGestorViajes({ region: 'region-1', logger });
      await enTransaccion(poolPrincipal, (db) =>
        gestor.procesarReservaDetectada(db, {
          usuarioId,
          proveedor: 'rentadora-sur',
          tipoReserva: 'auto',
          numeroReserva: 'FALLBACK-1',
          inicio: '2026-12-22T10:00:00Z',
          fin: '2026-12-24T10:00:00Z',
          origen: 'Mendoza',
          destino: 'Mendoza',
          estado: 'confirmada',
          detalle: {},
          correoId: 'msg-fb-1',
        }),
      );

      // 1) Read replica caída (cache fría): debe caer a la base principal sin fallar.
      simularFallaReplica = true;
      const resSinReplica = await fetch(`${urlViajes}/panel`, {
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(resSinReplica.status).toBe(200);
      expect(resSinReplica.headers.get('x-origen-dato')).toBe('replica');
      const panelSinReplica = (await resSinReplica.json()) as PanelPublico;
      expect(panelSinReplica.viajes[0]?.reservas[0]?.numeroReserva).toBe('FALLBACK-1');

      // 2) Redis caído (detenemos el contenedor Redis real) y réplica operativa -> responde 200 desde réplica.
      simularFallaReplica = false;
      await redisContenedor.stop();

      const resSinRedis = await fetch(`${urlViajes}/panel`, {
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(resSinRedis.status).toBe(200);
      expect(resSinRedis.headers.get('x-origen-dato')).toBe('replica');
      const panelSinRedis = (await resSinRedis.json()) as PanelPublico;
      expect(panelSinRedis.viajes[0]?.reservas[0]?.numeroReserva).toBe('FALLBACK-1');
    });
  },
);
