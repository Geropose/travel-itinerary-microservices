// Pruebas de integración del Examinador y avisos push (P2.B5) contra PostgreSQL 17,
// RabbitMQ 4 (testcontainers), mocks reales de Gmail y Outlook y reloj simulado:
// - Cuenta nueva revisada en el primer minuto (prioridad 1 en correo.buzones-a-revisar).
// - Prioridades de polling: 5 min para usuarios con viaje próximo (Viajes con caché 10 min)
//   vs 60 min para el resto; proveedores con push NO se consultan por intervalo.
// - Avisos push reales (/notificaciones/gmail y /notificaciones/outlook) encolan sin esperar
//   al intervalo, validan secreto / clientState y deduplican messageId repetidos.
// - Respuestas 429 reales del proveedor activan espera exponencial respetada por el Examinador.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  crearPool,
  crearValidador,
  migrar,
  MIGRACIONES_EVENTOS,
  type Pool,
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
import {
  crearMock as crearMockGmail,
  type Mock as MockGmail,
} from '../../../mocks/gmail/src/app.ts';
import {
  crearMock as crearMockOutlook,
  type Mock as MockOutlook,
} from '../../../mocks/outlook/src/app.ts';
import { crearAdaptadorGmail } from '../src/adaptadores/gmail.ts';
import { crearAdaptadorOutlook } from '../src/adaptadores/outlook.ts';
import { crearRegistroAdaptadores } from '../src/adaptadores/registro.ts';
import type { AdaptadorCorreo } from '../src/adaptadores/tipos.ts';
import { crearApp, crearNegocioCorreo, SERVICIO } from '../src/app.ts';
import { crearClienteViajes, crearProveedorTokenServicio } from '../src/clientes.ts';
import { conectarColaBuzones, type ColaBuzones, type TrabajoRevisionBuzon } from '../src/cola.ts';
import { guardarCuentaConectada } from '../src/repositorio.ts';

const hayDocker = await dockerDisponible();
const claves = await generarClaves();

const CLIENT_ID_GMAIL = 'trotamundos-local.apps.googleusercontent.com';
const SECRETO_GMAIL = 'secreto-gmail-examinador';
const CLIENT_ID_OUTLOOK = '11112222-bbbb-3333-cccc-4444dddd5555';
const SECRETO_OUTLOOK = 'secreto-outlook-examinador';
const REDIRECT_URI = 'http://localhost:8000/region-1/api/correo/oauth/callback';
const TOPICO_GMAIL = 'projects/trotamundos/topics/gmail-avisos-region-1';
const SUSCRIPCION_GMAIL = 'projects/trotamundos/subscriptions/gmail-avisos-region-1-push';
const SECRETO_AVISOS_GMAIL = 'secreto-avisos-gmail-super-seguro';
const CLAVE_TOKENS = randomBytes(32).toString('base64');

async function esperarQue(condicion: () => boolean, timeoutMs = 10_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (!condicion()) {
    if (Date.now() > limite) throw new Error('Tiempo agotado esperando mensaje en cola');
    await new Promise((r) => setTimeout(r, 40));
  }
}

function adaptadorSinPush(): AdaptadorCorreo {
  return {
    proveedor: 'imap',
    soportaPush: false,
    urlAutorizacion: (s) => `https://imap.example/auth?state=${s}`,
    canjearCodigo: async () => ({
      credenciales: {
        accessToken: 'imap-a',
        refreshToken: 'imap-r',
        expiraEn: new Date(),
        scope: 'r',
      },
      perfil: { email: 'user@imap.example' },
    }),
    renovarToken: async () => ({ accessToken: 'imap-a2', expiraEn: new Date(), scope: 'r' }),
    listarNuevos: async () => ({ mensajes: [] }),
    leerMensaje: async () => ({
      id: '1',
      remitente: 'x@example.com',
      asunto: 'Reserva',
      recibidoEn: new Date(),
    }),
    suscribirAvisos: async () => null,
  };
}

describe.skipIf(!hayDocker)(
  'Examinador y Avisos Push (PostgreSQL + RabbitMQ + reloj simulado)',
  { timeout: 60_000 },
  () => {
    const bitacora = loggerDePrueba(SERVICIO);
    const { logger, lineas } = bitacora;
    const reloj = { ahora: Date.now() };

    let postgres: ContenedorPostgres;
    let rabbit: ContenedorRabbit;
    let pool: Pool;
    let colaProductor: ColaBuzones;
    let colaConsumidor: ColaBuzones;
    let mockGmail: MockGmail;
    let mockOutlook: MockOutlook;
    let servidorViajes: Server;
    let servidorPuenteGmail: Server;

    let urlCorreo = '';
    let urlGmail = '';
    let urlOutlook = '';
    let negocio: ReturnType<typeof crearNegocioCorreo>;
    let detenerCorreo: (() => Promise<void>) | undefined;

    const usuariosViajeProximo = new Set<string>();
    let consultasViajes = 0;
    const trabajosRecibidos: TrabajoRevisionBuzon[] = [];

    beforeAll(async () => {
      // Puente local para que mockGmail reenvíe los Pub/Sub push al puerto efímero de correo.
      servidorPuenteGmail = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          const r = await fetch(`${urlCorreo}${req.url ?? ''}`, {
            method: req.method ?? 'POST',
            headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
            body: Buffer.concat(chunks),
          });
          res.writeHead(r.status).end();
        });
      });
      const puertoPuente = await new Promise<number>((resolver) => {
        servidorPuenteGmail.listen(0, () => {
          const addr = servidorPuenteGmail.address();
          resolver(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });

      // Mock HTTP de Autenticación (/interna/tokens-servicio) + Viajes (/interna/usuarios-con-viaje-proximo).
      servidorViajes = createServer((req, res) => {
        if (req.url?.startsWith('/interna/tokens-servicio')) {
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ tokenServicio: 'token-servicio-correo', expiraEn: 300 }));
          return;
        }
        if (req.url?.startsWith('/interna/usuarios-con-viaje-proximo')) {
          consultasViajes += 1;
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              dias: 7,
              calculadoEn: new Date(reloj.ahora).toISOString(),
              usuarioIds: [...usuariosViajeProximo],
            }),
          );
          return;
        }
        res.writeHead(404).end();
      });
      const puertoViajes = await new Promise<number>((resolver) => {
        servidorViajes.listen(0, () => {
          const addr = servidorViajes.address();
          resolver(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });
      const urlViajes = `http://127.0.0.1:${puertoViajes}`;

      [postgres, rabbit] = await Promise.all([levantarPostgres(), levantarRabbit()]);
      pool = crearPool({ url: postgres.url });
      pool.on('error', () => undefined);
      await migrar(pool, [
        MIGRACIONES_EVENTOS,
        fileURLToPath(new URL('../migrations/', import.meta.url)),
      ]);

      [colaProductor, colaConsumidor] = await Promise.all([
        conectarColaBuzones({ url: rabbit.url, logger }),
        conectarColaBuzones({ url: rabbit.url, logger }),
      ]);
      await colaConsumidor.consumir({
        prefetch: 10,
        manejar: async (trabajo) => {
          trabajosRecibidos.push(trabajo);
        },
      });

      mockGmail = crearMockGmail({
        puerto: 0,
        logger: loggerDePrueba('mock-gmail').logger,
        clientId: CLIENT_ID_GMAIL,
        clientSecret: SECRETO_GMAIL,
        redirectUris: [REDIRECT_URI],
        cuotaPorMinuto: 110, // Permite watch (100u) pero dispara 429 reales con dos get.full (60u + 60u).
        semillas: true,
        reloj: () => reloj.ahora,
        suscripciones: new Map([
          [
            TOPICO_GMAIL,
            `http://127.0.0.1:${puertoPuente}/notificaciones/gmail?token=${SECRETO_AVISOS_GMAIL}`,
          ],
        ]),
        avisos: { intervaloMs: 0, reintentos: 0 },
      });
      mockOutlook = crearMockOutlook({
        puerto: 0,
        logger: loggerDePrueba('mock-outlook').logger,
        clientId: CLIENT_ID_OUTLOOK,
        clientSecret: SECRETO_OUTLOOK,
        redirectUris: [REDIRECT_URI],
        semillas: true,
        reloj: () => reloj.ahora,
        avisos: { reintentos: 0 },
      });

      const [puertoGmail, puertoOutlook] = await Promise.all([
        mockGmail.iniciar(),
        mockOutlook.iniciar(),
      ]);
      urlGmail = `http://127.0.0.1:${puertoGmail}`;
      urlOutlook = `http://127.0.0.1:${puertoOutlook}`;

      const adaptadores = crearRegistroAdaptadores([
        crearAdaptadorGmail({
          urlApi: urlGmail,
          clientId: CLIENT_ID_GMAIL,
          clientSecret: SECRETO_GMAIL,
          redirectUri: REDIRECT_URI,
          topicoWatch: TOPICO_GMAIL,
          ahora: () => reloj.ahora,
        }),
        crearAdaptadorOutlook({
          urlApi: urlOutlook,
          clientId: CLIENT_ID_OUTLOOK,
          clientSecret: SECRETO_OUTLOOK,
          redirectUri: REDIRECT_URI,
          urlAvisos: () => `${urlCorreo}/notificaciones/outlook`,
          ahora: () => reloj.ahora,
        }),
        adaptadorSinPush(),
      ]);

      const viajes = crearClienteViajes({
        urlViajes,
        obtenerToken: crearProveedorTokenServicio({
          urlAutenticacion: urlViajes,
          servicio: SERVICIO,
          secreto: 'secreto',
          logger,
          ahora: () => reloj.ahora,
        }),
        ttlCacheMs: 10 * 60_000,
        dias: 7,
        logger,
        ahora: () => reloj.ahora,
      });

      negocio = crearNegocioCorreo({
        pool,
        claveTokensBase64: CLAVE_TOKENS,
        urlWeb: 'http://localhost:5173',
        logger,
        ahora: () => reloj.ahora,
        adaptadores,
        cola: colaProductor,
        viajes,
        pushGmail: {
          secreto: SECRETO_AVISOS_GMAIL,
          suscripcion: SUSCRIPCION_GMAIL,
        },
        intervalos: {
          cicloMs: 30_000,
          viajeProximoMs: 5 * 60_000,
          normalMs: 60 * 60_000,
        },
        backoff429: {
          inicialMs: 30_000,
          maxMs: 300_000,
        },
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
          registrar: () => undefined,
        }),
        negocio,
        manejarSenales: false,
      });
      const puertoCorreo = await app.iniciar();
      urlCorreo = `http://127.0.0.1:${puertoCorreo}`;
      detenerCorreo = () => app.detener();
    }, 60_000);

    afterAll(async () => {
      await negocio?.examinador.detener();
      await detenerCorreo?.();
      await mockGmail?.detener();
      await mockOutlook?.detener();
      await colaConsumidor?.cerrar();
      await colaProductor?.cerrar();
      await new Promise<void>((r) => servidorViajes.close(() => r()));
      await new Promise<void>((r) => servidorPuenteGmail.close(() => r()));
      await pool?.end();
      await postgres?.detener();
      await rabbit?.detener();
    }, 30_000);

    beforeEach(async () => {
      await pool.query('TRUNCATE cuentas_correo, oauth_states, avisos_push_vistos CASCADE');
      usuariosViajeProximo.clear();
      trabajosRecibidos.length = 0;
      consultasViajes = 0;
      reloj.ahora = Date.now();
      lineas.length = 0;
    });

    async function conectarCuentaReal(
      usuarioId: string,
      proveedor: 'gmail' | 'outlook',
      email: string,
    ): Promise<string> {
      const jwt = await firmarJwt(claves, { sub: usuarioId });
      const inicio = await fetch(`${urlCorreo}/cuentas-correo/${proveedor}/conectar`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const { urlAutorizacion } = (await inicio.json()) as { urlAutorizacion: string };
      const params = new URL(urlAutorizacion).searchParams;
      const rutaDecision =
        proveedor === 'gmail'
          ? `${urlGmail}/o/oauth2/v2/auth/decision`
          : `${urlOutlook}/common/oauth2/v2.0/authorize/decision`;
      const decision = await fetch(rutaDecision, {
        method: 'POST',
        redirect: 'manual',
        body: new URLSearchParams({
          client_id: params.get('client_id') ?? '',
          redirect_uri: params.get('redirect_uri') ?? '',
          scope: params.get('scope') ?? '',
          state: params.get('state') ?? '',
          ...(proveedor === 'gmail' ? { access_type: 'offline' } : {}),
          email,
          decision: 'permitir',
        }),
      });
      const vuelta = new URL(decision.headers.get('location') ?? '');
      const cb = await fetch(`${urlCorreo}/oauth/callback${vuelta.search}`, {
        redirect: 'manual',
      });
      return new URL(cb.headers.get('location') ?? '').searchParams.get('cuentaId') ?? '';
    }

    it('encola cuenta nueva en el primer minuto, respeta prioridades 5 min vs 60 min (cache 10 min) y omite polling en push', async () => {
      const userProximo = randomUUID();
      const userNormal = randomUUID();
      const userPush = randomUUID();
      usuariosViajeProximo.add(userProximo);

      // Conectamos cuenta Gmail (con push): al activar users.watch el mock dispara un push inicial
      // inmediato con prioridad 1, que ya marca la cuenta como encolada.
      const idGmail = await conectarCuentaReal(
        userPush,
        'gmail',
        mockGmail.almacen.todos()[0]?.email ?? '',
      );
      await esperarQue(() =>
        trabajosRecibidos.some(
          (t) => t.cuentaId === idGmail && t.origen === 'push' && t.prioridad === 1,
        ),
      );

      // Agregamos dos cuentas sin push (IMAP) recién conectadas en t = reloj.ahora.
      const g1 = await guardarCuentaConectada(pool, Buffer.from(CLAVE_TOKENS, 'base64'), {
        usuarioId: userProximo,
        proveedor: 'imap',
        email: 'prox@imap.example',
        credenciales: {
          accessToken: 'a1',
          refreshToken: 'r1',
          expiraEn: new Date(reloj.ahora + 3600_000),
          scope: 'r',
        },
        ahora: new Date(reloj.ahora),
      });
      const g2 = await guardarCuentaConectada(pool, Buffer.from(CLAVE_TOKENS, 'base64'), {
        usuarioId: userNormal,
        proveedor: 'imap',
        email: 'norm@imap.example',
        credenciales: {
          accessToken: 'a2',
          refreshToken: 'r2',
          expiraEn: new Date(reloj.ahora + 3600_000),
          scope: 'r',
        },
        ahora: new Date(reloj.ahora),
      });
      if (g1.resultado !== 'ok' || g2.resultado !== 'ok') throw new Error('Insert imap fallido');

      // Primera pasada a los 15 segundos (< 1 min): las cuentas nuevas sin push se encolan con
      // prioridad 1 ('cuenta-nueva') y Gmail con push activo no se vuelve a encolar por intervalo.
      trabajosRecibidos.length = 0;
      reloj.ahora += 15_000;
      const inicial = await negocio.examinador.ejecutarCiclo();
      expect(inicial).toHaveLength(2);
      expect(inicial.map((t) => [t.cuentaId, t.origen, t.prioridad])).toEqual(
        expect.arrayContaining([
          [g1.cuentaId, 'cuenta-nueva', 1],
          [g2.cuentaId, 'cuenta-nueva', 1],
        ]),
      );
      await esperarQue(() => trabajosRecibidos.length === 2);

      // Avanzamos +5 min: SOLO userProximo (imap) se consulta; userNormal NO, Gmail push NO.
      trabajosRecibidos.length = 0;
      reloj.ahora += 5 * 60_000;
      const ciclo5 = await negocio.examinador.ejecutarCiclo();
      expect(ciclo5.map((t) => [t.cuentaId, t.origen, t.prioridad])).toEqual([
        [g1.cuentaId, 'viaje-proximo', 2],
      ]);
      await esperarQue(() => trabajosRecibidos.length === 1);
      // Cache de Viajes (10 min): todavía solo hubo 1 consulta HTTP a Viajes.
      expect(consultasViajes).toBe(1);

      // Avanzamos +55 min (total 60 min): consultan userProximo (prioridad 2) ANTES que userNormal (prioridad 3). Gmail push sigue en 0 consultas.
      trabajosRecibidos.length = 0;
      reloj.ahora += 55 * 60_000;
      const ciclo60 = await negocio.examinador.ejecutarCiclo();
      expect(ciclo60.map((t) => [t.cuentaId, t.origen, t.prioridad])).toEqual([
        [g1.cuentaId, 'viaje-proximo', 2],
        [g2.cuentaId, 'periodica', 3],
      ]);
      await esperarQue(() => trabajosRecibidos.length === 2);
      expect(consultasViajes).toBe(2);
    });

    it('dispara revisión inmediata por avisos push reales de Gmail (Pub/Sub) y Outlook (Graph) validando secretos', async () => {
      const emailGmail = mockGmail.almacen.todos()[1]?.email ?? '';
      const emailOutlook = mockOutlook.almacen.todos()[0]?.email ?? '';

      const idGmail = await conectarCuentaReal(randomUUID(), 'gmail', emailGmail);
      const idOutlook = await conectarCuentaReal(randomUUID(), 'outlook', emailOutlook);

      // Esperamos el push inicial del watch de Gmail y limpiamos la revisión inicial de Outlook.
      await esperarQue(() =>
        trabajosRecibidos.some((t) => t.cuentaId === idGmail && t.origen === 'push'),
      );
      await negocio.examinador.ejecutarCiclo();
      await esperarQue(() =>
        trabajosRecibidos.some((t) => t.cuentaId === idOutlook && t.origen === 'cuenta-nueva'),
      );
      trabajosRecibidos.length = 0;

      // 1) Entra correo nuevo al buzón Gmail: el mock manda Pub/Sub push y se encola sin esperar intervalo.
      const agregadoGmail = mockGmail.almacen.agregar(emailGmail, {
        de: 'reservas@aerolinea-andina.example',
        para: emailGmail,
        asunto: 'Vuelo push Gmail',
        texto: 'Reserva XYZ123',
        fecha: new Date(reloj.ahora),
      });
      await esperarQue(() =>
        trabajosRecibidos.some(
          (t) =>
            t.cuentaId === idGmail &&
            t.origen === 'push' &&
            t.push?.historyId === agregadoGmail.historyId,
        ),
      );
      const trabajoGmail = trabajosRecibidos.find(
        (t) =>
          t.cuentaId === idGmail &&
          t.origen === 'push' &&
          t.push?.historyId === agregadoGmail.historyId,
      );
      expect(trabajoGmail?.push?.historyId).toBe(agregadoGmail.historyId);

      // Secreto incorrecto o faltante en /notificaciones/gmail -> 401 aviso-no-verificado.
      const cuerpoFake = mockGmail.avisos.cuerpo(emailGmail, 9999, TOPICO_GMAIL);
      const malToken = await fetch(`${urlCorreo}/notificaciones/gmail?token=secreto-falso-123456`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cuerpoFake),
      });
      expect(malToken.status).toBe(401);

      // messageId repetido con secreto correcto -> 202 pero NO duplica en cola.
      const antesRepeticion = trabajosRecibidos.length;
      const bodyDuplicado = mockGmail.avisos.cuerpo(emailGmail, 1001, TOPICO_GMAIL);
      const primerEnvio = await fetch(
        `${urlCorreo}/notificaciones/gmail?token=${SECRETO_AVISOS_GMAIL}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(bodyDuplicado),
        },
      );
      expect(primerEnvio.status).toBe(202);
      await esperarQue(() => trabajosRecibidos.length === antesRepeticion + 1);
      const repetido = await fetch(
        `${urlCorreo}/notificaciones/gmail?token=${SECRETO_AVISOS_GMAIL}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(bodyDuplicado),
        },
      );
      expect(repetido.status).toBe(202);
      await new Promise((r) => setTimeout(r, 150));
      expect(trabajosRecibidos.length).toBe(antesRepeticion + 1);

      // 2) Entra correo nuevo al buzón Outlook: Graph manda change notification con clientState válido.
      const antesOutlook = trabajosRecibidos.length;
      const guardadoOutlook = mockOutlook.almacen.agregar(emailOutlook, {
        de: 'reservas@hotel-cordillera.example',
        para: emailOutlook,
        asunto: 'Hotel push Outlook',
        texto: 'Reserva HTL777',
        fecha: new Date(reloj.ahora),
      });
      await esperarQue(() =>
        trabajosRecibidos
          .slice(antesOutlook)
          .some((t) => t.cuentaId === idOutlook && t.origen === 'push'),
      );
      const trabajoOutlook = trabajosRecibidos.find(
        (t) => t.cuentaId === idOutlook && t.origen === 'push',
      );
      expect(trabajoOutlook?.push?.mensajeIds).toContain(guardadoOutlook.id);

      // clientState incorrecto en Outlook -> responde 202 pero descarta sin encolar.
      const antesDescarte = trabajosRecibidos.length;
      const filaSub = (
        await pool.query<{ suscripcion_id: string }>(
          `SELECT suscripcion_id FROM cuentas_correo WHERE id = $1`,
          [idOutlook],
        )
      ).rows[0];
      const forged = await fetch(`${urlCorreo}/notificaciones/outlook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          value: [
            {
              subscriptionId: filaSub?.suscripcion_id,
              clientState: 'secreto-forjado',
              changeType: 'created',
              resource: 'Users/u/Messages/m1',
              resourceData: { id: 'm1' },
            },
          ],
        }),
      });
      expect(forged.status).toBe(202);
      await new Promise((r) => setTimeout(r, 150));
      expect(trabajosRecibidos.length).toBe(antesDescarte);

      // El secreto de avisos push nunca aparece en los logs.
      const logsJson = lineas.map((l) => JSON.stringify(l)).join('\n');
      expect(logsJson).not.toContain(SECRETO_AVISOS_GMAIL);
    });

    it('respeta errores 429 reales del proveedor aplicando espera exponencial antes de volver a encolar', async () => {
      const emailGmail = mockGmail.almacen.todos()[2]?.email ?? '';
      const idGmail = await conectarCuentaReal(randomUUID(), 'gmail', emailGmail);

      // Esperamos el push inicial del watch de Gmail y limpiamos cualquier revisión inicial pendiente.
      await esperarQue(() =>
        trabajosRecibidos.some((t) => t.cuentaId === idGmail && t.origen === 'push'),
      );
      await negocio.examinador.ejecutarCiclo();
      trabajosRecibidos.length = 0;

      // Reiniciamos ventana de cuota (+65 s): list (5u) + get.full (60u) pasan, 2ª lectura (60u -> 125 > 110) dispara 429 real.
      reloj.ahora += 65_000;
      const lista = await negocio.gestorTokens.listarNuevosCuenta(idGmail, {});
      const msg0 = lista.mensajes[0]?.id ?? '';
      const msg1 = lista.mensajes[1]?.id ?? msg0;
      await negocio.gestorTokens.leerMensajeCuenta(idGmail, msg0);
      await expect(negocio.gestorTokens.leerMensajeCuenta(idGmail, msg1)).rejects.toMatchObject({
        codigo: 'limite-cuota',
      });

      // Verificamos bloqueo 1: 30 s (backoff429.inicialMs).
      const fila1 = (
        await pool.query<{ intentos_429: number; bloqueado_hasta: Date }>(
          `SELECT intentos_429, bloqueado_hasta FROM cuentas_correo WHERE id = $1`,
          [idGmail],
        )
      ).rows[0];
      expect(fila1?.intentos_429).toBe(1);
      expect(fila1?.bloqueado_hasta.getTime()).toBe(reloj.ahora + 30_000);

      // Mientras está bloqueado, un push difiere la revisión en lugar de saturar la cola ahora.
      const resPush = await negocio.examinador.encolarPorPush({
        cuentaId: idGmail,
        usuarioId: randomUUID(),
        proveedor: 'gmail',
        email: emailGmail,
        bloqueadoHasta: fila1?.bloqueado_hasta ?? null,
      });
      expect(resPush.encolado).toBe(false);
      await new Promise((r) => setTimeout(r, 100));
      expect(trabajosRecibidos).toHaveLength(0);

      // A los +29 s sigue bloqueado; el Examinador no la encola.
      reloj.ahora += 29_000;
      expect(await negocio.examinador.ejecutarCiclo()).toHaveLength(0);

      // Segundo 429 duplica el backoff a 60 s (2 * 30 s).
      await negocio.examinador.registrarLimiteCuota(idGmail);
      const fila2 = (
        await pool.query<{ intentos_429: number; bloqueado_hasta: Date }>(
          `SELECT intentos_429, bloqueado_hasta FROM cuentas_correo WHERE id = $1`,
          [idGmail],
        )
      ).rows[0];
      expect(fila2?.intentos_429).toBe(2);
      expect(fila2?.bloqueado_hasta.getTime()).toBe(reloj.ahora + 60_000);

      // Al vencer los 60 s de espera exponencial, el Examinador retoma la revisión pendiente.
      reloj.ahora += 60_000;
      const trasBackoff = await negocio.examinador.ejecutarCiclo();
      expect(trasBackoff.map((t) => [t.cuentaId, t.origen])).toEqual([[idGmail, 'cuenta-nueva']]);
    });
  },
);
