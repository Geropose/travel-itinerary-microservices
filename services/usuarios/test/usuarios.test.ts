// Pruebas de integración de Usuarios contra PostgreSQL 17 y RabbitMQ 4 reales (testcontainers):
// - Cuentas y preferencias: creación interna desde Autenticación, perfil, validación de agencia.
// - Filtros y whitelist: guardar en la misma transacción que el evento FiltrosActualizados (outbox)
//   y verificar que llega por RabbitMQ validado contra specs/schemas/FiltrosActualizados.json.
// - Permisos de itinerarios: designar y quitar designados, vinculación tardía cuando el designado
//   se registra después, consulta interna rápida por índice y rechazo 403 para otros usuarios.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  conectarBroker,
  crearPool,
  crearValidador,
  errores,
  iniciarPublicadorOutbox,
  migrar,
  MIGRACIONES_EVENTOS,
  type AccesoRechazado,
  type Broker,
  type Pool,
  type PublicadorOutbox,
} from '@trotamundos/comun';
import {
  dockerDisponible,
  firmarJwt,
  firmarTokenServicio,
  generarClaves,
  levantarPostgres,
  levantarRabbit,
  loggerDePrueba,
  type ContenedorPostgres,
  type ContenedorRabbit,
} from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearApp, reglasDeRutas, SERVICIO } from '../src/app.ts';

const hayDocker = await dockerDisponible();
const claves = await generarClaves();

/** Espera hasta que una condición sea verdadera (máximo 10 s). */
async function esperarQue(condicion: () => boolean, tiempoMs = 10_000): Promise<void> {
  const limite = Date.now() + tiempoMs;
  while (!condicion()) {
    if (Date.now() > limite) throw new Error('No se recibió el evento esperado a tiempo');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!hayDocker)(
  'Servicio de Usuarios (PostgreSQL + RabbitMQ)',
  { timeout: 60_000 },
  () => {
    const { logger } = loggerDePrueba(SERVICIO);
    let postgres: ContenedorPostgres;
    let rabbit: ContenedorRabbit;
    let pool: Pool;
    let brokerUsuarios: Broker;
    let brokerCorreo: Broker;
    let outbox: PublicadorOutbox;
    let url: string;
    let detener: (() => Promise<void>) | undefined;

    const rechazos: AccesoRechazado[] = [];
    const filtrosRecibidos: {
      eventId: string;
      datos: { usuarioId: string; remitentesPermitidos: string[]; filtrosActivos: boolean };
    }[] = [];

    // Estado simulado de Viajes: viajeId -> usuarioId dueño (o 'caido' para probar 503).
    const duenosDeViajes = new Map<string, string>();
    let viajesCaido = false;

    const validador = crearValidador({
      servicio: SERVICIO,
      region: 'region-1',
      logger,
      claves: { 'region-1': { claves: claves.jwks } },
      registrar: (r) => rechazos.push(r),
      reglas: reglasDeRutas(),
    });

    beforeAll(async () => {
      [postgres, rabbit] = await Promise.all([levantarPostgres(), levantarRabbit()]);
      pool = crearPool({ url: postgres.url });
      await migrar(pool, [
        MIGRACIONES_EVENTOS,
        fileURLToPath(new URL('../migrations/', import.meta.url)),
      ]);

      [brokerUsuarios, brokerCorreo] = await Promise.all([
        conectarBroker({ url: rabbit.url, servicio: SERVICIO, region: 'region-1', logger }),
        conectarBroker({ url: rabbit.url, servicio: 'correo', region: 'region-1', logger }),
      ]);
      await brokerCorreo.consumir<{
        usuarioId: string;
        remitentesPermitidos: string[];
        filtrosActivos: boolean;
      }>({
        tipo: 'FiltrosActualizados',
        pool,
        manejar: async (evento) => {
          filtrosRecibidos.push({ eventId: evento.eventId, datos: evento.datos });
        },
      });
      outbox = iniciarPublicadorOutbox({ pool, broker: brokerUsuarios, logger, intervaloMs: 100 });

      const servidor = crearApp({
        region: 'region-1',
        puerto: 0,
        logger,
        manejarSenales: false,
        validador,
        negocio: {
          pool,
          agencias: new Set(['viajes-del-plata', 'agencia-sur']),
          registrar: (r) => rechazos.push(r),
          viajes: {
            async esDueno(viajeId, token) {
              if (viajesCaido) throw errores.noDisponible('Viajes no responde.');
              const dueno = duenosDeViajes.get(viajeId);
              if (!dueno) throw errores.noEncontrado('El viaje no existe.');
              const auth = await validador.verificarToken(token);
              return auth.sub === dueno;
            },
          },
        },
      });
      await validador.iniciar();
      url = `http://127.0.0.1:${await servidor.iniciar()}`;
      detener = () => servidor.detener();
    }, 180_000);

    afterAll(async () => {
      await outbox?.detener();
      await detener?.();
      await Promise.all([brokerUsuarios?.cerrar(), brokerCorreo?.cerrar()]);
      await pool?.end();
      await Promise.all([postgres?.detener(), rabbit?.detener()]);
    }, 60_000);

    beforeEach(async () => {
      viajesCaido = false;
      duenosDeViajes.clear();
      rechazos.length = 0;
      filtrosRecibidos.length = 0;
      await pool.query(
        'TRUNCATE designados_itinerario, whitelists, cuentas, eventos_salientes, eventos_procesados RESTART IDENTITY CASCADE',
      );
    });

    async function crearCuentaViaEndpoint(datos: {
      usuarioId?: string;
      email: string;
      nombre: string;
      idioma?: string;
      region?: 'region-1' | 'region-2';
    }) {
      const usuarioId = datos.usuarioId ?? randomUUID();
      const tokenServicio = await firmarTokenServicio(claves, 'autenticacion', 'region-1');
      const respuesta = await fetch(`${url}/interna/cuentas`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenServicio}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          usuarioId,
          email: datos.email,
          nombre: datos.nombre,
          region: datos.region ?? 'region-1',
          idioma: datos.idioma ?? 'es',
        }),
      });
      return { usuarioId, respuesta };
    }

    describe('cuentas y preferencias', () => {
      it('crea cuenta interna, consulta y actualiza perfil validando agencias', async () => {
        const { usuarioId, respuesta: creacion } = await crearCuentaViaEndpoint({
          email: 'Ana@Correo.Example',
          nombre: 'Ana Pérez',
        });
        expect(creacion.status).toBe(201);
        expect(await creacion.json()).toMatchObject({
          usuarioId,
          email: 'ana@correo.example',
          nombre: 'Ana Pérez',
          region: 'region-1',
          idioma: 'es',
          moneda: 'USD',
          agenciaPreferida: null,
        });

        const jwt = await firmarJwt(claves, { sub: usuarioId });
        const perfil = await fetch(`${url}/perfil`, {
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(perfil.status).toBe(200);
        expect(await perfil.json()).toMatchObject({ usuarioId, moneda: 'USD' });

        // Agencia no configurada -> 400.
        const agenciaInvalida = await fetch(`${url}/perfil`, {
          method: 'PATCH',
          headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
          body: JSON.stringify({ agenciaPreferida: 'agencia-inexistente' }),
        });
        expect(agenciaInvalida.status).toBe(400);

        // Actualización válida con agencia configurada.
        const actualizado = await fetch(`${url}/perfil`, {
          method: 'PATCH',
          headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            idioma: 'en',
            moneda: 'ARS',
            agenciaPreferida: 'viajes-del-plata',
          }),
        });
        expect(actualizado.status).toBe(200);
        expect(await actualizado.json()).toMatchObject({
          idioma: 'en',
          moneda: 'ARS',
          agenciaPreferida: 'viajes-del-plata',
        });

        // Ruta interna de agencia: propio usuario 200, otro usuario 403.
        const agenciaPropia = await fetch(`${url}/interna/usuarios/${usuarioId}/agencia`, {
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(agenciaPropia.status).toBe(200);
        expect(await agenciaPropia.json()).toEqual({
          usuarioId,
          agenciaPreferida: 'viajes-del-plata',
        });

        const otroJwt = await firmarJwt(claves, { sub: randomUUID() });
        const agenciaAjena = await fetch(`${url}/interna/usuarios/${usuarioId}/agencia`, {
          headers: { authorization: `Bearer ${otroJwt}` },
        });
        expect(agenciaAjena.status).toBe(403);

        // Quitar agencia con null.
        const sinAgencia = await fetch(`${url}/perfil`, {
          method: 'PATCH',
          headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
          body: JSON.stringify({ agenciaPreferida: null }),
        });
        expect(sinAgencia.status).toBe(200);
        expect((await sinAgencia.json()) as { agenciaPreferida: unknown }).toMatchObject({
          agenciaPreferida: null,
        });
      });

      it('rechaza región incorrecta (400) y cuenta duplicada (409) en POST /interna/cuentas', async () => {
        const otraRegion = await crearCuentaViaEndpoint({
          email: 'otro@correo.example',
          nombre: 'Otro',
          region: 'region-2',
        });
        expect(otraRegion.respuesta.status).toBe(400);

        const primera = await crearCuentaViaEndpoint({
          email: 'ana@correo.example',
          nombre: 'Ana',
        });
        expect(primera.respuesta.status).toBe(201);

        const duplicada = await crearCuentaViaEndpoint({
          email: 'ANA@correo.example',
          nombre: 'Ana 2',
        });
        expect(duplicada.respuesta.status).toBe(409);
      });
    });

    describe('filtros y whitelist', () => {
      it('devuelve lista vacía al inicio y publica FiltrosActualizados por outbox al guardar', async () => {
        const { usuarioId } = await crearCuentaViaEndpoint({
          email: 'viajera@correo.example',
          nombre: 'Viajera',
        });
        const jwt = await firmarJwt(claves, { sub: usuarioId });

        const inicial = await fetch(`${url}/whitelist`, {
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(inicial.status).toBe(200);
        expect(await inicial.json()).toEqual({
          usuarioId,
          remitentesPermitidos: [],
          filtrosActivos: false,
          actualizadoEn: null,
        });

        const guardada = await fetch(`${url}/whitelist`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            remitentesPermitidos: ['Reservas@Aerolinea.Example', '@Hotel-Cordillera.Example'],
            filtrosActivos: true,
          }),
        });
        expect(guardada.status).toBe(200);
        const cuerpo = (await guardada.json()) as {
          remitentesPermitidos: string[];
          filtrosActivos: boolean;
          actualizadoEn: string | null;
        };
        expect(cuerpo.remitentesPermitidos).toEqual([
          'reservas@aerolinea.example',
          '@hotel-cordillera.example',
        ]);
        expect(cuerpo.filtrosActivos).toBe(true);
        expect(cuerpo.actualizadoEn).not.toBeNull();

        await esperarQue(() => filtrosRecibidos.length === 1);
        expect(filtrosRecibidos[0]?.datos).toEqual({
          usuarioId,
          remitentesPermitidos: ['reservas@aerolinea.example', '@hotel-cordillera.example'],
          filtrosActivos: true,
        });
      });
    });

    describe('permisos de itinerarios', () => {
      it('permite designar, consultar permiso, vincular usuario futuro y quitar designado', async () => {
        const { usuarioId: duenoId } = await crearCuentaViaEndpoint({
          email: 'dueno@correo.example',
          nombre: 'Dueño',
        });
        const { usuarioId: juanId } = await crearCuentaViaEndpoint({
          email: 'juan@correo.example',
          nombre: 'Juan',
        });
        const { usuarioId: intrusoId } = await crearCuentaViaEndpoint({
          email: 'intruso@correo.example',
          nombre: 'Intruso',
        });

        const viajeId = randomUUID();
        duenosDeViajes.set(viajeId, duenoId);

        const jwtDueno = await firmarJwt(claves, { sub: duenoId });
        const jwtJuan = await firmarJwt(claves, { sub: juanId });
        const jwtIntruso = await firmarJwt(claves, { sub: intrusoId });

        // No se puede designar al propio dueño (400).
        const autoDesignar = await fetch(`${url}/itinerarios/${viajeId}/designados`, {
          method: 'POST',
          headers: { authorization: `Bearer ${jwtDueno}`, 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'dueno@correo.example' }),
        });
        expect(autoDesignar.status).toBe(400);

        // Designar a Juan (ya registrado).
        const designarJuan = await fetch(`${url}/itinerarios/${viajeId}/designados`, {
          method: 'POST',
          headers: { authorization: `Bearer ${jwtDueno}`, 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'Juan@Correo.Example' }),
        });
        expect(designarJuan.status).toBe(201);
        expect(await designarJuan.json()).toMatchObject({
          email: 'juan@correo.example',
          usuarioId: juanId,
        });

        // Duplicado -> 409.
        const duplicado = await fetch(`${url}/itinerarios/${viajeId}/designados`, {
          method: 'POST',
          headers: { authorization: `Bearer ${jwtDueno}`, 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'juan@correo.example' }),
        });
        expect(duplicado.status).toBe(409);

        // Designar a María (aún sin cuenta -> usuarioId null).
        const designarMaria = await fetch(`${url}/itinerarios/${viajeId}/designados`, {
          method: 'POST',
          headers: { authorization: `Bearer ${jwtDueno}`, 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'maria@correo.example' }),
        });
        expect(designarMaria.status).toBe(201);
        expect(await designarMaria.json()).toMatchObject({
          email: 'maria@correo.example',
          usuarioId: null,
        });

        // Al registrarse María después, queda vinculada automáticamente.
        const { usuarioId: mariaId } = await crearCuentaViaEndpoint({
          email: 'maria@correo.example',
          nombre: 'María',
        });
        const jwtMaria = await firmarJwt(claves, { sub: mariaId });

        // Consulta de lista de designados (solo dueño).
        const lista = await fetch(`${url}/itinerarios/${viajeId}/designados`, {
          headers: { authorization: `Bearer ${jwtDueno}` },
        });
        expect(lista.status).toBe(200);
        expect(await lista.json()).toMatchObject({
          viajeId,
          designados: [
            { email: 'juan@correo.example', usuarioId: juanId },
            { email: 'maria@correo.example', usuarioId: mariaId },
          ],
        });

        // Consulta interna de permisos: Juan y María pueden ver, Intruso no.
        const permJuan = await fetch(
          `${url}/interna/permisos/itinerarios/${viajeId}?usuarioId=${juanId}`,
          { headers: { authorization: `Bearer ${jwtJuan}` } },
        );
        expect(permJuan.status).toBe(200);
        expect(await permJuan.json()).toEqual({
          viajeId,
          usuarioId: juanId,
          puedeVer: true,
          motivo: 'designado',
        });

        const permMaria = await fetch(
          `${url}/interna/permisos/itinerarios/${viajeId}?usuarioId=${mariaId}`,
          { headers: { authorization: `Bearer ${jwtMaria}` } },
        );
        expect(permMaria.status).toBe(200);
        expect(await permMaria.json()).toMatchObject({ puedeVer: true, motivo: 'designado' });

        const permIntruso = await fetch(
          `${url}/interna/permisos/itinerarios/${viajeId}?usuarioId=${intrusoId}`,
          { headers: { authorization: `Bearer ${jwtIntruso}` } },
        );
        expect(permIntruso.status).toBe(200);
        expect(await permIntruso.json()).toEqual({
          viajeId,
          usuarioId: intrusoId,
          puedeVer: false,
          motivo: 'ninguno',
        });

        // Consulta interna pidiendo permiso de otro usuarioId -> 403 y registrado.
        const permAjeno = await fetch(
          `${url}/interna/permisos/itinerarios/${viajeId}?usuarioId=${juanId}`,
          { headers: { authorization: `Bearer ${jwtIntruso}` } },
        );
        expect(permAjeno.status).toBe(403);

        // Otro usuario intentando listar, agregar o quitar designados -> 403 y registrado.
        const antes = rechazos.length;
        const getIntruso = await fetch(`${url}/itinerarios/${viajeId}/designados`, {
          headers: { authorization: `Bearer ${jwtIntruso}` },
        });
        const postIntruso = await fetch(`${url}/itinerarios/${viajeId}/designados`, {
          method: 'POST',
          headers: { authorization: `Bearer ${jwtIntruso}`, 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'alguien@correo.example' }),
        });
        const delIntruso = await fetch(
          `${url}/itinerarios/${viajeId}/designados/juan%40correo.example`,
          { method: 'DELETE', headers: { authorization: `Bearer ${jwtIntruso}` } },
        );
        expect(getIntruso.status).toBe(403);
        expect(postIntruso.status).toBe(403);
        expect(delIntruso.status).toBe(403);
        expect(rechazos.slice(antes)).toHaveLength(3);

        // Dueño quita a Juan -> 204 y permiso pasa a false.
        const quitar = await fetch(
          `${url}/itinerarios/${viajeId}/designados/juan%40correo.example`,
          { method: 'DELETE', headers: { authorization: `Bearer ${jwtDueno}` } },
        );
        expect(quitar.status).toBe(204);

        const permJuanDespues = await fetch(
          `${url}/interna/permisos/itinerarios/${viajeId}?usuarioId=${juanId}`,
          { headers: { authorization: `Bearer ${jwtJuan}` } },
        );
        expect(await permJuanDespues.json()).toEqual({
          viajeId,
          usuarioId: juanId,
          puedeVer: false,
          motivo: 'ninguno',
        });

        // Quitar un email que no está designado -> 404.
        const quitarInexistente = await fetch(
          `${url}/itinerarios/${viajeId}/designados/juan%40correo.example`,
          { method: 'DELETE', headers: { authorization: `Bearer ${jwtDueno}` } },
        );
        expect(quitarInexistente.status).toBe(404);
      });

      it('responde 404 si el viaje no existe y 503 si Viajes está caído', async () => {
        const { usuarioId: duenoId } = await crearCuentaViaEndpoint({
          email: 'dueno2@correo.example',
          nombre: 'Dueño 2',
        });
        const jwtDueno = await firmarJwt(claves, { sub: duenoId });

        const viajeDesconocido = randomUUID();
        const resp404 = await fetch(`${url}/itinerarios/${viajeDesconocido}/designados`, {
          headers: { authorization: `Bearer ${jwtDueno}` },
        });
        expect(resp404.status).toBe(404);

        viajesCaido = true;
        const resp503 = await fetch(`${url}/itinerarios/${viajeDesconocido}/designados`, {
          headers: { authorization: `Bearer ${jwtDueno}` },
        });
        expect(resp503.status).toBe(503);
      });
    });
  },
);
