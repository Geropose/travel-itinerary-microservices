// Pruebas de integración de Procesadores y Filtro de remitentes (P2.B6) contra PostgreSQL 17,
// RabbitMQ 4 (testcontainers), mocks reales de Gmail y Outlook y generador de lotes:
// - Lote de 1.000 correos generados por el mock: >= 99 % de los de viaje detectados,
//   publicación de ReservaDetectada por outbox validada contra el schema JSON.
// - Filtro de remitentes consumiendo FiltrosActualizados (idempotente): ninguno fuera de la
//   whitelist se procesa ni entra a no_procesados.
// - Mismo correo procesado dos veces / múltiples workers en paralelo -> un solo evento.
// - Correos de viaje no interpretables -> no_procesados + consulta paginada y filtrada GET /no-procesados.
// - Correos no-viaje ignorados sin guardar contenido.
import { randomBytes, randomUUID } from 'node:crypto';
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
} from '@trotamundos/comun';
import {
  dockerDisponible,
  firmarJwt,
  generarClaves,
  levantarPostgres,
  levantarRabbit,
  loggerDePrueba,
  type ContenedorPostgres,
  type ContenedorRabbit,
} from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generarLote, REMITENTE_NO_PERMITIDO } from '../../../mocks/comun/src/generador.ts';
import {
  crearMock as crearMockGmail,
  type Mock as MockGmail,
} from '../../../mocks/gmail/src/app.ts';
import {
  crearMock as crearMockOutlook,
  type Mock as MockOutlook,
} from '../../../mocks/outlook/src/app.ts';
import { crearApp, crearNegocioCorreo, SERVICIO } from '../src/app.ts';
import { conectarColaBuzones, type ColaBuzones } from '../src/cola.ts';
import type { ReservaDetectadaDatos } from '../src/extractor.ts';
import * as repositorio from '../src/repositorio.ts';

const hayDocker = await dockerDisponible();
const claves = await generarClaves();

const CLIENT_ID_GMAIL = 'trotamundos-local.apps.googleusercontent.com';
const SECRETO_GMAIL = 'secreto-gmail-procesador';
const CLIENT_ID_OUTLOOK = '11112222-bbbb-3333-cccc-4444dddd5555';
const SECRETO_OUTLOOK = 'secreto-outlook-procesador';
const REDIRECT_URI = 'http://localhost:8000/region-1/api/correo/oauth/callback';
const TOPICO_GMAIL = 'projects/trotamundos/topics/gmail-avisos-region-1';
const CLAVE_TOKENS = randomBytes(32).toString('base64');

async function esperarQue(
  condicion: () => boolean | Promise<boolean>,
  timeoutMs = 45_000,
): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (!(await condicion())) {
    if (Date.now() > limite) throw new Error('Tiempo agotado esperando condición en prueba');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!hayDocker)(
  'Procesadores de Correo y Filtro de remitentes (PostgreSQL + RabbitMQ)',
  { timeout: 240_000 },
  () => {
    const { logger } = loggerDePrueba(SERVICIO);

    let postgres: ContenedorPostgres;
    let rabbit: ContenedorRabbit;
    let pool: Pool;
    let brokerCorreo: Broker;
    let brokerUsuarios: Broker;
    let brokerViajes: Broker;
    let colaExaminador: ColaBuzones;
    let colaProcesadores: ColaBuzones;
    let outbox: PublicadorOutbox;

    let mockGmail: MockGmail;
    let mockOutlook: MockOutlook;
    let urlGmail = '';
    let urlOutlook = '';
    let urlCorreo = '';
    let negocio: ReturnType<typeof crearNegocioCorreo>;
    let detenerCorreo: (() => Promise<void>) | undefined;

    const reservasPublicadas: { eventId: string; datos: ReservaDetectadaDatos }[] = [];

    beforeAll(async () => {
      [postgres, rabbit] = await Promise.all([levantarPostgres(), levantarRabbit()]);
      pool = crearPool({ url: postgres.url });
      await migrar(pool, [
        MIGRACIONES_EVENTOS,
        fileURLToPath(new URL('../migrations/', import.meta.url)),
      ]);

      [brokerCorreo, brokerUsuarios, brokerViajes, colaExaminador, colaProcesadores] =
        await Promise.all([
          conectarBroker({ url: rabbit.url, servicio: SERVICIO, region: 'region-1', logger }),
          conectarBroker({ url: rabbit.url, servicio: 'usuarios', region: 'region-1', logger }),
          conectarBroker({ url: rabbit.url, servicio: 'viajes', region: 'region-1', logger }),
          conectarColaBuzones({ url: rabbit.url, logger }),
          conectarColaBuzones({ url: rabbit.url, logger }),
        ]);

      await brokerViajes.consumir<ReservaDetectadaDatos>({
        tipo: 'ReservaDetectada',
        pool,
        manejar: async (evento) => {
          reservasPublicadas.push({ eventId: evento.eventId, datos: evento.datos });
        },
      });

      mockGmail = crearMockGmail({
        puerto: 0,
        logger: loggerDePrueba('mock-gmail').logger,
        clientId: CLIENT_ID_GMAIL,
        clientSecret: SECRETO_GMAIL,
        redirectUris: [REDIRECT_URI],
        cuotaPorMinuto: 250_000, // Suficiente para leer el lote de 1.000 correos completo sin 429.
        semillas: false,
      });
      mockOutlook = crearMockOutlook({
        puerto: 0,
        logger: loggerDePrueba('mock-outlook').logger,
        clientId: CLIENT_ID_OUTLOOK,
        clientSecret: SECRETO_OUTLOOK,
        redirectUris: [REDIRECT_URI],
        semillas: false,
      });

      const [puertoGmail, puertoOutlook] = await Promise.all([
        mockGmail.iniciar(),
        mockOutlook.iniciar(),
      ]);
      urlGmail = `http://127.0.0.1:${puertoGmail}`;
      urlOutlook = `http://127.0.0.1:${puertoOutlook}`;

      negocio = crearNegocioCorreo({
        pool,
        region: 'region-1',
        claveTokensBase64: CLAVE_TOKENS,
        urlWeb: 'http://localhost:5173',
        logger,
        gmail: {
          urlApi: urlGmail,
          clientId: CLIENT_ID_GMAIL,
          clientSecret: SECRETO_GMAIL,
          redirectUri: REDIRECT_URI,
          topicoWatch: TOPICO_GMAIL,
        },
        outlook: {
          urlApi: urlOutlook,
          clientId: CLIENT_ID_OUTLOOK,
          clientSecret: SECRETO_OUTLOOK,
          redirectUri: REDIRECT_URI,
          urlAvisos: () => `${urlCorreo}/notificaciones/outlook`,
        },
        cola: colaExaminador,
        broker: brokerCorreo,
        intervalos: { cicloMs: 60_000, viajeProximoMs: 300_000, normalMs: 3_600_000 },
        cantidadProcesadores: 4,
        concurrenciaLectura: 10,
      });

      // Para los 4 workers en paralelo usamos su propia instancia de cola para no competir por estado.
      negocio = {
        ...negocio,
        ...(await (async () => {
          const { crearProcesadorCorreo } = await import('../src/procesador.ts');
          const procesador = crearProcesadorCorreo({
            pool,
            region: 'region-1',
            gestorTokens: negocio.gestorTokens,
            cola: colaProcesadores,
            broker: brokerCorreo,
            logger,
            cantidadProcesadores: 4,
            concurrenciaLectura: 10,
          });
          return { procesador };
        })()),
      };

      const app = crearApp({
        region: 'region-1',
        puerto: 0,
        logger,
        validador: crearValidador({
          servicio: SERVICIO,
          region: 'region-1',
          logger,
          claves: { 'region-1': { claves: claves.jwks } },
          registrar: () => undefined,
        }),
        negocio,
        manejarSenales: false,
      });
      urlCorreo = `http://127.0.0.1:${await app.iniciar()}`;
      detenerCorreo = () => app.detener();

      outbox = iniciarPublicadorOutbox({
        pool,
        broker: brokerCorreo,
        logger,
        intervaloMs: 50,
        lote: 50,
      });
      await negocio.procesador.iniciar();
    }, 90_000);

    afterAll(async () => {
      outbox?.detener();
      await negocio?.procesador.detener();
      await negocio?.examinador.detener();
      await detenerCorreo?.();
      await mockGmail?.detener();
      await mockOutlook?.detener();
      await colaProcesadores?.cerrar();
      await colaExaminador?.cerrar();
      await brokerViajes?.cerrar();
      await brokerUsuarios?.cerrar();
      await brokerCorreo?.cerrar();
      await pool?.end();
      await postgres?.detener();
      await rabbit?.detener();
    }, 30_000);

    beforeEach(async () => {
      await pool.query(
        'TRUNCATE cuentas_correo, oauth_states, avisos_push_vistos, filtros_remitentes, correos_procesados, no_procesados, eventos_salientes CASCADE',
      );
      reservasPublicadas.length = 0;
    });

    async function conectarBuzon(
      usuarioId: string,
      proveedor: 'gmail' | 'outlook',
      email: string,
    ): Promise<string> {
      mockGmail.almacen.obtener(email);
      mockOutlook.almacen.obtener(email);
      const jwt = await firmarJwt(claves, { sub: usuarioId });
      const inicio = await fetch(`${urlCorreo}/cuentas-correo/${proveedor}/conectar`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const { urlAutorizacion } = (await inicio.json()) as { urlAutorizacion: string };
      const p = new URL(urlAutorizacion).searchParams;
      const rutaDecision =
        proveedor === 'gmail'
          ? `${urlGmail}/o/oauth2/v2/auth/decision`
          : `${urlOutlook}/common/oauth2/v2.0/authorize/decision`;
      const decision = await fetch(rutaDecision, {
        method: 'POST',
        redirect: 'manual',
        body: new URLSearchParams({
          client_id: p.get('client_id') ?? '',
          redirect_uri: p.get('redirect_uri') ?? '',
          scope: p.get('scope') ?? '',
          state: p.get('state') ?? '',
          ...(proveedor === 'gmail' ? { access_type: 'offline' } : {}),
          email,
          decision: 'permitir',
        }),
      });
      const vuelta = new URL(decision.headers.get('location') ?? '');
      const cb = await fetch(`${urlCorreo}/oauth/callback${vuelta.search}`, { redirect: 'manual' });
      return new URL(cb.headers.get('location') ?? '').searchParams.get('cuentaId') ?? '';
    }

    it('procesa un lote de 1.000 correos en paralelo con >= 99 % detectados, aplica whitelist por FiltrosActualizados y no duplica eventos', async () => {
      const usuarioId = randomUUID();
      const email = 'lote.1000@gmail.example';
      const emailNoPermitidoSolo = REMITENTE_NO_PERMITIDO.replace(
        /^.*<([^>]+)>$/,
        '$1',
      ).toLowerCase();

      // 1) Publicamos FiltrosActualizados dos veces con el mismo evento/reemplazo (idempotente).
      const eventoFiltros = await brokerUsuarios.publicarEvento('FiltrosActualizados', {
        usuarioId,
        remitentesPermitidos: [
          '@aerolinea-andina.example',
          '@hotel-cordillera.example',
          '@rentadora-sur.example',
        ],
        filtrosActivos: true,
      });
      await esperarQue(
        async () => (await repositorio.obtenerFiltroRemitentes(pool, usuarioId)) !== null,
      );
      // Re-publicamos el mismo sobre (idéntico eventId): broker lo ignora por eventos_procesados.
      await brokerUsuarios.publicar(eventoFiltros);
      await new Promise((r) => setTimeout(r, 150));

      const filtroGuardado = await repositorio.obtenerFiltroRemitentes(pool, usuarioId);
      expect(filtroGuardado?.filtrosActivos).toBe(true);
      expect(filtroGuardado?.remitentesPermitidos).toHaveLength(3);

      // 2) Generamos 1.000 correos en el buzón de Gmail del mock y conectamos la cuenta.
      const lote = generarLote({
        cantidad: 1000,
        para: email,
        nombre: 'Ana García',
        semilla: 20261118,
      });
      const buzon = mockGmail.almacen.obtener(email);
      for (const item of lote) {
        mockGmail.almacen.agregar(buzon.email, item.correo, item.etiqueta);
      }

      const esperadosViaje = lote.filter(
        (c) => c.etiqueta.tipo !== 'no-viaje' && c.etiqueta.tipo !== 'remitente-no-permitido',
      );
      expect(esperadosViaje.length).toBeGreaterThan(500);

      const cuentaId = await conectarBuzon(usuarioId, 'gmail', email);

      // 3) Examinador encola el buzón y los 4 procesadores en paralelo procesan todo el lote.
      await negocio.examinador.ejecutarCiclo();
      await esperarQue(() => reservasPublicadas.length >= esperadosViaje.length, 150_000);

      // Espera breve para verificar que no aparezcan eventos extra por encima de lo esperado.
      await new Promise((r) => setTimeout(r, 300));

      // Al menos 99 % de los correos de viaje válidos detectados y validados contra schema.
      expect(reservasPublicadas.length / esperadosViaje.length).toBeGreaterThanOrEqual(0.99);
      expect(reservasPublicadas.length).toBe(esperadosViaje.length);

      // Ninguno de viajes-baratos.example (fuera de whitelist) fue procesado ni enviado a no_procesados.
      const enviadosBaratos = reservasPublicadas.filter(
        (e) => e.datos.proveedor === 'viajes-baratos',
      );
      expect(enviadosBaratos).toHaveLength(0);
      const { rows: rowsNoProc } = await pool.query<{ remitente: string }>(
        `SELECT remitente FROM no_procesados WHERE usuario_id = $1`,
        [usuarioId],
      );
      expect(rowsNoProc.filter((r) => r.remitente === emailNoPermitidoSolo)).toHaveLength(0);
      // Ningún correo no-viaje entró a no_procesados.
      expect(rowsNoProc).toHaveLength(0);

      // 4) El mismo correo (o el mismo buzón re-encolado dos veces) publica exactamente un solo evento.
      const antesReencolado = reservasPublicadas.length;
      const correoRepetible = esperadosViaje[0];
      if (!correoRepetible) throw new Error('Se esperaba al menos un correo de viaje');
      mockGmail.almacen.agregar(email, correoRepetible.correo, correoRepetible.etiqueta);
      // Simulamos dos entregas paralelas de procesamiento del buzón completo tras el historyId guardado.
      const cuentaRow = (
        await pool.query<{ ultimo_cursor: string }>(
          `SELECT ultimo_cursor FROM cuentas_correo WHERE id = $1`,
          [cuentaId],
        )
      ).rows[0];
      expect(cuentaRow?.ultimo_cursor).toBeTruthy();

      await Promise.all([
        negocio.procesador.procesarTrabajo({
          trabajoId: randomUUID(),
          cuentaId,
          usuarioId,
          proveedor: 'gmail',
          email,
          origen: 'push',
          prioridad: 1,
          creadoEn: new Date().toISOString(),
        }),
        negocio.procesador.procesarTrabajo({
          trabajoId: randomUUID(),
          cuentaId,
          usuarioId,
          proveedor: 'gmail',
          email,
          origen: 'push',
          prioridad: 1,
          creadoEn: new Date().toISOString(),
        }),
      ]);

      await esperarQue(() => reservasPublicadas.length === antesReencolado + 1);
      await new Promise((r) => setTimeout(r, 250));
      expect(reservasPublicadas.length).toBe(antesReencolado + 1);
    });

    it('registra correos de viaje no interpretables en no_procesados y los expone filtrados por GET /no-procesados sin cuerpo ni fuga entre usuarios', async () => {
      const userA = randomUUID();
      const userB = randomUUID();
      const emailOutlook = 'ana.noprocesados@outlook.example';
      const emailOtro = 'otro@gmail.example';

      const idOutlook = await conectarBuzon(userA, 'outlook', emailOutlook);
      const idOtro = await conectarBuzon(userB, 'gmail', emailOtro);

      const ahora = Date.now();
      // Sin whitelist activa: proveedor desconocido, marcado inválido, estado en espera, sin regla, y uno no-viaje.
      mockOutlook.almacen.agregar(emailOutlook, {
        de: 'Hotel Cordillera <reservas@hotel-cordillera.example>',
        para: emailOutlook,
        asunto: 'Hotel Cordillera - Cambio de fechas',
        texto: 'Tu estadía fue reprogramada.',
        fecha: new Date(ahora - 40_000),
      });
      mockOutlook.almacen.agregar(emailOutlook, {
        de: 'Aerolínea Andina <reservas@aerolinea-andina.example>',
        para: emailOutlook,
        asunto: 'Reserva en espera',
        texto: 'En espera',
        html: `<html><script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FlightReservation',
          reservationNumber: 'WAIT1',
          reservationStatus: 'https://schema.org/ReservationHold',
          reservationFor: {
            flightNumber: '10',
            airline: { iataCode: 'AN' },
            departureAirport: { iataCode: 'EZE' },
            departureTime: '2026-12-10T08:00:00Z',
            arrivalAirport: { iataCode: 'SCL' },
            arrivalTime: '2026-12-10T10:00:00Z',
          },
        })}</script></html>`,
        fecha: new Date(ahora - 30_000),
      });
      mockOutlook.almacen.agregar(emailOutlook, {
        de: 'Viajes Baratos <reservas@viajes-baratos.example>',
        para: emailOutlook,
        asunto: 'Confirmación vuelo',
        texto:
          'Código de reserva: VB111\nVuelo: VB 100\nSalida: EZE 2026-12-10 08:00 (-03:00)\nLlegada: SCL 2026-12-10 10:00 (-03:00)',
        fecha: new Date(ahora - 20_000),
      });
      mockOutlook.almacen.agregar(emailOutlook, {
        de: 'Pablo Ríos <pablo@correo.example>',
        para: emailOutlook,
        asunto: '¿Nos vemos?',
        texto: 'Contenido privado que jamás debe guardarse en no_procesados',
        fecha: new Date(ahora - 10_000),
      });
      // Otro correo en el buzón de userB para verificar aislamiento por usuario.
      mockGmail.almacen.agregar(emailOtro, {
        de: 'reservas@hotel-cordillera.example',
        para: emailOtro,
        asunto: 'Hotel Cordillera - Cambio de fechas',
        texto: 'Cambio sin plantilla',
        fecha: new Date(ahora),
      });

      await negocio.examinador.ejecutarCiclo();
      await esperarQue(async () => {
        const { rows } = await pool.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM no_procesados`,
        );
        return Number(rows[0]?.total ?? 0) === 4;
      });

      const jwtA = await firmarJwt(claves, { sub: userA });
      const resA = await fetch(`${urlCorreo}/no-procesados?cuentaId=${idOutlook}&limite=2`, {
        headers: { authorization: `Bearer ${jwtA}` },
      });
      expect(resA.status).toBe(200);
      const bodyA = (await resA.json()) as {
        total: number;
        noProcesados: {
          id: string;
          cuentaId: string;
          proveedorCorreo: string;
          correoId: string;
          remitente: string;
          asunto?: string;
          motivo: string;
        }[];
      };
      // total = 3 (sin-regla, estado-no-confirmado, proveedor-desconocido); el correo no-viaje NO aparece.
      expect(bodyA.total).toBe(3);
      expect(bodyA.noProcesados).toHaveLength(2);
      expect(bodyA.noProcesados.every((n) => n.cuentaId === idOutlook)).toBe(true);
      expect(bodyA.noProcesados.every((n) => !('cuerpo' in n) && !('detalleHtml' in n))).toBe(true);

      // Verificamos todos los motivos de userA.
      const resTodosA = await fetch(`${urlCorreo}/no-procesados`, {
        headers: { authorization: `Bearer ${jwtA}` },
      });
      const todosA = (await resTodosA.json()) as typeof bodyA;
      expect(todosA.noProcesados.map((n) => n.motivo).sort()).toEqual([
        'estado-no-confirmado',
        'proveedor-desconocido',
        'sin-regla',
      ]);

      // userA consultando el cuentaId de userB recibe lista vacía (no filtra datos ajenos).
      const resAjeno = await fetch(`${urlCorreo}/no-procesados?cuentaId=${idOtro}`, {
        headers: { authorization: `Bearer ${jwtA}` },
      });
      expect(await resAjeno.json()).toEqual({ total: 0, noProcesados: [] });
    });
  },
);
