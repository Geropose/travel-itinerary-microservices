import { describe, expect, it } from 'vitest';
import { cerrarSesion, iniciarSesion, registrarse } from '../src/acciones.ts';
import { crearApi } from '../src/api/cliente.ts';
import { crearSesion, type Almacen } from '../src/api/sesion.ts';

function crearAlmacen(fallarSet = false): Almacen {
  const mapa = new Map<string, string>();
  return {
    getItem: (k) => mapa.get(k) ?? null,
    setItem: (k, v) => {
      if (fallarSet) throw new Error('QuotaExceededError');
      mapa.set(k, v);
    },
    removeItem: (k) => void mapa.delete(k),
  };
}

describe('acciones de acceso web', () => {
  it('iniciarSesion mapea HTTP 400 (contraseña corta) a credenciales', async () => {
    const almacen = crearAlmacen();
    const sesion = crearSesion(almacen);
    const api = crearApi({
      urlBase: 'http://localhost:8000',
      sesion,
      fetch: (async () =>
        new Response(JSON.stringify({ status: 400 }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
    const res = await iniciarSesion(api, sesion, almacen, 'ana@correo.example', '123');
    expect(res).toEqual({ ok: false, error: 'credenciales' });
  });

  it('registrarse tolera error de almacenamiento en recordarRegion y cierra normalmente', async () => {
    const almacen = crearAlmacen(true);
    const sesion = crearSesion(almacen);
    const api = crearApi({
      urlBase: 'http://localhost:8000',
      sesion,
      fetch: (async () =>
        new Response(JSON.stringify({ status: 409 }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
    await expect(
      registrarse(api, sesion, almacen, {
        nombre: 'Ana',
        email: 'ana@correo.example',
        contrasena: 'clave-larga-segura',
        region: 'region-1',
        idioma: 'es',
      }),
    ).resolves.toEqual({ ok: false, error: 'emailUsado' });
  });

  it('cerrarSesion limpia la sesión local aunque POST /logout quede colgado', async () => {
    const almacen = crearAlmacen();
    const sesion = crearSesion(almacen, () => Date.parse('2026-11-20T13:45:00Z'));
    sesion.guardar({
      jwt: 'a.eyJzdWIiOiJ1MSIsInJlZ2lvbiI6InJlZ2lvbi0xIiwicm9sZXMiOlsidXN1YXJpbyJdLCJleHAiOjE5OTk5OTk5OTl9.b',
      tokenRenovacion: 'tok-1',
      region: 'region-1',
    });
    const api = crearApi({
      urlBase: 'http://localhost:8000',
      sesion,
      fetch: (() => new Promise<Response>(() => undefined)) as typeof fetch,
    });
    await cerrarSesion(api, sesion, sesion.claims(), 30);
    expect(sesion.obtener()).toBeUndefined();
  });
});
