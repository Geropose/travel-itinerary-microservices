// API falsa para las pruebas de la web: responde como el enrutador global según los contratos de
// Autenticación, Usuarios, Correo y Viajes, más mocks de OAuth de Gmail/Outlook, y anota cada solicitud.
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';

export const URL_API = 'http://localhost:8000';
const URL_MOCK_GMAIL = 'http://localhost:4001';
const URL_MOCK_OUTLOOK = 'http://localhost:4002';
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

export interface CuentaCorreoPrueba {
  id: string;
  proveedorCorreo: 'gmail' | 'outlook';
  email: string;
  estado: 'conectada' | 'sin-permiso';
  conectadaEn: string;
  ultimaRevision: string | null;
}

export interface DesignadoPrueba {
  email: string;
  usuarioId: string | null;
  designadoEn: string;
}

export interface ViajePrueba {
  viajeId: string;
  usuarioId: string;
  destino: string;
  inicio: string;
  fin: string;
  estado: 'activo' | 'archivado';
  reservas: {
    reservaId: string;
    viajeId: string;
    proveedor: string;
    tipoReserva: 'vuelo' | 'hotel' | 'auto';
    numeroReserva: string;
    inicio: string;
    fin: string;
    origen?: string;
    destino: string;
    estado: 'confirmada' | 'modificada' | 'cancelada';
    detalle: Record<string, unknown>;
    origenCambio: 'correo' | 'proveedor' | 'manual' | 'archivado';
    actualizadoEn: string;
  }[];
}

const b64 = (datos: unknown) => Buffer.from(JSON.stringify(datos)).toString('base64url');

export const subDe = (email: string) =>
  `00000000-0000-4000-8000-${Buffer.from(email).toString('hex').slice(0, 12).padEnd(12, '0')}`;

export function jwtDe(cuenta: Cuenta, venceEnSeg = 900): string {
  const claims = {
    sub: subDe(cuenta.email),
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
  panel?: { viajes: ViajePrueba[] };
  viajes?: ViajePrueba[];
  cuentasCorreo?: CuentaCorreoPrueba[];
  whitelist?: {
    remitentesPermitidos: string[];
    filtrosActivos: boolean;
    actualizadoEn?: string | null;
  };
  perfil?: {
    nombre?: string;
    idioma?: 'es' | 'en';
    moneda?: string;
    agenciaPreferida?: string | null;
  };
  designados?: Record<string, DesignadoPrueba[]>;
  agenciasConfiguradas?: string[];
}

function subDelHeader(auth: string | undefined): string | undefined {
  if (!auth?.startsWith('Bearer ')) return undefined;
  const carga = auth.slice(7).split('.')[1];
  if (!carga) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(carga, 'base64url').toString('utf8')) as { sub?: string };
    return parsed.sub;
  } catch {
    return undefined;
  }
}

function redireccionHtml(destino: string) {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: `<!doctype html><html><head><meta charset="utf-8"><script>location.replace(${JSON.stringify(destino)});</script></head><body></body></html>`,
  };
}

function pantallaOAuthHtml(proveedor: 'gmail' | 'outlook', state: string, emailSugerido: string) {
  const titulo = proveedor === 'gmail' ? 'Acceder con Google' : 'Iniciar sesión en Microsoft';
  const accion =
    proveedor === 'gmail'
      ? `${URL_MOCK_GMAIL}/o/oauth2/v2/auth/decision`
      : `${URL_MOCK_OUTLOOK}/common/oauth2/v2.0/authorize/decision`;
  return `<!doctype html>
<html lang="es">
  <head><meta charset="utf-8"><title>${titulo}</title></head>
  <body>
    <h1>${titulo}</h1>
    <form method="get" action="${accion}">
      <input type="hidden" name="state" value="${state}">
      <label>Cuenta <input name="email" type="email" value="${emailSugerido}" required></label>
      <button type="submit" name="decision" value="cancelar">Cancelar</button>
      <button type="submit" name="decision" value="permitir">Permitir</button>
    </form>
  </body>
</html>`;
}

export async function apiFalsa(page: Page, opciones: OpcionesApiFalsa = {}) {
  const cuentas = [...(opciones.cuentas ?? [usuaria, analista])];
  const cuentasCorreo = [...(opciones.cuentasCorreo ?? [])];
  const whitelist = {
    usuarioId: subDe(usuaria.email),
    remitentesPermitidos: [...(opciones.whitelist?.remitentesPermitidos ?? [])],
    filtrosActivos: opciones.whitelist?.filtrosActivos ?? false,
    actualizadoEn: opciones.whitelist?.actualizadoEn ?? null,
  };
  const perfil = {
    usuarioId: subDe(usuaria.email),
    email: usuaria.email,
    nombre: opciones.perfil?.nombre ?? 'Ana Pérez',
    region: usuaria.region,
    idioma: opciones.perfil?.idioma ?? usuaria.idioma,
    moneda: opciones.perfil?.moneda ?? 'ARS',
    agenciaPreferida: opciones.perfil?.agenciaPreferida ?? null,
    creadoEn: '2026-11-01T12:00:00Z',
  };
  const viajesLista: ViajePrueba[] = [
    ...(opciones.panel?.viajes ?? []),
    ...(opciones.viajes ?? []),
  ];
  const designadosPorViaje: Record<string, DesignadoPrueba[]> = Object.fromEntries(
    Object.entries(opciones.designados ?? {}).map(([id, lista]) => [id, [...lista]]),
  );
  const agenciasValidas = new Set(opciones.agenciasConfiguradas ?? ['viajes-del-plata']);
  const statesOAuth = new Map<string, 'gmail' | 'outlook'>();

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

  const manejarMockOAuth =
    (proveedor: 'gmail' | 'outlook') =>
    async (route: Parameters<Parameters<Page['route']>[1]>[0]) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname.endsWith('/decision')) {
        const state = url.searchParams.get('state') ?? '';
        const decision = url.searchParams.get('decision') ?? 'cancelar';
        const email = (url.searchParams.get('email') ?? `${proveedor}@${proveedor}.example`).trim();
        const cb = new URL(`${URL_API}/${perfil.region}/api/correo/oauth/callback`);
        cb.searchParams.set('state', state);
        if (decision === 'permitir') {
          cb.searchParams.set('code', `codigo_${email}`);
        } else {
          cb.searchParams.set('error', 'access_denied');
        }
        return route.fulfill(redireccionHtml(cb.toString()));
      }
      const state = url.searchParams.get('state') ?? '';
      const emailSugerido =
        proveedor === 'gmail' ? 'ana.garcia@gmail.example' : 'ana.garcia@outlook.example';
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: pantallaOAuthHtml(proveedor, state, emailSugerido),
      });
    };

  await page.route(`${URL_MOCK_GMAIL}/**`, manejarMockOAuth('gmail'));
  await page.route(`${URL_MOCK_OUTLOOK}/**`, manejarMockOAuth('outlook'));

  await page.route(`${URL_API}/**`, async (route) => {
    const pedido = route.request();
    if (pedido.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (sinRed) return route.abort('internetdisconnected');
    const url = new URL(pedido.url());
    const ruta = url.pathname;
    const headers = await pedido.allHeaders();
    const cuerpo: unknown = pedido.postData() ? pedido.postDataJSON() : undefined;
    pedidos.push({ metodo: pedido.method(), ruta, headers, cuerpo });
    const datos = (cuerpo ?? {}) as Record<string, unknown>;
    const subActual = subDelHeader(headers.authorization) ?? perfil.usuarioId;

    if (pedido.method() === 'GET' && /\/api\/correo\/oauth\/callback$/.test(ruta)) {
      const state = url.searchParams.get('state') ?? '';
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code') ?? '';
      const proveedor = statesOAuth.get(state) ?? 'gmail';
      statesOAuth.delete(state);

      if (error) {
        return route.fulfill(
          redireccionHtml(`${ORIGEN_WEB}/correo?resultado=error&motivo=permiso-denegado`),
        );
      }
      const emailConectado = code.startsWith('codigo_')
        ? code.slice('codigo_'.length)
        : `usuario@${proveedor}.example`;
      const id = randomUUID();
      const idx = cuentasCorreo.findIndex(
        (c) => c.proveedorCorreo === proveedor && c.email === emailConectado,
      );
      const nueva: CuentaCorreoPrueba = {
        id,
        proveedorCorreo: proveedor,
        email: emailConectado,
        estado: 'conectada',
        conectadaEn: new Date().toISOString(),
        ultimaRevision: null,
      };
      if (idx >= 0) cuentasCorreo[idx] = nueva;
      else cuentasCorreo.push(nueva);
      return route.fulfill(
        redireccionHtml(`${ORIGEN_WEB}/correo?resultado=conectada&cuentaId=${id}`),
      );
    }

    const matchConectar = /^\/api\/correo\/cuentas-correo\/(gmail|outlook)\/conectar$/.exec(ruta);
    if (pedido.method() === 'POST' && matchConectar) {
      const proveedor = matchConectar[1] as 'gmail' | 'outlook';
      const state = randomUUID();
      statesOAuth.set(state, proveedor);
      const urlAutorizacion =
        proveedor === 'gmail'
          ? `${URL_MOCK_GMAIL}/o/oauth2/v2/auth?state=${state}`
          : `${URL_MOCK_OUTLOOK}/common/oauth2/v2.0/authorize?state=${state}`;
      return route.fulfill(
        responder(200, {
          proveedorCorreo: proveedor,
          urlAutorizacion,
          stateVenceEn: '2026-12-01T12:00:00Z',
        }),
      );
    }

    const matchEliminarCorreo = /^\/api\/correo\/cuentas-correo\/([^/]+)$/.exec(ruta);
    if (pedido.method() === 'DELETE' && matchEliminarCorreo) {
      const id = matchEliminarCorreo[1];
      const idx = cuentasCorreo.findIndex((c) => c.id === id);
      if (idx < 0) return route.fulfill(problema(404, 'Cuenta no encontrada'));
      cuentasCorreo.splice(idx, 1);
      return route.fulfill({ status: 204, headers: cors });
    }

    const matchViaje = /^\/api\/viajes\/viajes\/([^/]+)$/.exec(ruta);
    if (pedido.method() === 'GET' && matchViaje) {
      const viaje = viajesLista.find((v) => v.viajeId === matchViaje[1]);
      if (!viaje) return route.fulfill(problema(404, 'Viaje no encontrado'));
      const designados = designadosPorViaje[viaje.viajeId] ?? [];
      const esDesignado = designados.some((d) => d.usuarioId === subActual);
      if (viaje.usuarioId !== subActual && !esDesignado) {
        return route.fulfill(problema(403, 'Prohibido'));
      }
      return route.fulfill(responder(200, viaje));
    }

    const matchDesignados = /^\/api\/usuarios\/itinerarios\/([^/]+)\/designados$/.exec(ruta);
    if (matchDesignados) {
      const viajeId = matchDesignados[1] ?? '';
      const viaje = viajesLista.find((v) => v.viajeId === viajeId);
      if (viaje && viaje.usuarioId !== subActual) {
        return route.fulfill(problema(403, 'Solo el dueño puede gestionar designados'));
      }
      const lista = (designadosPorViaje[viajeId] ??= []);
      if (pedido.method() === 'GET') {
        return route.fulfill(responder(200, { viajeId, designados: lista }));
      }
      if (pedido.method() === 'POST') {
        const email = String(datos.email ?? '')
          .trim()
          .toLowerCase();
        if (!email || email === perfil.email.toLowerCase()) {
          return route.fulfill(problema(400, 'Email inválido o igual al del dueño'));
        }
        if (lista.some((d) => d.email === email)) {
          return route.fulfill(problema(409, 'La persona ya está designada'));
        }
        const cuentaExistente = cuentas.find((c) => c.email.toLowerCase() === email);
        const nuevo: DesignadoPrueba = {
          email,
          usuarioId: cuentaExistente ? subDe(cuentaExistente.email) : null,
          designadoEn: new Date().toISOString(),
        };
        lista.push(nuevo);
        return route.fulfill(responder(201, nuevo));
      }
    }

    const matchQuitarDesignado =
      /^\/api\/usuarios\/itinerarios\/([^/]+)\/designados\/([^/]+)$/.exec(ruta);
    if (pedido.method() === 'DELETE' && matchQuitarDesignado) {
      const viajeId = matchQuitarDesignado[1] ?? '';
      const email = decodeURIComponent(matchQuitarDesignado[2] ?? '').toLowerCase();
      const viaje = viajesLista.find((v) => v.viajeId === viajeId);
      if (viaje && viaje.usuarioId !== subActual) {
        return route.fulfill(problema(403, 'Solo el dueño puede quitar designados'));
      }
      const lista = designadosPorViaje[viajeId] ?? [];
      const idx = lista.findIndex((d) => d.email === email);
      if (idx < 0) return route.fulfill(problema(404, 'No encontrado'));
      lista.splice(idx, 1);
      return route.fulfill({ status: 204, headers: cors });
    }

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
          email: String(datos.email ?? ''),
          contrasena: String(datos.contrasena ?? ''),
          region: datos.region === 'region-1' ? 'region-1' : 'region-2',
          roles: ['usuario'],
          idioma: datos.idioma === 'en' ? 'en' : 'es',
        });
        return route.fulfill(responder(201, { usuarioId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }));
      }
      case 'POST /api/autenticacion/logout':
        return route.fulfill({ status: 204, headers: cors });
      case 'GET /api/correo/cuentas-correo':
        return route.fulfill(responder(200, { cuentas: cuentasCorreo }));
      case 'GET /api/usuarios/whitelist':
        return route.fulfill(responder(200, whitelist));
      case 'PUT /api/usuarios/whitelist': {
        const lista = Array.isArray(datos.remitentesPermitidos)
          ? [
              ...new Set(
                datos.remitentesPermitidos
                  .map((r) => String(r).trim().toLowerCase())
                  .filter(Boolean),
              ),
            ]
          : [];
        whitelist.remitentesPermitidos = lista;
        whitelist.filtrosActivos = Boolean(datos.filtrosActivos);
        whitelist.actualizadoEn = new Date().toISOString();
        return route.fulfill(responder(200, whitelist));
      }
      case 'GET /api/usuarios/perfil':
        return route.fulfill(responder(200, perfil));
      case 'PATCH /api/usuarios/perfil': {
        if (
          datos.agenciaPreferida !== undefined &&
          datos.agenciaPreferida !== null &&
          !agenciasValidas.has(String(datos.agenciaPreferida))
        ) {
          return route.fulfill(problema(400, 'Agencia desconocida'));
        }
        if (datos.idioma === 'es' || datos.idioma === 'en') perfil.idioma = datos.idioma;
        if (typeof datos.moneda === 'string') perfil.moneda = datos.moneda;
        if (datos.agenciaPreferida === null || typeof datos.agenciaPreferida === 'string') {
          perfil.agenciaPreferida = datos.agenciaPreferida;
        }
        if (typeof datos.nombre === 'string') perfil.nombre = datos.nombre;
        return route.fulfill(responder(200, perfil));
      }
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
