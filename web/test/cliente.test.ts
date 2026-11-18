import { describe, expect, it } from 'vitest';
import { crearApi } from '../src/api/cliente.ts';
import { crearSesion, leerClaims, type Almacen } from '../src/api/sesion.ts';

const b64 = (datos: unknown) => Buffer.from(JSON.stringify(datos)).toString('base64url');
const AHORA = Date.parse('2026-11-20T13:45:00Z');
const jwt = (venceEnSeg: number, extra: Record<string, unknown> = {}) =>
  `${b64({ alg: 'RS256' })}.${b64({
    sub: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    region: 'region-2',
    roles: ['usuario'],
    idioma: 'es',
    exp: AHORA / 1000 + venceEnSeg,
    ...extra,
  })}.firma`;

function almacen(): Almacen & { datos: Map<string, string> } {
  const datos = new Map<string, string>();
  return {
    datos,
    getItem: (c) => datos.get(c) ?? null,
    setItem: (c, v) => void datos.set(c, v),
    removeItem: (c) => void datos.delete(c),
  };
}

interface Pedido {
  url: string;
  metodo: string;
  headers: Record<string, string>;
  cuerpo: string;
}

/** fetch falso: anota cada solicitud y responde con la función dada. */
function fetchFalso(responder: (p: Pedido) => Response) {
  const pedidos: Pedido[] = [];
  const falso = async (entrada: RequestInfo | URL) => {
    const pedido = entrada as Request;
    const anotado = {
      url: pedido.url,
      metodo: pedido.method,
      headers: Object.fromEntries(pedido.headers),
      cuerpo: await pedido.text(),
    };
    pedidos.push(anotado);
    return responder(anotado);
  };
  return { pedidos, fetch: falso as typeof fetch };
}

const json = (status: number, datos: unknown) =>
  new Response(JSON.stringify(datos), { status, headers: { 'content-type': 'application/json' } });

function preparar(responder: (p: Pedido) => Response) {
  const a = almacen();
  const sesion = crearSesion(a, () => AHORA);
  const falso = fetchFalso(responder);
  let vencida = 0;
  const api = crearApi({
    urlBase: 'http://localhost:8000',
    sesion,
    fetch: falso.fetch,
    alVencer: () => vencida++,
  });
  return { api, sesion, almacen: a, pedidos: falso.pedidos, vencidas: () => vencida };
}

describe('leerClaims', () => {
  it('lee los claims del JWT sin verificar la firma', () => {
    expect(leerClaims(jwt(60))).toMatchObject({ region: 'region-2', roles: ['usuario'] });
    expect(leerClaims('basura')).toBeUndefined();
    expect(leerClaims(`x.${b64({ sub: 'a', exp: 1, region: 'marte' })}.y`)).toBeUndefined();
  });
});

describe('cliente de API', () => {
  it('login: va al enrutador sin JWT y con la región recordada en X-Region', async () => {
    const p = preparar(() =>
      json(200, { jwt: jwt(900), tokenRenovacion: 'r', region: 'region-2' }),
    );
    p.sesion.recordarRegion('region-2');
    const { data } = await p.api.autenticacion.POST('/login', {
      body: { email: 'ana@correo.example', contrasena: 'viajar-es-lindo-2026' },
    });
    expect(data?.region).toBe('region-2');
    expect(p.pedidos[0]).toMatchObject({
      url: 'http://localhost:8000/api/autenticacion/login',
      metodo: 'POST',
    });
    expect(p.pedidos[0]?.headers['x-region']).toBe('region-2');
    expect(p.pedidos[0]?.headers.authorization).toBeUndefined();
  });

  it('sin región recordada (dispositivo nuevo) no manda X-Region', async () => {
    const p = preparar(() => json(401, {}));
    await p.api.autenticacion.POST('/login', { body: { email: 'a@b.example', contrasena: 'x' } });
    expect(p.pedidos[0]?.headers['x-region']).toBeUndefined();
  });

  it('agrega el JWT vigente sin renovarlo', async () => {
    const p = preparar(() => json(200, { viajes: [] }));
    p.sesion.guardar({ jwt: jwt(600), tokenRenovacion: 'r', region: 'region-2' });
    await p.api.viajes.GET('/panel');
    expect(p.pedidos).toHaveLength(1);
    expect(p.pedidos[0]?.url).toBe('http://localhost:8000/api/viajes/panel');
    expect(p.pedidos[0]?.headers.authorization).toBe(`Bearer ${jwt(600)}`);
  });

  it('si el JWT venció, lo renueva una sola vez antes de mandar las solicitudes', async () => {
    const nuevo = jwt(900, { n: 2 });
    const p = preparar((pedido) =>
      pedido.url.endsWith('/renovar') ? json(200, { jwt: nuevo }) : json(200, { viajes: [] }),
    );
    p.sesion.guardar({ jwt: jwt(-10), tokenRenovacion: 'renovacion-1', region: 'region-2' });
    await Promise.all([p.api.viajes.GET('/panel'), p.api.usuarios.GET('/perfil')]);
    const renovaciones = p.pedidos.filter((x) => x.url.endsWith('/renovar'));
    expect(renovaciones).toHaveLength(1);
    expect(JSON.parse(renovaciones[0]?.cuerpo ?? '')).toEqual({ tokenRenovacion: 'renovacion-1' });
    expect(renovaciones[0]?.headers['x-region']).toBe('region-2');
    for (const pedido of p.pedidos.filter((x) => !x.url.endsWith('/renovar'))) {
      expect(pedido.headers.authorization).toBe(`Bearer ${nuevo}`);
    }
    expect(p.sesion.obtener()?.jwt).toBe(nuevo);
  });

  it('un 401 con el JWT vigente: renueva y repite la solicitud una vez, con el mismo cuerpo', async () => {
    const nuevo = jwt(900, { n: 2 });
    let rechazos = 0;
    const p = preparar((pedido) => {
      if (pedido.url.endsWith('/renovar')) return json(200, { jwt: nuevo });
      if (pedido.headers.authorization === `Bearer ${nuevo}`) return json(200, {});
      rechazos++;
      return json(401, {});
    });
    p.sesion.guardar({ jwt: jwt(600), tokenRenovacion: 'r', region: 'region-2' });
    const { response } = await p.api.usuarios.PUT('/whitelist', {
      body: { remitentesPermitidos: ['reservas@aerolinea.example'], filtrosActivos: true },
    });
    expect(response.status).toBe(200);
    expect(rechazos).toBe(1);
    const repetida = p.pedidos.at(-1);
    expect(repetida?.cuerpo).toBe(p.pedidos[0]?.cuerpo);
  });

  it('si no se puede renovar, cierra la sesión (la región queda recordada)', async () => {
    const p = preparar((pedido) =>
      pedido.url.endsWith('/renovar') ? json(401, {}) : json(401, {}),
    );
    p.sesion.guardar({ jwt: jwt(-10), tokenRenovacion: 'vencido', region: 'region-2' });
    await p.api.viajes.GET('/panel');
    expect(p.sesion.obtener()).toBeUndefined();
    expect(p.sesion.region()).toBe('region-2');
    expect(p.vencidas()).toBe(1);
    expect(p.pedidos.at(-1)?.headers.authorization).toBeUndefined();
  });
});
