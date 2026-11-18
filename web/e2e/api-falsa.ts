// API falsa para las pruebas de la web: responde como el enrutador global según los contratos de
// Autenticación (autenticacion.yaml) y Viajes (GET /panel), y anota cada solicitud.
import type { Page } from '@playwright/test';

export const URL_API = 'http://localhost:8000';
const ORIGEN_WEB = 'http://localhost:4173';

export interface Cuenta {
  email: string;
  contrasena: string;
  region: 'region-1' | 'region-2';
  roles: string[];
  idioma: 'es' | 'en';
}

export interface Pedido {
  metodo: string;
  ruta: string;
  headers: Record<string, string>;
  cuerpo: unknown;
}

const b64 = (datos: unknown) => Buffer.from(JSON.stringify(datos)).toString('base64url');

export function jwtDe(cuenta: Cuenta, venceEnSeg = 900): string {
  const claims = {
    sub: `00000000-0000-4000-8000-${Buffer.from(cuenta.email).toString('hex').slice(0, 12).padEnd(12, '0')}`,
    region: cuenta.region,
    roles: cuenta.roles,
    idioma: cuenta.idioma,
    exp: Math.floor(Date.now() / 1000) + venceEnSeg,
  };
  return `${b64({ alg: 'RS256', kid: 'prueba' })}.${b64(claims)}.firma`;
}

export const usuaria: Cuenta = {
  email: 'ana@correo.example',
  contrasena: 'viajar-es-lindo-2026',
  region: 'region-2',
  roles: ['usuario'],
  idioma: 'es',
};

export const analista: Cuenta = {
  email: 'analista@trotamundos.example',
  contrasena: 'contrasena-analista',
  region: 'region-1',
  roles: ['analista'],
  idioma: 'es',
};

export interface OpcionesApiFalsa {
  cuentas?: Cuenta[];
  /** Respuesta de GET /api/viajes/panel (sin esto, 404 como hoy). */
  panel?: unknown;
}

export async function apiFalsa(page: Page, opciones: OpcionesApiFalsa = {}) {
  const cuentas = [...(opciones.cuentas ?? [usuaria, analista])];
  const pedidos: Pedido[] = [];
  let sinRed = false;
  const cors = {
    'access-control-allow-origin': ORIGEN_WEB,
    'access-control-allow-headers': 'Authorization, Content-Type, X-Request-Id, X-Region',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
    'access-control-expose-headers': 'X-Request-Id, Location, Retry-After',
  };
  const responder = (status: number, datos?: unknown) => ({
    status,
    headers: { ...cors, 'content-type': 'application/json' },
    ...(datos === undefined ? {} : { body: JSON.stringify(datos) }),
  });
  const problema = (status: number, title: string) =>
    responder(status, { type: 'https://trotamundos.example/errores/x', title, status });

  await page.route(`${URL_API}/**`, async (route) => {
    const pedido = route.request();
    if (pedido.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (sinRed) return route.abort('internetdisconnected');
    const ruta = new URL(pedido.url()).pathname;
    const cuerpo: unknown = pedido.postData() ? pedido.postDataJSON() : undefined;
    pedidos.push({ metodo: pedido.method(), ruta, headers: await pedido.allHeaders(), cuerpo });
    const datos = (cuerpo ?? {}) as Record<string, string>;

    switch (`${pedido.method()} ${ruta}`) {
      case 'POST /api/autenticacion/login': {
        const cuenta = cuentas.find(
          (c) => c.email === datos.email && c.contrasena === datos.contrasena,
        );
        if (!cuenta) return route.fulfill(problema(401, 'No autenticado'));
        return route.fulfill(
          responder(200, {
            jwt: jwtDe(cuenta),
            tokenRenovacion: 'renovacion',
            region: cuenta.region,
          }),
        );
      }
      case 'POST /api/autenticacion/registro': {
        if (cuentas.some((c) => c.email === datos.email)) {
          return route.fulfill(problema(409, 'El email ya está registrado'));
        }
        cuentas.push({
          email: datos.email ?? '',
          contrasena: datos.contrasena ?? '',
          region: datos.region === 'region-1' ? 'region-1' : 'region-2',
          roles: ['usuario'],
          idioma: datos.idioma === 'en' ? 'en' : 'es',
        });
        return route.fulfill(responder(201, { usuarioId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }));
      }
      case 'POST /api/autenticacion/logout':
        return route.fulfill({ status: 204, headers: cors });
      case 'GET /api/viajes/panel':
        if (opciones.panel) return route.fulfill(responder(200, opciones.panel));
        return route.fulfill(problema(404, 'No encontrado'));
      default:
        return route.fulfill(problema(404, 'No encontrado'));
    }
  });

  return {
    pedidos,
    /** Las solicitudes que llegaron a una ruta. */
    a: (ruta: string) => pedidos.filter((p) => p.ruta === ruta),
    /** Simula que no hay red: la API deja de responder. */
    cortarRed: () => {
      sinRed = true;
    },
  };
}
