// API falsa para las pruebas de la web: responde como el enrutador global según los contratos de
// Autenticación, Usuarios, Correo, Viajes y Analítica, más mocks de OAuth de Gmail/Outlook, y
// anota cada solicitud.
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

export interface ReservaPrueba {
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
}

export interface ViajePrueba {
  viajeId: string;
  usuarioId: string;
  destino: string;
  inicio: string;
  fin: string;
  estado: 'activo' | 'archivado';
  reservas: ReservaPrueba[];
}

export interface OpcionesAnaliticaPrueba {
  destinos?: {
    desde: string;
    hasta: string;
    totalReservas: number;
    destinos: { destino: string; reservas: number; proporcion: number }[];
    generadoEn: string;
  };
  cancelaciones?: {
    desde: string;
    hasta: string;
    agruparPor: 'proveedor' | 'destino';
    total: { reservas: number; canceladas: number; tasaCancelacion: number };
    grupos: { clave: string; reservas: number; canceladas: number; tasaCancelacion: number }[];
    generadoEn: string;
  };
  tendencias?: {
    anio: number;
    agruparPor: 'mes';
    periodos: {
      mes: number;
      reservas: number;
      canceladas: number;
      porTipoReserva: { vuelo: number; hotel: number; auto: number };
    }[];
    generadoEn: string;
  };
  /** Cantidad de sondeos en `enCurso` antes de pasar a `terminada` (por defecto 1). */
  sondeosEnCurso?: number;
  /** Si se define, la próxima ejecución Map-Reduce terminará en estado `fallida` con este mensaje. */
  fallarEjecucionCon?: string;
  /** Si se define, POST /consultas/:tipo/ejecutar devuelve 409 apuntando a este consultaId. */
  conflictoConConsultaId?: string;
}

export interface OpcionReprogramacionPrueba {
  opcionId: string;
  proveedor: string;
  numeroReserva: string;
  tipoReserva: 'vuelo' | 'hotel' | 'auto';
  inicio: string;
  fin: string;
  origen?: string;
  destino: string;
  descripcion?: string;
}

export interface ReservaResumenPrueba {
  proveedor: string;
  numeroReserva: string;
  tipoReserva: 'vuelo' | 'hotel' | 'auto';
  estado: 'confirmada' | 'modificada' | 'cancelada';
  inicio: string;
  fin: string;
  origen?: string;
  destino: string;
}

export interface OpcionesAsistentePrueba {
  /** Si es true, GET /api/asistente/health responde 503. */
  caido?: boolean;
  /** Si es true (o número > 0), POST /mensajes responde 503. */
  fallarMensajes?: boolean | number;
  /** Reservas devueltas al consultar estado. */
  reservasEstado?: ReservaResumenPrueba[];
  /** Opciones devueltas al pedir reprogramación. */
  opcionesReprogramacion?: OpcionReprogramacionPrueba[];
  /** Si es true, pedir reprogramación responde 202 consultando y entrega opciones tras `sondeosHastaRespuesta` polls. */
  reprogramacionLenta?: boolean;
  /** Cantidad de polls en `consultando: true` antes de entregar la respuesta final (por defecto 2). */
  sondeosHastaRespuesta?: number;
  /** Si es true, POST /api/integraciones/agencias/casos responde 503. */
  fallarAgencia?: boolean;
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
  /** Respuesta inicial de GET /api/viajes/panel (por defecto { viajes: [] }). */
  panel?: { viajes: ViajePrueba[] };
  /** Respuesta de GET /api/viajes/archivados (por defecto []). */
  archivados?: ViajePrueba[];
  /** Otros viajes alcanzables por GET /api/viajes/viajes/:id (p. ej. compartidos por terceros). */
  viajes?: ViajePrueba[];
  /** Si es true, POST /viajes/:id/compartir-red responde 503. */
  fallarRedSocial?: boolean;
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
  analitica?: OpcionesAnaliticaPrueba;
  asistente?: OpcionesAsistentePrueba;
}

interface ClaimsSimulados {
  sub?: string;
  roles?: string[];
}

function claimsDelHeader(auth: string | undefined): ClaimsSimulados {
  if (!auth?.startsWith('Bearer ')) return {};
  const carga = auth.slice(7).split('.')[1];
  if (!carga) return {};
  try {
    return JSON.parse(Buffer.from(carga, 'base64url').toString('utf8')) as ClaimsSimulados;
  } catch {
    return {};
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

function recalcularViaje(viaje: ViajePrueba) {
  viaje.reservas.sort((a, b) => new Date(a.inicio).getTime() - new Date(b.inicio).getTime());
  const primera = viaje.reservas[0];
  const ultima = viaje.reservas.reduce<ReservaPrueba | undefined>(
    (acc, r) => (!acc || new Date(r.fin).getTime() > new Date(acc.fin).getTime() ? r : acc),
    undefined,
  );
  if (primera && ultima) {
    viaje.inicio = primera.inicio;
    viaje.fin = ultima.fin;
    viaje.destino = primera.destino;
  }
}

function resultadoDestinosDefecto(desde: string, hasta: string, limite: number) {
  const todos = [
    { destino: 'Santiago (SCL)', reservas: 1840, proporcion: 0.46 },
    { destino: 'Madrid (MAD)', reservas: 1200, proporcion: 0.3 },
    { destino: 'Bariloche (BRC)', reservas: 960, proporcion: 0.24 },
  ];
  return {
    desde,
    hasta,
    totalReservas: 4000,
    destinos: todos.slice(0, limite),
    generadoEn: '2026-11-18T18:00:00Z',
  };
}

function resultadoCancelacionesDefecto(
  desde: string,
  hasta: string,
  agruparPor: 'proveedor' | 'destino',
) {
  const grupos =
    agruparPor === 'proveedor'
      ? [
          { clave: 'aerolinea-andina', reservas: 2500, canceladas: 300, tasaCancelacion: 0.12 },
          { clave: 'hotel-cordillera', reservas: 1500, canceladas: 90, tasaCancelacion: 0.06 },
        ]
      : [
          { clave: 'Santiago (SCL)', reservas: 2000, canceladas: 260, tasaCancelacion: 0.13 },
          { clave: 'Madrid (MAD)', reservas: 2000, canceladas: 130, tasaCancelacion: 0.065 },
        ];
  return {
    desde,
    hasta,
    agruparPor,
    total: { reservas: 4000, canceladas: 390, tasaCancelacion: 0.0975 },
    grupos,
    generadoEn: '2026-11-18T18:00:00Z',
  };
}

function resultadoTendenciasDefecto(anio: number) {
  return {
    anio,
    agruparPor: 'mes' as const,
    periodos: Array.from({ length: 12 }, (_, idx) => {
      const mes = idx + 1;
      const vuelo = 100 + mes * 10;
      const hotel = 60 + mes * 5;
      const auto = 20 + mes * 2;
      return {
        mes,
        reservas: vuelo + hotel + auto,
        canceladas: 10 + mes,
        porTipoReserva: { vuelo, hotel, auto },
      };
    }),
    generadoEn: '2026-11-18T18:00:00Z',
  };
}

interface EjecucionInterna {
  consultaId: string;
  tipo: 'destinos' | 'cancelaciones' | 'tendencias';
  parametros: Record<string, unknown>;
  estado: 'pendiente' | 'enCurso' | 'terminada' | 'fallida';
  procesadores: number;
  progreso: number;
  creadaEn: string;
  iniciadaEn?: string;
  terminadaEn?: string;
  duracionMs?: number;
  resultado?: unknown;
  error?: string;
  sondeosRestantes: number;
  fallarCon?: string;
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

  let panelViajes: ViajePrueba[] = (opciones.panel?.viajes ?? []).map((v) => ({
    ...v,
    reservas: v.reservas.map((r) => ({ ...r, detalle: { ...r.detalle } })),
  }));
  const archivadosViajes: ViajePrueba[] = (opciones.archivados ?? []).map((v) => ({
    ...v,
    reservas: v.reservas.map((r) => ({ ...r, detalle: { ...r.detalle } })),
  }));
  const viajesExtra: ViajePrueba[] = (opciones.viajes ?? []).map((v) => ({
    ...v,
    reservas: v.reservas.map((r) => ({ ...r, detalle: { ...r.detalle } })),
  }));

  const todosLosViajes = () => [...panelViajes, ...archivadosViajes, ...viajesExtra];

  const designadosPorViaje: Record<string, DesignadoPrueba[]> = Object.fromEntries(
    Object.entries(opciones.designados ?? {}).map(([id, lista]) => [id, [...lista]]),
  );
  const agenciasValidas = new Set(opciones.agenciasConfiguradas ?? ['viajes-del-plata']);
  const statesOAuth = new Map<string, 'gmail' | 'outlook'>();
  const ejecuciones = new Map<string, EjecucionInterna>();

  interface MensajePrueba {
    mensajeId: string;
    secuencia: number;
    autor: 'usuario' | 'asistente';
    texto: string;
    enviadoEn: string;
    intencion?: 'estado' | 'reprogramar' | 'problemaMenor' | 'derivar' | 'desconocida';
    resultado?:
      | 'respondido'
      | 'repregunta'
      | 'consultando'
      | 'opciones'
      | 'reprogramado'
      | 'opcionRechazada'
      | 'derivado'
      | 'noDisponible';
    confirmacion?: { opcionId: string };
    reservas?: ReservaResumenPrueba[];
    opciones?: OpcionReprogramacionPrueba[];
    caso?: { agencia: string; numeroCaso: string };
    noDisponible?: {
      funcion: 'estado' | 'reprogramar' | 'derivar';
      servicio: 'viajes' | 'usuarios' | 'integraciones' | 'proveedor' | 'agencia';
    };
    ofreceDerivar?: boolean;
  }

  interface ConversacionInterna {
    conversacionId: string;
    usuarioId: string;
    region: 'region-1' | 'region-2';
    idioma: 'es' | 'en';
    creadaEn: string;
    actualizadaEn: string;
    consultando: boolean;
    mensajes: MensajePrueba[];
    opcionesPendientes: OpcionReprogramacionPrueba[];
    pendientePoll?: {
      sondeosRestantes: number;
      mensajeFinal: Omit<MensajePrueba, 'mensajeId' | 'secuencia' | 'enviadoEn'>;
      opcionesFinales?: OpcionReprogramacionPrueba[];
    };
  }

  let asistenteCaido = opciones.asistente?.caido ?? false;
  let fallarMensajesRestantes =
    typeof opciones.asistente?.fallarMensajes === 'number'
      ? opciones.asistente.fallarMensajes
      : opciones.asistente?.fallarMensajes
        ? Number.POSITIVE_INFINITY
        : 0;
  const conversaciones = new Map<string, ConversacionInterna>();
  let contadorCasosAgencia = 35436;

  const reservasEstadoDefecto: ReservaResumenPrueba[] = opciones.asistente?.reservasEstado ?? [
    {
      proveedor: 'aerolinea-andina',
      numeroReserva: 'XKQ7PL',
      tipoReserva: 'vuelo',
      estado: 'confirmada',
      inicio: '2026-12-10T08:30:00Z',
      fin: '2026-12-10T10:40:00Z',
      origen: 'EZE',
      destino: 'SCL',
    },
  ];

  const opcionesReprogDefecto: OpcionReprogramacionPrueba[] = opciones.asistente
    ?.opcionesReprogramacion ?? [
    {
      opcionId: 'ocr_XKQ7PL_1',
      proveedor: 'aerolinea-andina',
      numeroReserva: 'XKQ7PL',
      tipoReserva: 'vuelo',
      inicio: '2026-12-10T14:00:00Z',
      fin: '2026-12-10T16:10:00Z',
      origen: 'EZE',
      destino: 'SCL',
      descripcion: '10 de diciembre, 14:00, sin cargo',
    },
    {
      opcionId: 'ocr_XKQ7PL_2',
      proveedor: 'aerolinea-andina',
      numeroReserva: 'XKQ7PL',
      tipoReserva: 'vuelo',
      inicio: '2026-12-11T09:15:00Z',
      fin: '2026-12-11T11:25:00Z',
      origen: 'EZE',
      destino: 'SCL',
      descripcion: '11 de diciembre, 09:15, sin cargo',
    },
  ];

  function agregarMensajeConv(
    conv: ConversacionInterna,
    parcial: Omit<MensajePrueba, 'mensajeId' | 'secuencia' | 'enviadoEn'>,
  ): MensajePrueba {
    const ahora = new Date().toISOString();
    const secuencia = (conv.mensajes.at(-1)?.secuencia ?? 0) + 1;
    const msg: MensajePrueba = {
      mensajeId: randomUUID(),
      secuencia,
      enviadoEn: ahora,
      ...parcial,
    };
    conv.mensajes.push(msg);
    conv.actualizadaEn = ahora;
    return msg;
  }

  if (opciones.analitica?.conflictoConConsultaId) {
    const id = opciones.analitica.conflictoConConsultaId;
    ejecuciones.set(id, {
      consultaId: id,
      tipo: 'destinos',
      parametros: { desde: '2025-01-01', hasta: '2025-12-31', limite: 10 },
      estado: 'enCurso',
      procesadores: 8,
      progreso: 0.5,
      creadaEn: '2026-11-18T17:59:00Z',
      iniciadaEn: '2026-11-18T17:59:01Z',
      sondeosRestantes: 1,
    });
  }

  const pedidos: Pedido[] = [];
  let sinRed = false;
  const cors = {
    'access-control-allow-origin': ORIGEN_WEB,
    'access-control-allow-headers': 'Authorization, Content-Type, X-Request-Id, X-Region',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
    'access-control-expose-headers': 'X-Request-Id, Location, Retry-After, X-Origen-Dato',
  };
  const responder = (status: number, datos?: unknown, extraHeaders?: Record<string, string>) => ({
    status,
    headers: { ...cors, 'content-type': 'application/json', ...extraHeaders },
    ...(datos === undefined ? {} : { body: JSON.stringify(datos) }),
  });
  const problema = (status: number, title: string, detail?: string) =>
    responder(status, {
      type: 'https://trotamundos.example/errores/x',
      title,
      status,
      ...(detail ? { detail } : {}),
      requestId: randomUUID(),
    });

  const calcularResultadoAnalitica = (
    tipo: 'destinos' | 'cancelaciones' | 'tendencias',
    params: Record<string, unknown>,
  ) => {
    if (tipo === 'destinos') {
      if (opciones.analitica?.destinos) return opciones.analitica.destinos;
      return resultadoDestinosDefecto(
        String(params.desde ?? '2025-01-01'),
        String(params.hasta ?? '2025-12-31'),
        Number(params.limite ?? 10),
      );
    }
    if (tipo === 'cancelaciones') {
      if (opciones.analitica?.cancelaciones) return opciones.analitica.cancelaciones;
      return resultadoCancelacionesDefecto(
        String(params.desde ?? '2025-01-01'),
        String(params.hasta ?? '2025-12-31'),
        params.agruparPor === 'destino' ? 'destino' : 'proveedor',
      );
    }
    if (opciones.analitica?.tendencias) return opciones.analitica.tendencias;
    return resultadoTendenciasDefecto(Number(params.anio ?? 2025));
  };

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
    const claims = claimsDelHeader(headers.authorization);
    const subActual = claims.sub ?? perfil.usuarioId;
    const rolesActuales = claims.roles ?? [];

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

    const matchCompartirRed = /^\/api\/viajes\/viajes\/([^/]+)\/compartir-red$/.exec(ruta);
    if (pedido.method() === 'POST' && matchCompartirRed) {
      const viaje = todosLosViajes().find((v) => v.viajeId === matchCompartirRed[1]);
      if (!viaje) return route.fulfill(problema(404, 'Viaje no encontrado'));
      if (viaje.usuarioId !== subActual) return route.fulfill(problema(403, 'Prohibido'));
      if (opciones.fallarRedSocial) {
        return route.fulfill(problema(503, 'Red social no disponible'));
      }
      return route.fulfill(
        responder(201, {
          red: String(datos.red ?? 'redsocial'),
          url: `https://redsocial.example/@ana/publicacion-${viaje.viajeId.slice(0, 8)}`,
          publicadaEn: '2026-11-18T18:30:00Z',
        }),
      );
    }

    const matchViaje = /^\/api\/viajes\/viajes\/([^/]+)$/.exec(ruta);
    if (pedido.method() === 'GET' && matchViaje) {
      const viaje = todosLosViajes().find((v) => v.viajeId === matchViaje[1]);
      if (!viaje) return route.fulfill(problema(404, 'Viaje no encontrado'));
      const designados = designadosPorViaje[viaje.viajeId] ?? [];
      const esDesignado = designados.some((d) => d.usuarioId === subActual);
      if (viaje.usuarioId !== subActual && !esDesignado) {
        return route.fulfill(problema(403, 'Prohibido'));
      }
      return route.fulfill(responder(200, viaje));
    }

    const matchReserva = /^\/api\/viajes\/reservas\/([^/]+)$/.exec(ruta);
    if (matchReserva) {
      const reservaId = matchReserva[1] ?? '';
      const viajeArchivado = archivadosViajes.find((v) =>
        v.reservas.some((r) => r.reservaId === reservaId),
      );
      if (viajeArchivado) {
        return route.fulfill(problema(409, 'Viaje archivado'));
      }
      const viajeOrigen = panelViajes.find((v) =>
        v.reservas.some((r) => r.reservaId === reservaId),
      );
      if (!viajeOrigen) return route.fulfill(problema(404, 'Reserva no encontrada'));
      const idxReserva = viajeOrigen.reservas.findIndex((r) => r.reservaId === reservaId);
      const actual = viajeOrigen.reservas[idxReserva];
      if (!actual) return route.fulfill(problema(404, 'Reserva no encontrada'));

      if (pedido.method() === 'PATCH') {
        const nuevoInicio = typeof datos.inicio === 'string' ? datos.inicio : actual.inicio;
        const nuevoFin = typeof datos.fin === 'string' ? datos.fin : actual.fin;
        if (new Date(nuevoFin).getTime() < new Date(nuevoInicio).getTime()) {
          return route.fulfill(problema(409, 'Fin anterior a inicio'));
        }
        const destinoViajeId = typeof datos.viajeId === 'string' ? datos.viajeId : actual.viajeId;
        const viajeDestino = panelViajes.find((v) => v.viajeId === destinoViajeId);
        if (!viajeDestino) return route.fulfill(problema(404, 'Viaje destino no encontrado'));

        const actualizada: ReservaPrueba = {
          ...actual,
          viajeId: viajeDestino.viajeId,
          inicio: nuevoInicio,
          fin: nuevoFin,
          ...(typeof datos.origen === 'string' ? { origen: datos.origen } : {}),
          destino: typeof datos.destino === 'string' ? datos.destino : actual.destino,
          estado:
            datos.estado === 'confirmada' ||
            datos.estado === 'modificada' ||
            datos.estado === 'cancelada'
              ? datos.estado
              : actual.estado,
          detalle:
            datos.detalle && typeof datos.detalle === 'object'
              ? (datos.detalle as Record<string, unknown>)
              : actual.detalle,
          origenCambio: 'manual',
          actualizadoEn: new Date().toISOString(),
        };

        if (viajeDestino.viajeId === viajeOrigen.viajeId) {
          viajeOrigen.reservas[idxReserva] = actualizada;
          recalcularViaje(viajeOrigen);
        } else {
          viajeOrigen.reservas.splice(idxReserva, 1);
          viajeDestino.reservas.push(actualizada);
          recalcularViaje(viajeDestino);
          if (viajeOrigen.reservas.length === 0) {
            panelViajes = panelViajes.filter((v) => v.viajeId !== viajeOrigen.viajeId);
          } else {
            recalcularViaje(viajeOrigen);
          }
        }
        return route.fulfill(responder(200, actualizada));
      }

      if (pedido.method() === 'DELETE') {
        viajeOrigen.reservas.splice(idxReserva, 1);
        if (viajeOrigen.reservas.length === 0) {
          panelViajes = panelViajes.filter((v) => v.viajeId !== viajeOrigen.viajeId);
        } else {
          recalcularViaje(viajeOrigen);
        }
        return route.fulfill({ status: 204, headers: cors });
      }
    }

    const matchDesignados = /^\/api\/usuarios\/itinerarios\/([^/]+)\/designados$/.exec(ruta);
    if (matchDesignados) {
      const viajeId = matchDesignados[1] ?? '';
      const viaje = todosLosViajes().find((v) => v.viajeId === viajeId);
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
      const viaje = todosLosViajes().find((v) => v.viajeId === viajeId);
      if (viaje && viaje.usuarioId !== subActual) {
        return route.fulfill(problema(403, 'Solo el dueño puede quitar designados'));
      }
      const lista = designadosPorViaje[viajeId] ?? [];
      const idx = lista.findIndex((d) => d.email === email);
      if (idx < 0) return route.fulfill(problema(404, 'No encontrado'));
      lista.splice(idx, 1);
      return route.fulfill({ status: 204, headers: cors });
    }

    const matchEjecutarAnalitica =
      /^\/api\/analitica\/consultas\/(destinos|cancelaciones|tendencias)\/ejecutar$/.exec(ruta);
    if (pedido.method() === 'POST' && matchEjecutarAnalitica) {
      if (!rolesActuales.includes('analista')) return route.fulfill(problema(403, 'Prohibido'));
      const tipo = matchEjecutarAnalitica[1] as 'destinos' | 'cancelaciones' | 'tendencias';
      if (opciones.analitica?.conflictoConConsultaId) {
        return route.fulfill(
          problema(
            409,
            'Consulta ya en curso',
            `Ya se está ejecutando la consulta ${opciones.analitica.conflictoConConsultaId} con los mismos parámetros.`,
          ),
        );
      }
      const consultaId = randomUUID();
      const creadaEn = new Date().toISOString();
      const procesadores = typeof datos.procesadores === 'number' ? datos.procesadores : 4;
      ejecuciones.set(consultaId, {
        consultaId,
        tipo,
        parametros: datos,
        estado: 'pendiente',
        procesadores,
        progreso: 0,
        creadaEn,
        sondeosRestantes: opciones.analitica?.sondeosEnCurso ?? 1,
        ...(opciones.analitica?.fallarEjecucionCon
          ? { fallarCon: opciones.analitica.fallarEjecucionCon }
          : {}),
      });
      return route.fulfill(
        responder(
          202,
          { consultaId, tipo, estado: 'pendiente', creadaEn },
          { Location: `/api/analitica/consultas/ejecuciones/${consultaId}` },
        ),
      );
    }

    const matchEjecucionAnalitica = /^\/api\/analitica\/consultas\/ejecuciones\/([^/]+)$/.exec(
      ruta,
    );
    if (pedido.method() === 'GET' && matchEjecucionAnalitica) {
      if (!rolesActuales.includes('analista')) return route.fulfill(problema(403, 'Prohibido'));
      const consultaId = matchEjecucionAnalitica[1] ?? '';
      const ej = ejecuciones.get(consultaId);
      if (!ej) return route.fulfill(problema(404, 'Ejecución no encontrada'));

      if (ej.estado === 'pendiente' || ej.estado === 'enCurso') {
        if (ej.sondeosRestantes > 0) {
          ej.sondeosRestantes -= 1;
          ej.estado = 'enCurso';
          ej.iniciadaEn ??= new Date().toISOString();
          ej.progreso = 0.5;
        } else if (ej.fallarCon) {
          ej.estado = 'fallida';
          ej.iniciadaEn ??= new Date().toISOString();
          ej.terminadaEn = new Date().toISOString();
          ej.duracionMs = 210;
          ej.error = ej.fallarCon;
        } else {
          ej.estado = 'terminada';
          ej.iniciadaEn ??= new Date().toISOString();
          ej.terminadaEn = new Date().toISOString();
          ej.progreso = 1;
          ej.duracionMs = 420;
          ej.resultado = calcularResultadoAnalitica(ej.tipo, ej.parametros);
        }
      }

      const respuesta = {
        consultaId: ej.consultaId,
        tipo: ej.tipo,
        parametros: ej.parametros,
        estado: ej.estado,
        procesadores: ej.procesadores,
        progreso: ej.progreso,
        creadaEn: ej.creadaEn,
        ...(ej.iniciadaEn ? { iniciadaEn: ej.iniciadaEn } : {}),
        ...(ej.terminadaEn ? { terminadaEn: ej.terminadaEn } : {}),
        ...(ej.duracionMs !== undefined ? { duracionMs: ej.duracionMs } : {}),
        ...(ej.resultado !== undefined ? { resultado: ej.resultado } : {}),
        ...(ej.error ? { error: ej.error } : {}),
      };
      return route.fulfill(responder(200, respuesta));
    }

    const matchConvMensajes = /^\/api\/asistente\/conversaciones\/([^/]+)\/mensajes$/.exec(ruta);
    if (matchConvMensajes) {
      const convId = matchConvMensajes[1] ?? '';
      const conv = conversaciones.get(convId);
      if (asistenteCaido) {
        return route.fulfill(problema(503, 'Asistente no disponible'));
      }
      if (!conv || conv.usuarioId !== subActual) {
        return route.fulfill(problema(404, 'Conversación no encontrada'));
      }

      if (pedido.method() === 'GET') {
        if (fallarMensajesRestantes > 0) {
          fallarMensajesRestantes -= 1;
          return route.fulfill(problema(503, 'Asistente no disponible'));
        }
        const desde = Number(url.searchParams.get('desde') ?? '0');
        if (conv.consultando && conv.pendientePoll) {
          conv.pendientePoll.sondeosRestantes -= 1;
          if (conv.pendientePoll.sondeosRestantes <= 0) {
            const entrega = conv.pendientePoll;
            conv.pendientePoll = undefined;
            conv.consultando = false;
            if (entrega.opcionesFinales) {
              conv.opcionesPendientes = entrega.opcionesFinales;
            }
            agregarMensajeConv(conv, entrega.mensajeFinal);
          }
        }
        const nuevos = conv.mensajes.filter((m) => m.secuencia > desde);
        return route.fulfill(
          responder(200, {
            mensajes: nuevos,
            consultando: conv.consultando,
            ultimaSecuencia: conv.mensajes.at(-1)?.secuencia ?? 0,
          }),
        );
      }

      if (pedido.method() === 'POST') {
        if (fallarMensajesRestantes > 0) {
          fallarMensajesRestantes -= 1;
          return route.fulfill(problema(503, 'Asistente no disponible'));
        }
        const textoUsuario = String(datos.texto ?? '').trim();
        const lower = textoUsuario.toLowerCase();
        const mensajeUsuario = agregarMensajeConv(conv, {
          autor: 'usuario',
          texto: textoUsuario,
        });

        if (
          lower.includes('reprogram') ||
          lower.includes('reschedul') ||
          lower.includes('cambiar')
        ) {
          if (opciones.asistente?.reprogramacionLenta) {
            const respuesta = agregarMensajeConv(conv, {
              autor: 'asistente',
              texto:
                conv.idioma === 'en'
                  ? 'I am checking with the airline for available options.'
                  : 'Estoy consultando con la aerolínea las opciones disponibles.',
              intencion: 'reprogramar',
              resultado: 'consultando',
            });
            conv.consultando = true;
            conv.pendientePoll = {
              sondeosRestantes: opciones.asistente.sondeosHastaRespuesta ?? 2,
              opcionesFinales: opcionesReprogDefecto,
              mensajeFinal: {
                autor: 'asistente',
                texto:
                  conv.idioma === 'en'
                    ? 'Here are the rescheduling options for your flight XKQ7PL.'
                    : 'Estas son las opciones de reprogramación para tu vuelo XKQ7PL.',
                intencion: 'reprogramar',
                resultado: 'opciones',
                opciones: opcionesReprogDefecto,
              },
            };
            return route.fulfill(
              responder(
                202,
                { estado: 'consultando', mensajeUsuario, respuesta },
                { 'Retry-After': '2' },
              ),
            );
          }

          conv.opcionesPendientes = opcionesReprogDefecto;
          const respuesta = agregarMensajeConv(conv, {
            autor: 'asistente',
            texto:
              conv.idioma === 'en'
                ? 'Here are the rescheduling options for your flight XKQ7PL.'
                : 'Estas son las opciones de reprogramación para tu vuelo XKQ7PL.',
            intencion: 'reprogramar',
            resultado: 'opciones',
            opciones: opcionesReprogDefecto,
          });
          return route.fulfill(responder(200, { estado: 'respondido', mensajeUsuario, respuesta }));
        }

        if (lower.includes('derivar') || lower.includes('agencia') || lower.includes('escalate')) {
          const numeroCaso = String(contadorCasosAgencia++);
          const agencia = perfil.agenciaPreferida ?? 'viajes-del-plata';
          const respuesta = agregarMensajeConv(conv, {
            autor: 'asistente',
            texto:
              conv.idioma === 'en'
                ? `I escalated your case #${numeroCaso} to ${agencia}.`
                : `Derivé tu consulta con el caso #${numeroCaso} a ${agencia}.`,
            intencion: 'derivar',
            resultado: 'derivado',
            caso: { agencia, numeroCaso },
          });
          return route.fulfill(responder(200, { estado: 'respondido', mensajeUsuario, respuesta }));
        }

        const respuesta = agregarMensajeConv(conv, {
          autor: 'asistente',
          texto:
            conv.idioma === 'en'
              ? 'Your flight XKQ7PL (EZE → SCL) is confirmed.'
              : 'Tu vuelo XKQ7PL (EZE → SCL) está confirmado.',
          intencion: 'estado',
          resultado: 'respondido',
          reservas: reservasEstadoDefecto,
        });
        return route.fulfill(responder(200, { estado: 'respondido', mensajeUsuario, respuesta }));
      }
    }

    const matchConvConfirmar = /^\/api\/asistente\/conversaciones\/([^/]+)\/confirmaciones$/.exec(
      ruta,
    );
    if (pedido.method() === 'POST' && matchConvConfirmar) {
      const conv = conversaciones.get(matchConvConfirmar[1] ?? '');
      if (asistenteCaido) return route.fulfill(problema(503, 'Asistente no disponible'));
      if (!conv || conv.usuarioId !== subActual) {
        return route.fulfill(problema(404, 'Conversación no encontrada'));
      }
      const opcionId = String(datos.opcionId ?? '');
      const elegida = conv.opcionesPendientes.find((o) => o.opcionId === opcionId);
      if (!elegida) {
        return route.fulfill(problema(409, 'La opción no está pendiente'));
      }
      conv.opcionesPendientes = [];
      const mensajeUsuario = agregarMensajeConv(conv, {
        autor: 'usuario',
        texto: elegida.descripcion ?? opcionId,
        confirmacion: { opcionId },
      });
      const respuesta = agregarMensajeConv(conv, {
        autor: 'asistente',
        texto:
          conv.idioma === 'en'
            ? `Rescheduling applied for ${elegida.numeroReserva} (${elegida.descripcion ?? opcionId}).`
            : `Reprogramación confirmada para ${elegida.numeroReserva} (${elegida.descripcion ?? opcionId}).`,
        intencion: 'reprogramar',
        resultado: 'reprogramado',
      });
      return route.fulfill(responder(200, { estado: 'respondido', mensajeUsuario, respuesta }));
    }

    const matchConv = /^\/api\/asistente\/conversaciones\/([^/]+)$/.exec(ruta);
    if (pedido.method() === 'GET' && matchConv) {
      if (asistenteCaido) return route.fulfill(problema(503, 'Asistente no disponible'));
      const conv = conversaciones.get(matchConv[1] ?? '');
      if (!conv || conv.usuarioId !== subActual) {
        return route.fulfill(problema(404, 'Conversación no encontrada'));
      }
      return route.fulfill(
        responder(200, {
          conversacionId: conv.conversacionId,
          usuarioId: conv.usuarioId,
          region: conv.region,
          idioma: conv.idioma,
          creadaEn: conv.creadaEn,
          actualizadaEn: conv.actualizadaEn,
          consultando: conv.consultando,
          mensajes: conv.mensajes,
        }),
      );
    }

    switch (`${pedido.method()} ${ruta}`) {
      case 'GET /api/asistente/health': {
        if (asistenteCaido) {
          return route.fulfill(problema(503, 'Asistente no disponible'));
        }
        return route.fulfill(responder(200, { estado: 'ok' }));
      }
      case 'POST /api/asistente/conversaciones': {
        if (asistenteCaido) {
          return route.fulfill(problema(503, 'Asistente no disponible'));
        }
        const idiomaConv: 'es' | 'en' = datos.idioma === 'en' ? 'en' : 'es';
        const ahora = new Date().toISOString();
        const conv: ConversacionInterna = {
          conversacionId: randomUUID(),
          usuarioId: subActual,
          region: perfil.region,
          idioma: idiomaConv,
          creadaEn: ahora,
          actualizadaEn: ahora,
          consultando: false,
          mensajes: [],
          opcionesPendientes: [],
        };
        agregarMensajeConv(conv, {
          autor: 'asistente',
          texto:
            idiomaConv === 'en'
              ? 'Hi! I am the Trotamundos virtual assistant. How can I help with your trip?'
              : '¡Hola! Soy el asistente virtual de Trotamundos. ¿En qué te puedo ayudar con tu viaje?',
          resultado: 'respondido',
        });
        conversaciones.set(conv.conversacionId, conv);
        return route.fulfill(
          responder(201, {
            conversacionId: conv.conversacionId,
            usuarioId: conv.usuarioId,
            region: conv.region,
            idioma: conv.idioma,
            creadaEn: conv.creadaEn,
            actualizadaEn: conv.actualizadaEn,
            consultando: conv.consultando,
            mensajes: conv.mensajes,
          }),
        );
      }
      case 'POST /api/integraciones/agencias/casos': {
        if (opciones.asistente?.fallarAgencia) {
          return route.fulfill(problema(503, 'Agencia no disponible'));
        }
        if (!perfil.agenciaPreferida) {
          return route.fulfill(problema(409, 'El usuario no tiene agencia preferida'));
        }
        const numeroCaso = String(contadorCasosAgencia++);
        return route.fulfill(
          responder(201, {
            agencia: perfil.agenciaPreferida,
            numeroCaso,
            creadoEn: new Date().toISOString(),
          }),
        );
      }
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
        return route.fulfill(responder(200, { viajes: panelViajes }, { 'X-Origen-Dato': 'cache' }));
      case 'GET /api/viajes/archivados':
        return route.fulfill(responder(200, { viajes: archivadosViajes }));
      case 'POST /api/viajes/reservas': {
        const proveedor = String(datos.proveedor ?? '');
        const numeroReserva = String(datos.numeroReserva ?? '');
        const duplicada = todosLosViajes().some((v) =>
          v.reservas.some((r) => r.proveedor === proveedor && r.numeroReserva === numeroReserva),
        );
        if (duplicada) return route.fulfill(problema(409, 'Reserva duplicada'));

        const inicio = String(datos.inicio ?? '');
        const fin = String(datos.fin ?? '');
        if (new Date(fin).getTime() < new Date(inicio).getTime()) {
          return route.fulfill(problema(400, 'Fin anterior a inicio'));
        }

        let viajeDestino =
          typeof datos.viajeId === 'string'
            ? panelViajes.find((v) => v.viajeId === datos.viajeId)
            : panelViajes.find((v) => {
                const diffInicio = Math.abs(new Date(inicio).getTime() - new Date(v.fin).getTime());
                const diffFin = Math.abs(new Date(v.inicio).getTime() - new Date(fin).getTime());
                return Math.min(diffInicio, diffFin) <= 48 * 60 * 60 * 1000;
              });

        const nuevaReserva: ReservaPrueba = {
          reservaId: randomUUID(),
          viajeId: viajeDestino?.viajeId ?? randomUUID(),
          proveedor,
          tipoReserva:
            datos.tipoReserva === 'hotel' || datos.tipoReserva === 'auto'
              ? datos.tipoReserva
              : 'vuelo',
          numeroReserva,
          inicio,
          fin,
          ...(typeof datos.origen === 'string' && datos.origen.length > 0
            ? { origen: datos.origen }
            : {}),
          destino: String(datos.destino ?? ''),
          estado: 'confirmada',
          detalle:
            datos.detalle && typeof datos.detalle === 'object'
              ? (datos.detalle as Record<string, unknown>)
              : {},
          origenCambio: 'manual',
          actualizadoEn: new Date().toISOString(),
        };

        if (!viajeDestino) {
          viajeDestino = {
            viajeId: nuevaReserva.viajeId,
            usuarioId: subActual,
            destino: nuevaReserva.destino,
            inicio: nuevaReserva.inicio,
            fin: nuevaReserva.fin,
            estado: 'activo',
            reservas: [nuevaReserva],
          };
          panelViajes.push(viajeDestino);
          panelViajes.sort((a, b) => new Date(a.inicio).getTime() - new Date(b.inicio).getTime());
        } else {
          viajeDestino.reservas.push(nuevaReserva);
          recalcularViaje(viajeDestino);
        }

        return route.fulfill(
          responder(201, nuevaReserva, {
            Location: `/api/viajes/reservas/${nuevaReserva.reservaId}`,
          }),
        );
      }
      case 'GET /api/analitica/consultas/destinos': {
        if (!rolesActuales.includes('analista')) return route.fulfill(problema(403, 'Prohibido'));
        const desde = url.searchParams.get('desde') ?? '2025-01-01';
        const hasta = url.searchParams.get('hasta') ?? '2025-12-31';
        const limite = Number(url.searchParams.get('limite') ?? '10');
        return route.fulfill(
          responder(200, calcularResultadoAnalitica('destinos', { desde, hasta, limite })),
        );
      }
      case 'GET /api/analitica/consultas/cancelaciones': {
        if (!rolesActuales.includes('analista')) return route.fulfill(problema(403, 'Prohibido'));
        const desde = url.searchParams.get('desde') ?? '2025-01-01';
        const hasta = url.searchParams.get('hasta') ?? '2025-12-31';
        const agruparPor =
          url.searchParams.get('agruparPor') === 'destino' ? 'destino' : 'proveedor';
        return route.fulfill(
          responder(200, calcularResultadoAnalitica('cancelaciones', { desde, hasta, agruparPor })),
        );
      }
      case 'GET /api/analitica/consultas/tendencias': {
        if (!rolesActuales.includes('analista')) return route.fulfill(problema(403, 'Prohibido'));
        const anio = Number(url.searchParams.get('anio') ?? '2025');
        return route.fulfill(responder(200, calcularResultadoAnalitica('tendencias', { anio })));
      }
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
    /** Reemplaza los viajes activos devueltos por GET /api/viajes/panel. */
    actualizarPanel: (viajes: ViajePrueba[]) => {
      panelViajes = viajes.map((v) => ({
        ...v,
        reservas: v.reservas.map((r) => ({ ...r, detalle: { ...r.detalle } })),
      }));
    },
    /** Controla si el asistente responde 503 (caído) o vuelve a operar. */
    setAsistenteCaido: (caido: boolean) => {
      asistenteCaido = caido;
    },
    /** Configura cuántos pedidos de mensajes del asistente fallan con 503. */
    setFallarMensajesAsistente: (cantidad: number) => {
      fallarMensajesRestantes = cantidad;
    },
  };
}
