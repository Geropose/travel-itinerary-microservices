// Autenticación contra una PostgreSQL de verdad (contenedor), con Usuarios y la otra región falsos:
// registro, login correcto e incorrecto, renovación, logout, token vencido, login en la región
// equivocada, límite de intentos, contraseña guardada con hash y rutas internas.
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  crearPool,
  crearValidador,
  ErrorRespuestaHttp,
  migrar,
  MIGRACIONES_EVENTOS,
  type AccesoRechazado,
  type Pool,
} from '@trotamundos/comun';
import {
  dockerDisponible,
  levantarPostgres,
  loggerDePrueba,
  type ContenedorPostgres,
} from '@trotamundos/comun/pruebas';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sembrarAnalista } from '../src/analista.ts';
import { crearApp, reglasDeRutas } from '../src/app.ts';
import { leerClaves, type ClavesJwt } from '../src/claves.ts';
import type { NuevaCuenta } from '../src/clientes.ts';
import { firmarTokenDeServicio } from '../src/tokens.ts';

const hayDocker = await dockerDisponible();

function nuevasClaves(region: 'region-1' | 'region-2'): ClavesJwt {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return leerClaves(Buffer.from(privateKey).toString('base64'), region);
}

const SECRETO_CORREO = 'secreto-de-correo-de-prueba-0123456789abcdef';
const CONTRASENA = 'viajar-es-lindo-2026';

describe.skipIf(!hayDocker)('Servicio de Autenticación', { timeout: 60_000 }, () => {
  const claves = nuevasClaves('region-1');
  const clavesOtra = nuevasClaves('region-2');
  const { logger } = loggerDePrueba('autenticacion');
  let postgres: ContenedorPostgres;
  let pool: Pool;
  let url: string;
  let detener: (() => Promise<void>) | undefined;

  // Usuarios y la otra región, falsos y controlables desde cada prueba.
  const cuentasCreadas: NuevaCuenta[] = [];
  let usuariosResponde: 'ok' | 'error' | 'conflicto' = 'ok';
  const cuentasOtraRegion = new Set<string>();
  let otraRegionCaida = false;
  const rechazos: AccesoRechazado[] = [];

  const validador = crearValidador({
    servicio: 'autenticacion',
    region: 'region-1',
    logger,
    claves: { 'region-1': { claves: claves.jwks }, 'region-2': { claves: clavesOtra.jwks } },
    registrar: (r) => rechazos.push(r),
    reglas: reglasDeRutas('region-1'),
  });

  beforeAll(async () => {
    postgres = await levantarPostgres();
    pool = crearPool({ url: postgres.url });
    await migrar(pool, [
      MIGRACIONES_EVENTOS,
      fileURLToPath(new URL('../migrations/', import.meta.url)),
    ]);
    const servidor = crearApp({
      region: 'region-1',
      puerto: 0,
      logger,
      manejarSenales: false,
      validador,
      jwks: claves.jwks,
      negocio: {
        pool,
        claves,
        usuarios: {
          async crearCuenta(cuenta) {
            if (usuariosResponde === 'error') throw new Error('Usuarios no responde');
            if (usuariosResponde === 'conflicto') {
              throw new ErrorRespuestaHttp('http://usuarios:3002/interna/cuentas', 409, {});
            }
            cuentasCreadas.push(cuenta);
          },
        },
        otraRegion: {
          region: 'region-2',
          async existeCuenta(email) {
            if (otraRegionCaida) throw new Error('La otra región no responde');
            return cuentasOtraRegion.has(email);
          },
        },
        urlPublicaOtraRegion: 'http://localhost:8082',
        secretos: new Map([['correo', SECRETO_CORREO]]),
        registrar: (r) => rechazos.push(r),
        limiteLogin: { maxIntentos: 5, ventanaMinutos: 15 },
      },
    });
    await validador.iniciar();
    url = `http://127.0.0.1:${await servidor.iniciar()}`;
    detener = () => servidor.detener();
    // En CI la primera vez hay que bajar la imagen de PostgreSQL.
  }, 120_000);

  afterAll(async () => {
    await detener?.();
    await pool?.end();
    await postgres?.detener();
  }, 60_000);

  beforeEach(() => {
    usuariosResponde = 'ok';
    otraRegionCaida = false;
  });

  const pedir = (ruta: string, cuerpo?: unknown, token?: string, metodo = 'POST') =>
    fetch(`${url}${ruta}`, {
      method: metodo,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
      redirect: 'manual',
    });

  const registrar = (email: string, extra: Record<string, unknown> = {}) =>
    pedir('/registro', {
      email,
      contrasena: CONTRASENA,
      nombre: 'Ana Pérez',
      region: 'region-1',
      idioma: 'es',
      ...extra,
    });

  const login = (email: string, contrasena = CONTRASENA) => pedir('/login', { email, contrasena });

  async function sesion(email: string) {
    expect((await registrar(email)).status).toBe(201);
    const respuesta = await login(email);
    expect(respuesta.status).toBe(200);
    return (await respuesta.json()) as { jwt: string; tokenRenovacion: string; region: string };
  }

  const cantidad = async (sql: string, parametros: unknown[]) =>
    Number((await pool.query<{ n: string }>(sql, parametros)).rows[0]?.n);

  describe('registro', () => {
    it('crea la credencial con hash argon2id y la cuenta en Usuarios', async () => {
      const respuesta = await registrar('Ana@Correo.example');
      expect(respuesta.status).toBe(201);
      const { usuarioId } = (await respuesta.json()) as { usuarioId: string };
      expect(cuentasCreadas.at(-1)).toEqual({
        usuarioId,
        email: 'ana@correo.example',
        nombre: 'Ana Pérez',
        region: 'region-1',
        idioma: 'es',
      });
      const { rows } = await pool.query<{ hash: string }>(
        'SELECT hash_contrasena AS hash FROM credenciales WHERE usuario_id = $1',
        [usuarioId],
      );
      // La contraseña nunca queda en texto: solo el hash argon2id (QA-8).
      expect(rows[0]?.hash).toMatch(/^\$argon2id\$/);
      expect(rows[0]?.hash).not.toContain(CONTRASENA);
    });

    it('el mismo email (con otras mayúsculas) responde 409', async () => {
      await registrar('beto@correo.example');
      const respuesta = await registrar('BETO@correo.example');
      expect(respuesta.status).toBe(409);
      expect(respuesta.headers.get('content-type')).toContain('application/problem+json');
    });

    it('si la cuenta ya existe en la otra región responde 409', async () => {
      cuentasOtraRegion.add('carla@correo.example');
      expect((await registrar('carla@correo.example')).status).toBe(409);
    });

    it('con la región de la otra instancia responde 307 hacia ella sin guardar nada', async () => {
      const respuesta = await registrar('dani@correo.example', { region: 'region-2' });
      expect(respuesta.status).toBe(307);
      expect(respuesta.headers.get('location')).toBe(
        'http://localhost:8082/api/autenticacion/registro',
      );
      expect(await respuesta.json()).toEqual({ region: 'region-2' });
      expect(
        await cantidad('SELECT count(*) AS n FROM credenciales WHERE email = $1', [
          'dani@correo.example',
        ]),
      ).toBe(0);
    });

    it('si Usuarios falla se deshace el registro (503) y se puede volver a intentar', async () => {
      usuariosResponde = 'error';
      const respuesta = await registrar('eli@correo.example');
      expect(respuesta.status).toBe(503);
      expect(
        await cantidad('SELECT count(*) AS n FROM credenciales WHERE email = $1', [
          'eli@correo.example',
        ]),
      ).toBe(0);
      usuariosResponde = 'ok';
      expect((await registrar('eli@correo.example')).status).toBe(201);
    });

    it('si Usuarios dice que la cuenta ya existe responde 409 y no guarda nada', async () => {
      usuariosResponde = 'conflicto';
      expect((await registrar('fede@correo.example')).status).toBe(409);
      expect(
        await cantidad('SELECT count(*) AS n FROM credenciales WHERE email = $1', [
          'fede@correo.example',
        ]),
      ).toBe(0);
    });

    it('si la otra región no responde, 503: no se puede saber si el email está libre', async () => {
      otraRegionCaida = true;
      expect((await registrar('gabi@correo.example')).status).toBe(503);
    });
  });

  describe('login', () => {
    it('correcto: JWT RS256 de 15 minutos con sub, region, roles e idioma', async () => {
      const { jwt, tokenRenovacion, region } = await sesion('hugo@correo.example');
      expect(region).toBe('region-1');
      const datos = await validador.verificarToken(jwt);
      expect(datos).toMatchObject({ region: 'region-1', roles: ['usuario'], idioma: 'es' });
      const { exp, iat } = JSON.parse(
        Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString(),
      ) as { exp: number; iat: number };
      expect(exp - iat).toBe(15 * 60);
      // El token de renovación se guarda solo como hash.
      expect(
        await cantidad('SELECT count(*) AS n FROM tokens_renovacion WHERE hash = $1', [
          tokenRenovacion,
        ]),
      ).toBe(0);
      expect(
        await cantidad('SELECT count(*) AS n FROM tokens_renovacion WHERE usuario_id = $1', [
          datos.sub,
        ]),
      ).toBe(1);
    });

    it('contraseña incorrecta o email inexistente: 401 sin decir cuál falló', async () => {
      await registrar('ines@correo.example');
      const mala = await login('ines@correo.example', 'otra-contrasena');
      const inexistente = await login('nadie@correo.example');
      for (const respuesta of [mala, inexistente]) {
        expect(respuesta.status).toBe(401);
        expect(await respuesta.json()).toMatchObject({
          title: 'Credenciales incorrectas',
          detail: 'El email o la contraseña no son correctos.',
        });
      }
    });

    it('en la región equivocada responde 307 hacia la región de la cuenta sin guardar nada', async () => {
      cuentasOtraRegion.add('juli@correo.example');
      const respuesta = await login('juli@correo.example');
      expect(respuesta.status).toBe(307);
      expect(respuesta.headers.get('location')).toBe(
        'http://localhost:8082/api/autenticacion/login',
      );
      expect(await respuesta.json()).toEqual({ region: 'region-2' });
      // Ni credencial, ni intento fallido, ni token (ADR-017: los datos solo pasan).
      for (const tabla of ['credenciales', 'intentos_fallidos']) {
        expect(
          await cantidad(`SELECT count(*) AS n FROM ${tabla} WHERE email = $1`, [
            'juli@correo.example',
          ]),
        ).toBe(0);
      }
    });

    it('si la otra región no responde y la cuenta no está acá, 503', async () => {
      otraRegionCaida = true;
      expect((await login('kevin@correo.example')).status).toBe(503);
    });

    it('5 intentos fallidos en 15 minutos: el siguiente responde 429 aunque la contraseña sea buena', async () => {
      await registrar('lola@correo.example');
      for (let i = 0; i < 5; i++) {
        expect((await login('lola@correo.example', 'mal-mal-mal')).status).toBe(401);
      }
      const respuesta = await login('lola@correo.example');
      expect(respuesta.status).toBe(429);
      expect(Number(respuesta.headers.get('retry-after'))).toBeGreaterThan(800);
      expect(await respuesta.json()).toMatchObject({ status: 429, title: 'Demasiados intentos' });
    });

    it('un login correcto vuelve a cero los intentos fallidos', async () => {
      await registrar('mora@correo.example');
      for (let i = 0; i < 4; i++) await login('mora@correo.example', 'mal-mal-mal');
      expect((await login('mora@correo.example')).status).toBe(200);
      for (let i = 0; i < 4; i++) await login('mora@correo.example', 'mal-mal-mal');
      expect((await login('mora@correo.example')).status).toBe(200);
    });
  });

  describe('renovación y logout', () => {
    it('renovar devuelve un JWT nuevo del mismo usuario', async () => {
      const { jwt, tokenRenovacion } = await sesion('nico@correo.example');
      const respuesta = await pedir('/renovar', { tokenRenovacion });
      expect(respuesta.status).toBe(200);
      const nuevo = ((await respuesta.json()) as { jwt: string }).jwt;
      expect((await validador.verificarToken(nuevo)).sub).toBe(
        (await validador.verificarToken(jwt)).sub,
      );
    });

    it('un token de renovación desconocido o vencido responde 401', async () => {
      const { tokenRenovacion } = await sesion('olga@correo.example');
      expect((await pedir('/renovar', { tokenRenovacion: 'x'.repeat(43) })).status).toBe(401);
      await pool.query("UPDATE tokens_renovacion SET vence_en = now() - interval '1 second'");
      const respuesta = await pedir('/renovar', { tokenRenovacion });
      expect(respuesta.status).toBe(401);
      expect(await respuesta.json()).toMatchObject({ title: 'Token de renovación inválido' });
    });

    it('logout invalida el token de renovación y es idempotente', async () => {
      const { jwt, tokenRenovacion } = await sesion('pablo@correo.example');
      expect((await pedir('/logout', { tokenRenovacion }, jwt)).status).toBe(204);
      expect((await pedir('/renovar', { tokenRenovacion })).status).toBe(401);
      expect((await pedir('/logout', { tokenRenovacion }, jwt)).status).toBe(204);
    });

    it('logout con el token de otro usuario: 403 y queda en el registro de accesos', async () => {
      const ajeno = await sesion('quique@correo.example');
      const propio = await sesion('rosa@correo.example');
      const antes = rechazos.length;
      const respuesta = await pedir(
        '/logout',
        { tokenRenovacion: ajeno.tokenRenovacion },
        propio.jwt,
      );
      expect(respuesta.status).toBe(403);
      expect(rechazos.slice(antes)).toMatchObject([{ status: 403, motivo: 'sin-permiso' }]);
      // El token del otro sigue sirviendo.
      expect((await pedir('/renovar', { tokenRenovacion: ajeno.tokenRenovacion })).status).toBe(
        200,
      );
    });

    it('logout sin JWT o con un JWT vencido responde 401', async () => {
      const { tokenRenovacion, jwt } = await sesion('sofi@correo.example');
      const { sub } = await validador.verificarToken(jwt);
      const vencido = await new SignJWT({ region: 'region-1', roles: ['usuario'], idioma: 'es' })
        .setProtectedHeader({ alg: 'RS256', kid: claves.jwks.keys[0]?.kid ?? '' })
        .setSubject(sub)
        .setIssuedAt(Math.floor(Date.now() / 1000) - 20 * 60)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 5 * 60)
        .sign(claves.privada);
      expect((await pedir('/logout', { tokenRenovacion })).status).toBe(401);
      expect((await pedir('/logout', { tokenRenovacion }, vencido)).status).toBe(401);
      // El token de renovación no se tocó.
      expect((await pedir('/renovar', { tokenRenovacion })).status).toBe(200);
    });
  });

  describe('rutas internas', () => {
    it('GET /interna/cuentas/existe acepta el token de servicio de la Autenticación de la otra región', async () => {
      await registrar('tomi@correo.example');
      const token = await firmarTokenDeServicio(clavesOtra, 'autenticacion', 'region-2');
      const existe = await pedir(
        '/interna/cuentas/existe?email=tomi%40correo.example',
        undefined,
        token,
        'GET',
      );
      expect(existe.status).toBe(200);
      expect(await existe.json()).toEqual({ existe: true, region: 'region-1' });
      const noExiste = await pedir(
        '/interna/cuentas/existe?email=nadie%40correo.example',
        undefined,
        token,
        'GET',
      );
      expect(await noExiste.json()).toEqual({ existe: false, region: 'region-1' });
    });

    it('GET /interna/cuentas/existe rechaza a otros servicios y a los usuarios', async () => {
      const deCorreo = await firmarTokenDeServicio(claves, 'correo', 'region-1');
      const usuario = (await sesion('ulises@correo.example')).jwt;
      const ruta = '/interna/cuentas/existe?email=a%40correo.example';
      expect((await pedir(ruta, undefined, deCorreo, 'GET')).status).toBe(403);
      expect((await pedir(ruta, undefined, usuario, 'GET')).status).toBe(403);
      expect((await pedir(ruta, undefined, undefined, 'GET')).status).toBe(401);
    });

    it('POST /interna/tokens-servicio emite un token de 5 minutos con el secreto correcto', async () => {
      const respuesta = await pedir('/interna/tokens-servicio', {
        servicio: 'correo',
        secreto: SECRETO_CORREO,
      });
      expect(respuesta.status).toBe(200);
      const { tokenServicio, expiraEn } = (await respuesta.json()) as {
        tokenServicio: string;
        expiraEn: number;
      };
      expect(expiraEn).toBe(300);
      expect(await validador.verificarToken(tokenServicio)).toMatchObject({
        sub: 'correo',
        roles: ['servicio'],
        esServicio: true,
      });
    });

    it('POST /interna/tokens-servicio con un secreto incorrecto: 401 y queda registrado', async () => {
      const antes = rechazos.length;
      for (const cuerpo of [
        { servicio: 'correo', secreto: 'x'.repeat(40) },
        // "pruebas" no tiene secreto configurado: no existe.
        { servicio: 'pruebas', secreto: SECRETO_CORREO },
      ]) {
        expect((await pedir('/interna/tokens-servicio', cuerpo)).status).toBe(401);
      }
      expect(rechazos.slice(antes)).toMatchObject([
        { status: 401, ruta: '/interna/tokens-servicio' },
        { status: 401, ruta: '/interna/tokens-servicio' },
      ]);
    });
  });

  describe('semillas', () => {
    it('crean el analista de prueba, que inicia sesión con el rol analista', async () => {
      const id = await sembrarAnalista(pool, 'contrasena-del-analista');
      // Correr las semillas de nuevo no duplica nada.
      expect(await sembrarAnalista(pool, 'contrasena-del-analista')).toBe(id);
      const respuesta = await login('analista@trotamundos.example', 'contrasena-del-analista');
      expect(respuesta.status).toBe(200);
      const { jwt } = (await respuesta.json()) as { jwt: string };
      expect(await validador.verificarToken(jwt)).toMatchObject({ sub: id, roles: ['analista'] });
    });
  });

  it('cada usuario recibe un usuarioId distinto', () => {
    const ids = cuentasCreadas.map((c) => c.usuarioId);
    expect(ids.length).toBeGreaterThan(5);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
