// Pruebas de integración de Correo (P2.B4) contra PostgreSQL 17 real (testcontainers) y los
// mocks reales de Gmail y Outlook:
// - Flujo OAuth completo con state firmado y de un solo uso (/conectar → mock → /oauth/callback).
// - Cifrado AES-256-GCM en Postgres (nunca texto plano) y ausencia total de tokens en los logs.
// - Prioridad máxima al conectar (revisable en el primer minuto, QA-7).
// - Rechazo de scope distinto (tanto en query como devuelto por /token) y cancelación.
// - Renovación automática antes de vencer (incluyendo rotación de refresh_token en Outlook),
//   reintento transparente ante 401 y paso a 'sin-permiso' ante invalid_grant.
// - Adaptadores: listarNuevos, leerMensaje, suscribirAvisos y DELETE /cuentas-correo/{cuentaId}.
import { randomBytes, randomUUID } from 'node:crypto';
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
  generarClaves,
  levantarPostgres,
  loggerDePrueba,
  type ContenedorPostgres,
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
import { crearApp, crearNegocioCorreo, SERVICIO } from '../src/app.ts';
import { buscarCuentasPrioritariasPendientes } from '../src/repositorio.ts';
import { ErrorCuentaSinPermiso } from '../src/tokens.ts';

const hayDocker = await dockerDisponible();
const claves = await generarClaves();

const CLIENT_ID_GMAIL = 'trotamundos-local.apps.googleusercontent.com';
const SECRETO_GMAIL = 'secreto-gmail-prueba';
const CLIENT_ID_OUTLOOK = '11112222-bbbb-3333-cccc-4444dddd5555';
const SECRETO_OUTLOOK = 'secreto-outlook-prueba';
const REDIRECT_URI = 'http://localhost:8000/region-1/api/correo/oauth/callback';
const TOPICO_GMAIL = 'projects/trotamundos/topics/gmail-avisos-region-1';
const URL_WEB = 'http://localhost:5173';
const CLAVE_TOKENS = randomBytes(32).toString('base64');

function exigir<T>(valor: T | null | undefined, msg = 'Valor esperado en prueba'): T {
  if (valor === undefined || valor === null) throw new Error(msg);
  return valor;
}

function cuentaIdDe(resp: Response): string {
  const cuentaId = new URL(resp.headers.get('location') ?? '').searchParams.get('cuentaId');
  return exigir(cuentaId, 'Falta cuentaId en Location');
}

interface FilaBaseToken {
  id: string;
  usuario_id: string;
  proveedor: string;
  email: string;
  estado: string;
  access_token_cifrado: string;
  refresh_token_cifrado: string;
  token_vence_en: Date;
  suscripcion_id: string | null;
  suscripcion_secreto_cifrado: string | null;
  revision_prioritaria: boolean;
  proxima_revision: Date;
}

describe.skipIf(!hayDocker)(
  'Servicio de Correo: OAuth, cifrado AES-256-GCM y adaptadores',
  { timeout: 60_000 },
  () => {
    const bitacora = loggerDePrueba(SERVICIO);
    const { logger, lineas } = bitacora;
    const reloj = { ahora: Date.now() };

    let postgres: ContenedorPostgres;
    let pool: Pool;
    let mockGmail: MockGmail;
    let mockOutlook: MockOutlook;
    let urlGmail = '';
    let urlOutlook = '';
    let urlCorreo = '';
    let avisosGmailRecibidos = 0;
    let receptorGmail: { close: (cb: () => void) => void } | undefined;
    let negocio: ReturnType<typeof crearNegocioCorreo>;
    let detenerCorreo: (() => Promise<void>) | undefined;
    const rechazos: AccesoRechazado[] = [];

    const validador = crearValidador({
      servicio: SERVICIO,
      region: 'region-1',
      logger,
      claves: { 'region-1': { claves: claves.jwks } },
      registrar: (r) => rechazos.push(r),
    });

    beforeAll(async () => {
      const { createServer } = await import('node:http');
      const servidorAvisos = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          avisosGmailRecibidos += 1;
          res.writeHead(200).end();
        });
      });
      const puertoAvisos = await new Promise<number>((resolver) => {
        servidorAvisos.listen(0, () => {
          const addr = servidorAvisos.address();
          resolver(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });
      receptorGmail = servidorAvisos;

      [postgres] = await Promise.all([levantarPostgres()]);
      pool = crearPool({ url: postgres.url });
      await migrar(pool, [
        MIGRACIONES_EVENTOS,
        fileURLToPath(new URL('../migrations/', import.meta.url)),
      ]);

      mockGmail = crearMockGmail({
        puerto: 0,
        logger: loggerDePrueba('mock-gmail').logger,
        clientId: CLIENT_ID_GMAIL,
        clientSecret: SECRETO_GMAIL,
        redirectUris: [REDIRECT_URI],
        semillas: true,
        reloj: () => reloj.ahora,
        suscripciones: new Map([[TOPICO_GMAIL, `http://127.0.0.1:${puertoAvisos}/gmail`]]),
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

      negocio = crearNegocioCorreo({
        pool,
        claveTokensBase64: CLAVE_TOKENS,
        urlWeb: URL_WEB,
        logger,
        margenRenovacionMs: 5 * 60_000,
        ahora: () => reloj.ahora,
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
      });

      const app = crearApp({
        region: 'region-1',
        puerto: 0,
        logger,
        validador,
        negocio,
        manejarSenales: false,
      });
      const puertoCorreo = await app.iniciar();
      urlCorreo = `http://127.0.0.1:${puertoCorreo}`;
      detenerCorreo = () => app.detener();
    }, 60_000);

    afterAll(async () => {
      await detenerCorreo?.();
      await mockGmail?.detener();
      await mockOutlook?.detener();
      await new Promise<void>((resolver) => {
        if (!receptorGmail) return resolver();
        receptorGmail.close(() => resolver());
      });
      await pool?.end();
      await postgres?.detener();
    }, 30_000);

    beforeEach(async () => {
      await pool.query('TRUNCATE cuentas_correo, oauth_states CASCADE');
      reloj.ahora = Date.now();
      lineas.length = 0;
    });

    /** Ejecuta POST /conectar → pantalla mock → GET /oauth/callback y devuelve la URL Location del 302. */
    async function completarFlujoOAuth(
      jwt: string,
      proveedor: 'gmail' | 'outlook',
      email: string,
      opciones: { decision?: 'permitir' | 'cancelar'; scopeForzado?: string } = {},
    ) {
      const inicio = await fetch(`${urlCorreo}/cuentas-correo/${proveedor}/conectar`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(inicio.status).toBe(200);
      const { urlAutorizacion } = (await inicio.json()) as {
        proveedorCorreo: string;
        urlAutorizacion: string;
        stateVenceEn: string;
      };

      const parsedAuth = new URL(urlAutorizacion);
      // Abrir pantalla de permiso del mock (verifica que el pedido OAuth es válido).
      const pantalla = await fetch(parsedAuth);
      expect(pantalla.status).toBe(200);

      const rutaDecision =
        proveedor === 'gmail'
          ? `${urlGmail}/o/oauth2/v2/auth/decision`
          : `${urlOutlook}/common/oauth2/v2.0/authorize/decision`;

      const decision = await fetch(rutaDecision, {
        method: 'POST',
        redirect: 'manual',
        body: new URLSearchParams({
          client_id: parsedAuth.searchParams.get('client_id') ?? '',
          redirect_uri: parsedAuth.searchParams.get('redirect_uri') ?? '',
          scope: opciones.scopeForzado ?? parsedAuth.searchParams.get('scope') ?? '',
          state: parsedAuth.searchParams.get('state') ?? '',
          ...(proveedor === 'gmail'
            ? { access_type: parsedAuth.searchParams.get('access_type') ?? 'offline' }
            : {}),
          email,
          decision: opciones.decision ?? 'permitir',
        }),
      });
      expect(decision.status).toBe(302);
      const vuelta = new URL(decision.headers.get('location') ?? '');

      const callback = await fetch(`${urlCorreo}/oauth/callback${vuelta.search}`, {
        redirect: 'manual',
      });
      return callback;
    }

    it('conecta Gmail vía OAuth, encripta tokens en la DB, activa watch, marca prioridad QA-7 y nunca los loguea', async () => {
      const usuarioId = randomUUID();
      const jwt = await firmarJwt(claves, { sub: usuarioId });
      const emailBuzon = mockGmail.almacen.todos()[0]?.email ?? '';
      expect(emailBuzon).toContain('@gmail.example');

      const callback = await completarFlujoOAuth(jwt, 'gmail', emailBuzon);
      expect(callback.status).toBe(302);
      const destino = new URL(callback.headers.get('location') ?? '');
      expect(destino.origin).toBe(URL_WEB);
      expect(destino.pathname).toBe('/correo');
      expect(destino.searchParams.get('resultado')).toBe('conectada');
      const cuentaId = destino.searchParams.get('cuentaId') ?? '';
      expect(cuentaId).toBeTruthy();

      // GET /cuentas-correo devuelve el resumen sin tokens ni contraseñas.
      const lista = await fetch(`${urlCorreo}/cuentas-correo`, {
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(lista.status).toBe(200);
      const { cuentas } = (await lista.json()) as {
        cuentas: Record<string, unknown>[];
      };
      expect(cuentas).toHaveLength(1);
      expect(cuentas[0]).toMatchObject({
        id: cuentaId,
        proveedorCorreo: 'gmail',
        email: emailBuzon,
        estado: 'conectada',
        ultimaRevision: null,
      });
      expect(Object.keys(cuentas[0] ?? {})).toEqual([
        'id',
        'proveedorCorreo',
        'email',
        'estado',
        'conectadaEn',
        'ultimaRevision',
      ]);

      // Lectura directa de PostgreSQL: los tokens deben estar cifrados (nunca texto plano).
      const { rows } = await pool.query<FilaBaseToken>(
        `SELECT * FROM cuentas_correo WHERE id = $1`,
        [cuentaId],
      );
      const fila = exigir(rows[0]);
      expect(fila.access_token_cifrado).toMatch(/^v1\./);
      expect(fila.refresh_token_cifrado).toMatch(/^v1\./);
      expect(fila.access_token_cifrado).not.toContain('ya29.');
      expect(fila.refresh_token_cifrado).not.toContain('1//');

      // Watch de Gmail activado en el mock y guardado en la DB.
      expect(fila.suscripcion_id).toBe(TOPICO_GMAIL);
      expect(mockGmail.almacen.buscar(emailBuzon)?.watch?.topicName).toBe(TOPICO_GMAIL);
      expect(avisosGmailRecibidos).toBeGreaterThanOrEqual(1);

      // Prioridad máxima QA-7: revisable en el primer minuto.
      expect(fila.revision_prioritaria).toBe(true);
      expect(fila.proxima_revision.getTime()).toBeLessThanOrEqual(reloj.ahora + 60_000);
      const prioritarias = await buscarCuentasPrioritariasPendientes(
        pool,
        new Date(reloj.ahora + 1000),
      );
      expect(prioritarias.map((p) => p.id)).toContain(cuentaId);

      // Ningún log debe contener los tokens OAuth en claro ni la clave AES.
      const resuelto = await negocio.gestorTokens.obtenerTokenValido(cuentaId);
      const logsJson = lineas.map((l) => JSON.stringify(l)).join('\n');
      expect(logsJson).not.toContain(resuelto.accessToken);
      expect(logsJson).not.toContain(CLAVE_TOKENS);
      expect(logsJson).not.toContain('ya29.');
      expect(logsJson).not.toContain('1//');
    });

    it('conecta Outlook (cuenta personal con mail=null), realiza handshake validationToken y permite leer/listar mensajes', async () => {
      const usuarioId = randomUUID();
      const jwt = await firmarJwt(claves, { sub: usuarioId });
      const personal = exigir(mockOutlook.almacen.todos().find((b) => b.personal));

      const callback = await completarFlujoOAuth(jwt, 'outlook', personal.email);
      expect(callback.status).toBe(302);
      const destino = new URL(callback.headers.get('location') ?? '');
      expect(destino.searchParams.get('resultado')).toBe('conectada');
      const cuentaId = destino.searchParams.get('cuentaId') ?? '';

      // Verifica que Graph creó la suscripción tras validar /notificaciones/outlook?validationToken=...
      expect(mockOutlook.suscripciones.vigentes(personal.email)).toBe(1);
      const { rows } = await pool.query<FilaBaseToken>(
        `SELECT * FROM cuentas_correo WHERE id = $1`,
        [cuentaId],
      );
      const fila = exigir(rows[0]);
      expect(fila.email).toBe(personal.email);
      expect(fila.suscripcion_id).toBeTruthy();
      expect(fila.suscripcion_secreto_cifrado).toMatch(/^v1\./);
      expect(fila.access_token_cifrado).not.toContain('eyJ0eXAi');
      expect(fila.refresh_token_cifrado).not.toContain('AwABAAAA');

      // Prueba los métodos listarNuevos y leerMensaje del adaptador contra el mock de Outlook.
      const lista = await negocio.gestorTokens.listarNuevosCuenta(cuentaId, {});
      expect(lista.mensajes.length).toBeGreaterThan(0);
      const primero = await negocio.gestorTokens.leerMensajeCuenta(
        cuentaId,
        exigir(lista.mensajes[0]).id,
      );
      expect(primero.remitente).toContain('@');
      expect(primero.asunto.length).toBeGreaterThan(0);
      expect(primero.cuerpoHtml).toBeTruthy();
    });

    it('renueva tokens vencidos o próximos a vencer (con rotación en Outlook), reintenta ante 401 y pasa a sin-permiso tras revocación', async () => {
      const jwt = await firmarJwt(claves, { sub: randomUUID() });
      const emailGmail = exigir(mockGmail.almacen.todos()[1]).email;
      const emailOutlook = exigir(mockOutlook.almacen.todos()[0]).email;

      const cbGmail = await completarFlujoOAuth(jwt, 'gmail', emailGmail);
      const idGmail = cuentaIdDe(cbGmail);
      const cbOutlook = await completarFlujoOAuth(jwt, 'outlook', emailOutlook);
      const idOutlook = cuentaIdDe(cbOutlook);

      const antesGmail = exigir(
        (await pool.query<FilaBaseToken>(`SELECT * FROM cuentas_correo WHERE id = $1`, [idGmail]))
          .rows[0],
      );
      const antesOutlook = exigir(
        (await pool.query<FilaBaseToken>(`SELECT * FROM cuentas_correo WHERE id = $1`, [idOutlook]))
          .rows[0],
      );

      // 1) Adelantamos el reloj a 3 min antes de vencer (< margen de 5 min): renovación proactiva.
      reloj.ahora += 57 * 60_000;

      // Concurrencia en Outlook: dos llamadas simultáneas no deben invalidar el refresh token rotado.
      const [msgsOutlookA, msgsOutlookB, msgsGmail] = await Promise.all([
        negocio.gestorTokens.listarNuevosCuenta(idOutlook, {}),
        negocio.gestorTokens.listarNuevosCuenta(idOutlook, {}),
        negocio.gestorTokens.listarNuevosCuenta(idGmail, {}),
      ]);
      expect(msgsOutlookA.mensajes.length).toBeGreaterThan(0);
      expect(msgsOutlookB.mensajes.length).toBe(msgsOutlookA.mensajes.length);
      expect(msgsGmail.mensajes.length).toBeGreaterThan(0);

      const despuesGmail = exigir(
        (await pool.query<FilaBaseToken>(`SELECT * FROM cuentas_correo WHERE id = $1`, [idGmail]))
          .rows[0],
      );
      const despuesOutlook = exigir(
        (await pool.query<FilaBaseToken>(`SELECT * FROM cuentas_correo WHERE id = $1`, [idOutlook]))
          .rows[0],
      );
      expect(despuesGmail.access_token_cifrado).not.toBe(antesGmail.access_token_cifrado);
      expect(despuesGmail.token_vence_en.getTime()).toBeGreaterThan(reloj.ahora + 50 * 60_000);
      expect(despuesOutlook.access_token_cifrado).not.toBe(antesOutlook.access_token_cifrado);
      // Outlook rota el refresh token en cada renovación: el cifrado guardado debe haber cambiado.
      expect(despuesOutlook.refresh_token_cifrado).not.toBe(antesOutlook.refresh_token_cifrado);

      // También lee un correo completo de Gmail decodificando MIME base64url.
      const detalleGmail = await negocio.gestorTokens.leerMensajeCuenta(
        idGmail,
        exigir(msgsGmail.mensajes[0]).id,
      );
      expect(detalleGmail.remitente).toContain('@');
      expect(detalleGmail.cuerpoTexto || detalleGmail.cuerpoHtml).toBeTruthy();

      // 2) Expiración anticipada en el mock (401): debe renovar automáticamente y reintentar 1 vez.
      mockGmail.oauth.vencerTokens(emailGmail);
      mockOutlook.oauth.vencerTokens(emailOutlook);
      const listaTras401 = await negocio.gestorTokens.listarNuevosCuenta(idGmail, {});
      expect(listaTras401.mensajes.length).toBeGreaterThan(0);
      const listaOutlookTras401 = await negocio.gestorTokens.listarNuevosCuenta(idOutlook, {});
      expect(listaOutlookTras401.mensajes.length).toBeGreaterThan(0);

      // 3) Revocación total (invalid_grant): marca la cuenta como sin-permiso en la base.
      mockGmail.oauth.revocar(emailGmail);
      await expect(negocio.gestorTokens.listarNuevosCuenta(idGmail, {})).rejects.toBeInstanceOf(
        ErrorCuentaSinPermiso,
      );

      const cuentaSinPermiso = await fetch(`${urlCorreo}/cuentas-correo`, {
        headers: { authorization: `Bearer ${jwt}` },
      });
      const cuerpoLista = (await cuentaSinPermiso.json()) as {
        cuentas: { id: string; estado: string }[];
      };
      expect(cuerpoLista.cuentas.find((c) => c.id === idGmail)?.estado).toBe('sin-permiso');

      // Reconectar la cuenta vuelve a habilitarla como 'conectada'.
      const reconexion = await completarFlujoOAuth(jwt, 'gmail', emailGmail);
      expect(new URL(reconexion.headers.get('location') ?? '').searchParams.get('resultado')).toBe(
        'conectada',
      );
      const listaFinal = (await (
        await fetch(`${urlCorreo}/cuentas-correo`, {
          headers: { authorization: `Bearer ${jwt}` },
        })
      ).json()) as { cuentas: { id: string; estado: string }[] };
      expect(listaFinal.cuentas.find((c) => c.id === idGmail)?.estado).toBe('conectada');
    });

    it('rechaza scopes distintos al solo-lectura sin guardar tokens en la base', async () => {
      const jwt = await firmarJwt(claves, { sub: randomUUID() });
      const emailGmail = exigir(mockGmail.almacen.todos()[2]).email;
      const emailOutlook = exigir(mockOutlook.almacen.todos()[1]).email;

      // Gmail con scope de escritura (gmail.modify además de gmail.readonly).
      const cbGmail = await completarFlujoOAuth(jwt, 'gmail', emailGmail, {
        scopeForzado:
          'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify',
      });
      expect(cbGmail.status).toBe(302);
      expect(new URL(cbGmail.headers.get('location') ?? '').searchParams.get('motivo')).toBe(
        'scope-insuficiente',
      );

      // Outlook con permiso de escritura Mail.ReadWrite (obtiene code real del mock y falla al validar token scope).
      const cbOutlook = await completarFlujoOAuth(jwt, 'outlook', emailOutlook, {
        scopeForzado:
          'offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read',
      });
      expect(cbOutlook.status).toBe(302);
      expect(new URL(cbOutlook.headers.get('location') ?? '').searchParams.get('motivo')).toBe(
        'scope-insuficiente',
      );

      const { rows } = await pool.query(`SELECT id FROM cuentas_correo`);
      expect(rows).toHaveLength(0);
    });

    it('maneja state inválido/reusado/vencido, cancelación, conflicto de dueño y desconexión (DELETE)', async () => {
      const userA = randomUUID();
      const userB = randomUUID();
      const jwtA = await firmarJwt(claves, { sub: userA });
      const jwtB = await firmarJwt(claves, { sub: userB });
      const emailOutlook = exigir(mockOutlook.almacen.todos()[2]).email;

      // State falsificado -> 400 problem+json state-invalido.
      const stateFalso = await fetch(`${urlCorreo}/oauth/callback?state=falso&code=123`);
      expect(stateFalso.status).toBe(400);
      expect(stateFalso.headers.get('content-type')).toContain('application/problem+json');
      const prob = (await stateFalso.json()) as { type: string };
      expect(prob.type).toContain('state-invalido');

      // Reuso del mismo state después de completar OAuth -> 400 state-invalido.
      const inicio = await fetch(`${urlCorreo}/cuentas-correo/outlook/conectar`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwtA}` },
      });
      const { urlAutorizacion } = (await inicio.json()) as { urlAutorizacion: string };
      const authParams = new URL(urlAutorizacion).searchParams;
      const decision = await fetch(`${urlOutlook}/common/oauth2/v2.0/authorize/decision`, {
        method: 'POST',
        redirect: 'manual',
        body: new URLSearchParams({
          client_id: authParams.get('client_id') ?? '',
          redirect_uri: authParams.get('redirect_uri') ?? '',
          scope: authParams.get('scope') ?? '',
          state: authParams.get('state') ?? '',
          email: emailOutlook,
          decision: 'permitir',
        }),
      });
      const qs = new URL(decision.headers.get('location') ?? '').search;
      const primeraVez = await fetch(`${urlCorreo}/oauth/callback${qs}`, { redirect: 'manual' });
      expect(primeraVez.status).toBe(302);
      const cuentaId = cuentaIdDe(primeraVez);
      const segundaVez = await fetch(`${urlCorreo}/oauth/callback${qs}`, { redirect: 'manual' });
      expect(segundaVez.status).toBe(400);

      // Cancelación por parte del usuario -> motivo=permiso-denegado.
      const cancelada = await completarFlujoOAuth(jwtA, 'outlook', emailOutlook, {
        decision: 'cancelar',
      });
      expect(new URL(cancelada.headers.get('location') ?? '').searchParams.get('motivo')).toBe(
        'permiso-denegado',
      );

      // Otro usuario intentando conectar el mismo buzón -> motivo=cuenta-de-otro-usuario.
      const conflicto = await completarFlujoOAuth(jwtB, 'outlook', emailOutlook);
      expect(new URL(conflicto.headers.get('location') ?? '').searchParams.get('motivo')).toBe(
        'cuenta-de-otro-usuario',
      );

      // Otro usuario no puede borrar la cuenta ni distinguir su existencia (404).
      const borrarAjeno = await fetch(`${urlCorreo}/cuentas-correo/${cuentaId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${jwtB}` },
      });
      expect(borrarAjeno.status).toBe(404);

      // El dueño desconecta su cuenta -> 204, borra suscripción Outlook y limpia la DB.
      expect(mockOutlook.suscripciones.vigentes(emailOutlook)).toBe(1);
      const borrarPropio = await fetch(`${urlCorreo}/cuentas-correo/${cuentaId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${jwtA}` },
      });
      expect(borrarPropio.status).toBe(204);
      expect(mockOutlook.suscripciones.vigentes(emailOutlook)).toBe(0);
      expect((await pool.query(`SELECT id FROM cuentas_correo`)).rows).toHaveLength(0);

      // State vencido (>10 min) -> 400 state-invalido.
      const inicioVencido = await fetch(`${urlCorreo}/cuentas-correo/gmail/conectar`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwtA}` },
      });
      const urlVencida = new URL(
        ((await inicioVencido.json()) as { urlAutorizacion: string }).urlAutorizacion,
      );
      reloj.ahora += 11 * 60_000;
      const respVencido = await fetch(
        `${urlCorreo}/oauth/callback?state=${encodeURIComponent(urlVencida.searchParams.get('state') ?? '')}&code=x`,
      );
      expect(respVencido.status).toBe(400);
    });

    it('soporta sincronización incremental por cursor (historyId y receivedDateTime) y fallback 404 en Gmail', async () => {
      const jwt = await firmarJwt(claves, { sub: randomUUID() });
      const emailGmail = exigir(mockGmail.almacen.todos()[3]).email;
      const emailOutlook = exigir(mockOutlook.almacen.todos()[3]).email;

      const cbGmail = await completarFlujoOAuth(jwt, 'gmail', emailGmail);
      const idGmail = cuentaIdDe(cbGmail);
      const cbOutlook = await completarFlujoOAuth(jwt, 'outlook', emailOutlook);
      const idOutlook = cuentaIdDe(cbOutlook);

      // Primera sincronización de Gmail obtiene cursor inicial; al agregar un correo, history.list devuelve solo el nuevo.
      const inicialGmail = await negocio.gestorTokens.listarNuevosCuenta(idGmail, {});
      expect(inicialGmail.nuevoCursor).toBeTruthy();

      reloj.ahora += 10_000;
      const agregadoGmail = mockGmail.almacen.agregar(emailGmail, {
        de: 'reservas@aerolinea.example',
        para: emailGmail,
        asunto: 'Vuelo incremental',
        texto: 'Confirmación ABC123',
        fecha: new Date(reloj.ahora),
      });

      const deltaGmail = await negocio.gestorTokens.listarNuevosCuenta(idGmail, {
        cursor: inicialGmail.nuevoCursor,
      });
      expect(deltaGmail.mensajes.map((m) => m.id)).toEqual([agregadoGmail.id]);

      // Cursor más viejo que historyIdInicial (404) hace fallback a sincronización completa.
      const fallbackGmail = await negocio.gestorTokens.listarNuevosCuenta(idGmail, {
        cursor: '1',
      });
      expect(fallbackGmail.cursorExpirado).toBe(true);
      expect(fallbackGmail.mensajes.some((m) => m.id === agregadoGmail.id)).toBe(true);

      // Outlook incremental por cursor receivedDateTime tras agregar nuevo mensaje.
      const inicialOutlook = await negocio.gestorTokens.listarNuevosCuenta(idOutlook, {});
      expect(inicialOutlook.nuevoCursor).toBeTruthy();
      reloj.ahora += 10_000;
      const agregadoOutlook = mockOutlook.almacen.agregar(emailOutlook, {
        de: 'reservas@hotel.example',
        para: emailOutlook,
        asunto: 'Hotel incremental',
        texto: 'Reserva HTL999',
        fecha: new Date(reloj.ahora),
      });
      const deltaOutlook = await negocio.gestorTokens.listarNuevosCuenta(idOutlook, {
        cursor: new Date(reloj.ahora - 1000).toISOString(),
      });
      expect(deltaOutlook.mensajes.map((m) => m.id)).toContain(agregadoOutlook.id);
    });
  },
);
