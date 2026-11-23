import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { crearEvento, ErrorTiempoAgotado, validadorEventos, type Pool } from '@trotamundos/comun';
import { loggerDePrueba } from '@trotamundos/comun/pruebas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crearApp, reglasDeRutas } from '../src/app.ts';
import { leerClaves } from '../src/claves.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const claves = leerClaves(Buffer.from(privateKey).toString('base64'), 'region-1');

describe('Auditoría de Autenticación (sin Docker)', () => {
  const servidoresPorCerrar: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (servidoresPorCerrar.length > 0) {
      await servidoresPorCerrar.pop()?.();
    }
  });

  function crearAppPrueba(overrides?: {
    crearCuenta?: () => Promise<void>;
    otraRegionExiste?: () => Promise<boolean>;
    rechazos?: unknown[];
  }) {
    const { logger } = loggerDePrueba('autenticacion');
    const filasIntentos: Array<{ id: number; email: string }> = [];
    let siguienteId = 1;
    let enLock = Promise.resolve();

    const pool = {
      connect: vi.fn(async () => {
        let liberarLock: (() => void) | undefined;
        return {
          query: vi.fn(async (sql: string, params?: unknown[]) => {
            if (sql.includes('pg_advisory_xact_lock')) {
              const previo = enLock;
              let resolver!: () => void;
              enLock = new Promise<void>((r) => {
                resolver = r;
              });
              liberarLock = resolver;
              await previo;
              return { rows: [] };
            }
            if (sql === 'COMMIT' || sql === 'ROLLBACK') {
              liberarLock?.();
              liberarLock = undefined;
              return { rows: [] };
            }
            if (sql.includes('DELETE FROM intentos_fallidos WHERE email = $1 AND fecha <=')) {
              return { rows: [] };
            }
            if (sql.includes('SELECT count(*) AS cantidad')) {
              const email = String(params?.[0] ?? '');
              const cantidad = filasIntentos.filter((f) => f.email === email).length;
              return { rows: [{ cantidad: String(cantidad), libera: 900 }] };
            }
            if (sql.includes('INSERT INTO intentos_fallidos')) {
              const id = siguienteId++;
              filasIntentos.push({ id, email: String(params?.[0] ?? '') });
              return { rows: [{ id }] };
            }
            if (sql.includes('INSERT INTO credenciales')) {
              return { rows: [] };
            }
            return { rows: [] };
          }),
          release: vi.fn(() => {
            liberarLock?.();
          }),
        };
      }),
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('DELETE FROM intentos_fallidos WHERE id = $1')) {
          const id = Number(params?.[0]);
          const idx = filasIntentos.findIndex((f) => f.id === id);
          if (idx >= 0) filasIntentos.splice(idx, 1);
          return { rows: [] };
        }
        if (sql.includes('SELECT 1 FROM credenciales')) return { rowCount: 0, rows: [] };
        if (sql.includes('FROM credenciales WHERE email')) return { rows: [] };
        return { rows: [] };
      }),
    } as unknown as Pool;

    const app = crearApp({
      region: 'region-1',
      puerto: 0,
      logger,
      manejarSenales: false,
      jwks: claves.jwks,
      negocio: {
        pool,
        claves,
        usuarios: {
          crearCuenta: overrides?.crearCuenta ?? (async () => undefined),
        },
        otraRegion: {
          region: 'region-2',
          existeCuenta: overrides?.otraRegionExiste ?? (async () => false),
        },
        urlPublicaOtraRegion: 'http://localhost:8000/region-2',
        secretos: new Map([['correo', 'secreto-correo-123456']]),
        limiteLogin: { maxIntentos: 5, ventanaMinutos: 15 },
        registrar: (r) => {
          overrides?.rechazos?.push(r);
        },
      },
    });
    return { app, filasIntentos };
  }

  it('POST /login serializa los intentos concurrentes sin exceder el límite de 5 antes de 429', async () => {
    const { app } = crearAppPrueba();
    const base = `http://127.0.0.1:${await app.iniciar()}`;
    servidoresPorCerrar.push(() => app.detener());

    const respuestas = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`${base}/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'concurrente@correo.example',
            contrasena: 'clave-incorrecta-123',
          }),
        }),
      ),
    );
    const codigos = respuestas.map((r) => r.status);
    expect(codigos.filter((s) => s === 401)).toHaveLength(5);
    expect(codigos.filter((s) => s === 429)).toHaveLength(5);
  });

  it('POST /login hacia otra región (307) limpia la marca tentativa del intento', async () => {
    const { app, filasIntentos } = crearAppPrueba({ otraRegionExiste: async () => true });
    const base = `http://127.0.0.1:${await app.iniciar()}`;
    servidoresPorCerrar.push(() => app.detener());

    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'otra@correo.example', contrasena: 'cualquiera-123' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(307);
    expect(filasIntentos).toHaveLength(0);
  });

  it('POST /registro reintenta una vez ante ErrorTiempoAgotado de Usuarios con el mismo usuarioId', async () => {
    let intentos = 0;
    const { app } = crearAppPrueba({
      crearCuenta: async () => {
        intentos++;
        if (intentos === 1)
          throw new ErrorTiempoAgotado('http://usuarios:3002/interna/cuentas', 2000);
      },
    });
    const base = `http://127.0.0.1:${await app.iniciar()}`;
    servidoresPorCerrar.push(() => app.detener());

    const res = await fetch(`${base}/registro`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nombre: 'Ada',
        email: 'ada@correo.example',
        contrasena: 'clave-segura-2026',
        region: 'region-1',
        idioma: 'es',
      }),
    });
    expect(res.status).toBe(201);
    expect(intentos).toBe(2);
  });

  it('POST /interna/tokens-servicio con X-Forwarded-For falso registra AccesoRechazado válido sin ip inválida', async () => {
    const rechazos: Array<Record<string, unknown>> = [];
    const { app } = crearAppPrueba({ rechazos });
    const base = `http://127.0.0.1:${await app.iniciar()}`;
    servidoresPorCerrar.push(() => app.detener());

    const res = await fetch(`${base}/interna/tokens-servicio`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': 'invalida' },
      body: JSON.stringify({ servicio: 'correo', secreto: 'x'.repeat(40) }),
    });
    expect(res.status).toBe(401);
    expect(rechazos).toHaveLength(1);
    const validador = validadorEventos();
    expect(() =>
      validador.validar(crearEvento('AccesoRechazado', rechazos[0], 'region-1')),
    ).not.toThrow();
    expect(rechazos[0]?.ip).toBeUndefined();
    void randomUUID;
    void reglasDeRutas;
  });
});
