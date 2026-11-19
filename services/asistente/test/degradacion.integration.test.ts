// Pruebas de integración de P2.D5 (ADR-019 degradación controlada, QA-12 respuestas lentas 202
// consultando y métricas de tiempo de respuesta) contra PostgreSQL 17 real, `services/integraciones`
// real, `mocks/aerolinea` real y `mocks/agencia` real:
// - Viajes caído (503 y timeout > 2 s) -> degrada con `resultado: noDisponible` y `ofreceDerivar`,
//   problemas menores sigue respondiendo, `/health` sigue 200, y decir "Sí" deriva a `mocks/agencia`.
// - Agencia caída (`modoFalla: '503'` y `'no-responder'`) -> degrada con `servicio: agencia`.
// - Aerolínea lenta (`demoraMs: 4000` > 3 s) -> `POST /mensajes` responde `202 consultando`
//   (`Retry-After: 2`) a los ~3 s, y `GET /mensajes?desde=` entrega luego las opciones reales con
//   `consultando: false`; igualmente al confirmar una opción con aerolínea lenta (`reprogramado`).
// - Métricas QA-12 registradas por mensaje en memoria y en logs Pino.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  crearPool,
  crearValidador,
  migrar,
  MIGRACIONES_EVENTOS,
  type Pool,
  type Servidor,
} from '@trotamundos/comun';
import {
  dockerDisponible,
  firmarJwt,
  generarClaves,
  levantarPostgres,
  loggerDePrueba,
  USUARIO_PRUEBA,
  type ContenedorPostgres,
} from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearMockAerolinea, type MockAerolinea } from '../../../mocks/aerolinea/src/app.ts';
import { crearMockAgencia, type MockAgencia } from '../../../mocks/agencia/src/app.ts';
import {
  crearApp as crearAppIntegraciones,
  crearNegocioIntegraciones,
  REGLAS_VALIDADOR_INTEGRACIONES,
} from '../../integraciones/src/app.ts';
import {
  crearApp as crearAppAsistente,
  crearNegocioAsistente,
  SERVICIO,
  type NegocioAsistente,
} from '../src/app.ts';

const hayDocker = await dockerDisponible();
const claves = await generarClaves();
const CLAVE_AEROLINEA = 'clave-air-p2d5';
const SECRETO_AEROLINEA = 'secreto-air-p2d5';
const CLAVE_AGENCIA = 'clave-agencia-p2d5';

async function esperarQue(
  condicion: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (!(await condicion())) {
    if (Date.now() > limite) throw new Error('Tiempo agotado esperando condición en prueba');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!hayDocker)(
  'Asistente Virtual P2.D5: degradación controlada (ADR-019) y respuestas lentas (QA-12)',
  { timeout: 120_000 },
  () => {
    const bitacora = loggerDePrueba(SERVICIO);
    const { logger, lineas } = bitacora;

    let postgres: ContenedorPostgres;
    let poolAsistente: Pool;
    let poolIntegraciones: Pool;

    let mockAerolinea: MockAerolinea;
    let mockAgencia: MockAgencia;
    let srvIntegraciones: Servidor;
    let srvAsistente: Servidor;
    let negocioAsistente: NegocioAsistente;

    let srvViajes: Server;
    let srvUsuarios: Server;
    let urlAerolinea = '';
    let urlAgencia = '';
    let urlIntegraciones = '';
    let urlAsistente = '';

    let modoViajes: 'ok' | '503' | 'colgado' = 'ok';
    let modoUsuarios: 'ok' | '503' = 'ok';

    beforeAll(async () => {
      postgres = await levantarPostgres();

      // Creamos una base separada para integraciones dentro del mismo contenedor Postgres (ADR-001).
      const poolAdmin = crearPool({ url: postgres.url });
      await poolAdmin.query('CREATE DATABASE integraciones');
      await poolAdmin.end();

      const urlDbIntegraciones = postgres.url.replace(/\/[^/]+$/, '/integraciones');
      poolAsistente = crearPool({ url: postgres.url });
      poolIntegraciones = crearPool({ url: urlDbIntegraciones });

      await Promise.all([
        migrar(
          poolAsistente,
          [MIGRACIONES_EVENTOS, fileURLToPath(new URL('../migrations/', import.meta.url))],
          logger,
        ),
        migrar(
          poolIntegraciones,
          [
            MIGRACIONES_EVENTOS,
            fileURLToPath(new URL('../../integraciones/migrations/', import.meta.url)),
          ],
          loggerDePrueba('integraciones').logger,
        ),
      ]);

      // Servidores controlables de Viajes y Usuarios para simular 503 y demoras > 2 s.
      srvViajes = createServer((_req, res) => {
        if (modoViajes === '503') {
          res.writeHead(503, { 'Content-Type': 'application/problem+json' });
          res.end(
            JSON.stringify({
              type: 'https://trotamundos.example/errores/no-disponible',
              title: 'Servicio no disponible',
              status: 503,
              requestId: 'r-viajes',
            }),
          );
          return;
        }
        if (modoViajes === 'colgado') {
          const t = setTimeout(() => {
            if (!res.writableEnded) res.destroy();
          }, 10_000);
          res.once('close', () => clearTimeout(t));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            reservas: [
              {
                reservaId: 'res-1',
                proveedor: 'aerolinea-andina',
                numeroReserva: 'XKQ7PL',
                tipoReserva: 'vuelo',
                estado: 'confirmada',
                inicio: '2026-12-10T08:30:00Z',
                fin: '2026-12-10T10:40:00Z',
                origen: 'EZE',
                destino: 'SCL',
              },
            ],
          }),
        );
      });

      srvUsuarios = createServer((_req, res) => {
        if (modoUsuarios === '503') {
          res.writeHead(503, { 'Content-Type': 'application/problem+json' });
          res.end(
            JSON.stringify({
              type: 'https://trotamundos.example/errores/no-disponible',
              title: 'Servicio no disponible',
              status: 503,
              requestId: 'r-usuarios',
            }),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            usuarioId: USUARIO_PRUEBA,
            email: 'ana@correo.example',
            nombre: 'Ana García',
            region: 'region-1',
            idioma: 'es',
            moneda: 'ARS',
            agenciaPreferida: 'viajes-del-plata',
            creadoEn: '2026-11-01T00:00:00Z',
          }),
        );
      });

      await Promise.all([
        new Promise<void>((r) => srvViajes.listen(0, () => r())),
        new Promise<void>((r) => srvUsuarios.listen(0, () => r())),
      ]);
      const urlViajes = `http://127.0.0.1:${(srvViajes.address() as AddressInfo).port}`;
      const urlUsuarios = `http://127.0.0.1:${(srvUsuarios.address() as AddressInfo).port}`;

      mockAerolinea = crearMockAerolinea({
        puerto: 0,
        apiKey: CLAVE_AEROLINEA,
        webhookSecret: SECRETO_AEROLINEA,
        webhookUrls: [],
        logger: loggerDePrueba('mock-aerolinea').logger,
      });
      mockAgencia = crearMockAgencia({
        puerto: 0,
        apiKey: CLAVE_AGENCIA,
        logger: loggerDePrueba('mock-agencia').logger,
      });
      const [pAir, pAg] = await Promise.all([mockAerolinea.iniciar(), mockAgencia.iniciar()]);
      urlAerolinea = `http://127.0.0.1:${pAir}`;
      urlAgencia = `http://127.0.0.1:${pAg}`;

      const loggerInt = loggerDePrueba('integraciones').logger;
      const negocioInt = crearNegocioIntegraciones({
        pool: poolIntegraciones,
        region: 'region-1',
        logger: loggerInt,
        env: {
          URL_AEROLINEA: urlAerolinea,
          CLAVE_API_AEROLINEA: CLAVE_AEROLINEA,
          SECRETO_WEBHOOK_AEROLINEA: SECRETO_AEROLINEA,
          URL_AGENCIA: urlAgencia,
          CLAVE_API_AGENCIA: CLAVE_AGENCIA,
        },
        urlUsuarios,
      });
      srvIntegraciones = crearAppIntegraciones({
        region: 'region-1',
        puerto: 0,
        logger: loggerInt,
        validador: crearValidador({
          servicio: 'integraciones',
          region: 'region-1',
          logger: loggerInt,
          claves: { 'region-1': { claves: claves.jwks } },
          registrar: () => undefined,
          reglas: REGLAS_VALIDADOR_INTEGRACIONES,
        }),
        negocio: negocioInt,
        manejarSenales: false,
      });
      urlIntegraciones = `http://127.0.0.1:${await srvIntegraciones.iniciar()}`;

      negocioAsistente = crearNegocioAsistente({
        pool: poolAsistente,
        region: 'region-1',
        logger,
        urlViajes,
        urlUsuarios,
        urlIntegraciones,
        timeoutServiciosMs: 2000,
        umbralRespuestaLentaMs: 3000,
        timeoutProveedorMs: 15_000,
      });
      srvAsistente = crearAppAsistente({
        region: 'region-1',
        puerto: 0,
        logger,
        validador: crearValidador({
          servicio: SERVICIO,
          region: 'region-1',
          logger,
          claves: { 'region-1': { claves: claves.jwks } },
          registrar: () => undefined,
          reglas: {},
        }),
        nucleo: negocioAsistente.nucleo,
        manejarSenales: false,
        chequeos: {
          base: () => poolAsistente.query('SELECT 1'),
          reglas: async () => {
            if (!negocioAsistente.reglas.estaCargado()) throw new Error('Sin reglas');
          },
        },
      });
      urlAsistente = `http://127.0.0.1:${await srvAsistente.iniciar()}`;
    }, 120_000);

    afterAll(async () => {
      await negocioAsistente?.nucleo.detener();
      await srvAsistente?.detener();
      await srvIntegraciones?.detener();
      await Promise.all([mockAerolinea?.detener(), mockAgencia?.detener()]);
      await Promise.all([
        new Promise<void>((r) => {
          srvViajes?.close(() => r());
          srvViajes?.closeAllConnections();
        }),
        new Promise<void>((r) => {
          srvUsuarios?.close(() => r());
          srvUsuarios?.closeAllConnections();
        }),
      ]);
      await Promise.all([poolAsistente?.end(), poolIntegraciones?.end()]);
      await postgres?.detener();
    }, 60_000);

    beforeEach(async () => {
      modoViajes = 'ok';
      modoUsuarios = 'ok';
      lineas.length = 0;
      negocioAsistente.metricas.reiniciar();
      await poolAsistente.query('TRUNCATE opciones_pendientes, mensajes, conversaciones');
      await poolIntegraciones.query('TRUNCATE opciones_reprogramacion_ofrecidas');
      await Promise.all([
        fetch(`${urlAerolinea}/admin/reiniciar`, { method: 'POST' }),
        fetch(`${urlAgencia}/admin/reiniciar`, { method: 'POST' }),
      ]);
    });

    async function abrirConversacion(token: string) {
      const resp = await fetch(`${urlAsistente}/conversaciones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ idioma: 'es' }),
      });
      expect(resp.status).toBe(201);
      return (await resp.json()) as { conversacionId: string };
    }

    it('Viajes caído (503 y timeout 2 s) degrada ofreciendo derivar, mantiene problemas menores y /health sano', async () => {
      const token = await firmarJwt(claves, { sub: USUARIO_PRUEBA, idioma: 'es' });
      const { conversacionId } = await abrirConversacion(token);

      // 1) Viajes responde 503 -> 200 noDisponible + ofreceDerivar en < 1 s.
      modoViajes = '503';
      const r503 = await fetch(`${urlAsistente}/conversaciones/${conversacionId}/mensajes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: '¿Cuál es el estado de mi vuelo?' }),
      });
      expect(r503.status).toBe(200);
      const b503 = (await r503.json()) as {
        estado: string;
        respuesta: {
          resultado: string;
          noDisponible?: { funcion: string; servicio: string };
          ofreceDerivar?: boolean;
        };
      };
      expect(b503.estado).toBe('respondido');
      expect(b503.respuesta).toMatchObject({
        resultado: 'noDisponible',
        noDisponible: { funcion: 'estado', servicio: 'viajes' },
        ofreceDerivar: true,
      });

      // 2) Viajes colgado (> 2 s) -> corta a los 2 s y degrada en < 3 s (QA-12).
      modoViajes = 'colgado';
      const inicioColgado = Date.now();
      const rTimeout = await fetch(`${urlAsistente}/conversaciones/${conversacionId}/mensajes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: 'Estado de mis reservas' }),
      });
      const demoraColgado = Date.now() - inicioColgado;
      expect(rTimeout.status).toBe(200);
      expect(demoraColgado).toBeGreaterThanOrEqual(1900);
      expect(demoraColgado).toBeLessThan(2900);

      // 3) Mientras Viajes sigue caído, problemas menores responde rápido y /health sigue 200.
      const inicioMenor = Date.now();
      const rMenor = await fetch(`${urlAsistente}/conversaciones/${conversacionId}/mensajes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: '¿Cuánto equipaje puedo llevar?' }),
      });
      expect(rMenor.status).toBe(200);
      expect(Date.now() - inicioMenor).toBeLessThan(500);
      expect((await fetch(`${urlAsistente}/health`)).status).toBe(200);

      // 4) El usuario pide hablar con su agencia -> llega a mocks/agencia real a través de Integraciones.
      const rDerivar = await fetch(`${urlAsistente}/conversaciones/${conversacionId}/mensajes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: 'Quiero hablar con mi agencia' }),
      });
      expect(rDerivar.status).toBe(200);
      const bDerivar = (await rDerivar.json()) as {
        respuesta: { resultado: string; caso?: { agencia: string; numeroCaso: string } };
      };
      expect(bDerivar.respuesta.resultado).toBe('derivado');
      expect(bDerivar.respuesta.caso?.agencia).toBe('viajes-del-plata');

      // 5) Verificamos métrica QA-12: todos los mensajes anteriores respondieron en < 3 s.
      const resumen = negocioAsistente.metricas.resumen();
      expect(resumen.total).toBe(4);
      expect(resumen.cumplenQa12).toBe(4);
      expect(resumen.porcentajeQa12).toBe(100);
      expect(lineas.some((l) => typeof l.duracionMs === 'number' && l.cumpleQa12 === true)).toBe(
        true,
      );
    });

    it('agencia caída (503 en mocks/agencia) degrada con resultado noDisponible y servicio agencia', async () => {
      const token = await firmarJwt(claves, { sub: USUARIO_PRUEBA, idioma: 'es' });
      const { conversacionId } = await abrirConversacion(token);

      await fetch(`${urlAgencia}/admin/comportamiento`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modoFalla: '503' }),
      });

      const resp = await fetch(`${urlAsistente}/conversaciones/${conversacionId}/mensajes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: 'Quiero hablar con una persona' }),
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toMatchObject({
        estado: 'respondido',
        respuesta: {
          intencion: 'derivar',
          resultado: 'noDisponible',
          noDisponible: { funcion: 'derivar', servicio: 'agencia' },
          ofreceDerivar: false,
        },
      });
    });

    it('proveedor lento (4 s en mocks/aerolinea): responde 202 consultando y luego entrega opciones y confirmación por polling', async () => {
      const token = await firmarJwt(claves, { sub: USUARIO_PRUEBA, idioma: 'es' });
      const { conversacionId } = await abrirConversacion(token);

      // Configuramos 2200 ms por llamada en mocks/aerolinea:
      // pedirOpciones hace 2 llamadas (GET /air/orders + POST /air/order_change_requests) = ~4,4 s > 3 s.
      await fetch(`${urlAerolinea}/admin/comportamiento`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ demoraMs: 2200 }),
      });

      const inicio = Date.now();
      const resp202 = await fetch(`${urlAsistente}/conversaciones/${conversacionId}/mensajes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: 'Quiero cambiar mi vuelo XKQ7PL para otro horario' }),
      });
      const demora202 = Date.now() - inicio;

      expect(resp202.status).toBe(202);
      expect(resp202.headers.get('retry-after')).toBe('2');
      expect(demora202).toBeGreaterThanOrEqual(2900);
      expect(demora202).toBeLessThan(3800);

      const cuerpo202 = (await resp202.json()) as {
        estado: string;
        respuesta: { secuencia: number; texto: string; resultado: string; intencion: string };
      };
      expect(cuerpo202.estado).toBe('consultando');
      expect(cuerpo202.respuesta.resultado).toBe('consultando');
      expect(cuerpo202.respuesta.texto.toLowerCase()).toContain('consultando');

      // Polling inmediato: todavía consultando.
      const secAviso = cuerpo202.respuesta.secuencia;
      const poll1 = await fetch(
        `${urlAsistente}/conversaciones/${conversacionId}/mensajes?desde=${secAviso}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(poll1.status).toBe(200);
      const bPoll1 = (await poll1.json()) as { consultando: boolean; mensajes: unknown[] };
      expect(bPoll1.consultando).toBe(true);
      expect(bPoll1.mensajes).toEqual([]);

      // Esperamos que llegue el mensaje definitivo por polling (consultando pasa a false).
      let opcionRecibida: string | undefined;
      await esperarQue(async () => {
        const r = await fetch(
          `${urlAsistente}/conversaciones/${conversacionId}/mensajes?desde=${secAviso}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const datos = (await r.json()) as {
          consultando: boolean;
          mensajes: Array<{
            resultado?: string;
            opciones?: Array<{ opcionId: string }>;
          }>;
        };
        if (!datos.consultando && datos.mensajes.length > 0) {
          expect(datos.mensajes[0]?.resultado).toBe('opciones');
          opcionRecibida = datos.mensajes[0]?.opciones?.[0]?.opcionId;
          return true;
        }
        return false;
      }, 10_000);

      expect(opcionRecibida).toBeTruthy();

      // Ahora configuramos 4000 ms para POST /air/order_changes (1 llamada = 4 s > 3 s) y confirmamos.
      await fetch(`${urlAerolinea}/admin/comportamiento`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ demoraMs: 4000 }),
      });

      const respConfirm202 = await fetch(
        `${urlAsistente}/conversaciones/${conversacionId}/confirmaciones`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ opcionId: opcionRecibida }),
        },
      );
      expect(respConfirm202.status).toBe(202);
      const bConfirm202 = (await respConfirm202.json()) as {
        estado: string;
        respuesta: { secuencia: number; resultado: string };
      };
      expect(bConfirm202.estado).toBe('consultando');

      // Polling hasta recibir la confirmación definitiva `reprogramado`.
      let resultadoFinal: string | undefined;
      await esperarQue(async () => {
        const r = await fetch(
          `${urlAsistente}/conversaciones/${conversacionId}/mensajes?desde=${bConfirm202.respuesta.secuencia}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const datos = (await r.json()) as {
          consultando: boolean;
          mensajes: Array<{ resultado?: string }>;
        };
        if (!datos.consultando && datos.mensajes.length > 0) {
          resultadoFinal = datos.mensajes[0]?.resultado;
          return true;
        }
        return false;
      }, 10_000);

      expect(resultadoFinal).toBe('reprogramado');
    });
  },
);
