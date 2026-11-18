import { randomBytes, randomUUID } from 'node:crypto';
import { loggerDePrueba } from '@trotamundos/comun/pruebas';
import { describe, expect, it } from 'vitest';
import { crearRegistroAdaptadores } from '../src/adaptadores/registro.ts';
import type { AdaptadorCorreo } from '../src/adaptadores/tipos.ts';
import { crearClienteViajes, crearProveedorTokenServicio } from '../src/clientes.ts';
import { esquemaConfig, resolverConfigAdaptadores } from '../src/config.ts';
import { clasificarCuentaParaRevision } from '../src/examinador.ts';
import { calcularEsperaExponencialMs } from '../src/repositorio.ts';

function falsoAdaptador(proveedor: string, soportaPush: boolean): AdaptadorCorreo {
  return {
    proveedor,
    soportaPush,
    urlAutorizacion: (s) => `https://${proveedor}.example/auth?state=${s}`,
    canjearCodigo: async () => ({
      credenciales: { accessToken: 'a', refreshToken: 'r', expiraEn: new Date(), scope: 'read' },
      perfil: { email: `u@${proveedor}.example` },
    }),
    renovarToken: async () => ({ accessToken: 'a2', expiraEn: new Date(), scope: 'read' }),
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

describe('clasificación y prioridades del Examinador (ADR-010)', () => {
  const adaptadores = crearRegistroAdaptadores([
    falsoAdaptador('gmail', true),
    falsoAdaptador('imap', false),
  ]);
  const intervalos = { viajeProximoMs: 5 * 60_000, normalMs: 60 * 60_000 };
  const ahoraMs = Date.parse('2026-11-28T12:00:00Z');

  it('da prioridad máxima (1) a una cuenta recién conectada incluso en proveedor con push', () => {
    const decision = clasificarCuentaParaRevision(
      {
        id: randomUUID(),
        usuarioId: randomUUID(),
        proveedor: 'gmail',
        email: 'ana@gmail.example',
        suscripcionId: 'projects/trotamundos/topics/gmail-avisos-region-1',
        revisionPrioritaria: true,
        proximaRevision: new Date(ahoraMs),
        ultimoEncolado: null,
        intentos429: 0,
      },
      new Set(),
      adaptadores,
      intervalos,
      ahoraMs,
    );
    expect(decision).toEqual({ debeEncolar: true, origen: 'cuenta-nueva', prioridad: 1 });
  });

  it('no consulta por intervalo una cuenta con push activo luego de la revisión inicial', () => {
    const decision = clasificarCuentaParaRevision(
      {
        id: randomUUID(),
        usuarioId: randomUUID(),
        proveedor: 'gmail',
        email: 'ana@gmail.example',
        suscripcionId: 'projects/trotamundos/topics/gmail-avisos-region-1',
        revisionPrioritaria: false,
        proximaRevision: new Date(ahoraMs - 120 * 60_000),
        ultimoEncolado: new Date(ahoraMs - 120 * 60_000),
        intentos429: 0,
      },
      new Set(['cualquier-usuario']),
      adaptadores,
      intervalos,
      ahoraMs,
    );
    expect(decision).toEqual({ debeEncolar: false });
  });

  it('aplica intervalo de 5 min con viaje próximo y 60 min al resto en buzones sin push', () => {
    const usuarioProximo = randomUUID();
    const usuarioNormal = randomUUID();
    const proximos = new Set([usuarioProximo]);

    // A los 5 min: revisa usuario con viaje próximo, saltea usuario sin viaje próximo.
    const dProx5 = clasificarCuentaParaRevision(
      {
        id: randomUUID(),
        usuarioId: usuarioProximo,
        proveedor: 'imap',
        email: 'a@imap.example',
        suscripcionId: null,
        revisionPrioritaria: false,
        proximaRevision: new Date(ahoraMs),
        ultimoEncolado: new Date(ahoraMs - 5 * 60_000),
        intentos429: 0,
      },
      proximos,
      adaptadores,
      intervalos,
      ahoraMs,
    );
    const dNorm5 = clasificarCuentaParaRevision(
      {
        id: randomUUID(),
        usuarioId: usuarioNormal,
        proveedor: 'imap',
        email: 'b@imap.example',
        suscripcionId: null,
        revisionPrioritaria: false,
        proximaRevision: new Date(ahoraMs),
        ultimoEncolado: new Date(ahoraMs - 5 * 60_000),
        intentos429: 0,
      },
      proximos,
      adaptadores,
      intervalos,
      ahoraMs,
    );
    expect(dProx5).toEqual({ debeEncolar: true, origen: 'viaje-proximo', prioridad: 2 });
    expect(dNorm5).toEqual({ debeEncolar: false });

    // A los 60 min: el resto pasa a prioridad 3.
    const dNorm60 = clasificarCuentaParaRevision(
      {
        id: randomUUID(),
        usuarioId: usuarioNormal,
        proveedor: 'imap',
        email: 'b@imap.example',
        suscripcionId: null,
        revisionPrioritaria: false,
        proximaRevision: new Date(ahoraMs),
        ultimoEncolado: new Date(ahoraMs - 60 * 60_000),
        intentos429: 0,
      },
      proximos,
      adaptadores,
      intervalos,
      ahoraMs,
    );
    expect(dNorm60).toEqual({ debeEncolar: true, origen: 'periodica', prioridad: 3 });
  });
});

describe('backoff exponencial ante 429', () => {
  it('duplica la espera en cada intento hasta el máximo y respeta Retry-After mayor', () => {
    expect(calcularEsperaExponencialMs(1, 30_000, 300_000)).toBe(30_000);
    expect(calcularEsperaExponencialMs(2, 30_000, 300_000)).toBe(60_000);
    expect(calcularEsperaExponencialMs(3, 30_000, 300_000)).toBe(120_000);
    expect(calcularEsperaExponencialMs(5, 30_000, 300_000)).toBe(300_000);
    expect(calcularEsperaExponencialMs(1, 30_000, 300_000, 180)).toBe(180_000);
  });
});

describe('cliente de Viajes y caché en memoria de 10 minutos', () => {
  it('pide token de servicio una vez, cachea 10 min y tolera caídas de Viajes', async () => {
    const { logger } = loggerDePrueba('correo');
    const reloj = { ahora: 1_700_000_000_000 };
    const u1 = randomUUID();
    const u2 = randomUUID();
    let llamadasAuth = 0;
    let llamadasViajes = 0;
    let responderLista = [u1];
    let viajesCaido = false;

    const obtenerToken = crearProveedorTokenServicio({
      urlAutenticacion: 'http://autenticacion:3001',
      servicio: 'correo',
      secreto: 'secreto',
      logger,
      ahora: () => reloj.ahora,
      fetch: async () => {
        llamadasAuth += 1;
        return new Response(
          JSON.stringify({ tokenServicio: `jwt-${llamadasAuth}`, expiraEn: 300 }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });

    const viajes = crearClienteViajes({
      urlViajes: 'http://viajes:3004',
      obtenerToken,
      ttlCacheMs: 10 * 60_000,
      dias: 7,
      logger,
      ahora: () => reloj.ahora,
      fetch: async (input, init) => {
        llamadasViajes += 1;
        expect(String(input)).toContain('/interna/usuarios-con-viaje-proximo?dias=7');
        expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer jwt-/);
        if (viajesCaido) {
          return new Response(JSON.stringify({ status: 503 }), { status: 503 });
        }
        return new Response(
          JSON.stringify({
            dias: 7,
            calculadoEn: new Date(reloj.ahora).toISOString(),
            usuarioIds: responderLista,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const primero = await viajes.obtenerUsuariosConViajeProximo();
    expect([...primero]).toEqual([u1]);
    expect(llamadasViajes).toBe(1);

    // A los 9 minutos sigue saliendo de memoria sin llamar a Viajes.
    reloj.ahora += 9 * 60_000;
    responderLista = [u1, u2];
    const cacheado = await viajes.obtenerUsuariosConViajeProximo();
    expect([...cacheado]).toEqual([u1]);
    expect(llamadasViajes).toBe(1);

    // Pasados los 10 minutos vuelve a consultar Viajes; token de servicio sigue en caché.
    reloj.ahora += 61_000;
    const fallido = await (async () => {
      viajesCaido = true;
      return viajes.obtenerUsuariosConViajeProximo();
    })();
    // Si Viajes está caído, conserva la última cache sin romper.
    expect([...fallido]).toEqual([u1]);

    viajesCaido = false;
    const refrescado = await viajes.obtenerUsuariosConViajeProximo();
    expect([...refrescado]).toEqual([u1, u2]);
    expect(llamadasViajes).toBe(3);
  });

  it('configuración por defecto resuelve suscripción de Gmail e intervalos de Examinador', () => {
    const config = esquemaConfig.parse({
      REGION: 'region-1',
      PUERTO: '3003',
      URL_BASE: 'postgres://correo:clave@postgres:5432/correo',
      URL_BROKER: 'amqp://trotamundos:clave@rabbitmq:5672',
      URL_JWKS: 'http://autenticacion:3001/.well-known/jwks.json',
      CLAVE_TOKENS_CORREO: randomBytes(32).toString('base64'),
    });
    expect(config.INTERVALO_VIAJE_PROXIMO_MIN).toBe(5);
    expect(config.INTERVALO_NORMAL_MIN).toBe(60);
    expect(config.CACHE_VIAJES_MIN).toBe(10);
    expect(resolverConfigAdaptadores(config).suscripcionGmail).toBe(
      'projects/trotamundos/subscriptions/gmail-avisos-region-1-push',
    );
  });
});
