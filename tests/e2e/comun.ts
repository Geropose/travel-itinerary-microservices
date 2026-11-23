// Utilidades compartidas para las pruebas de extremo a extremo (tests/e2e).
// Conecta con el sistema levantado a través del enrutador global (http://localhost:8000)
// y las rutas /admin de los 7 mocks externos.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leerEnv } from '../../infra/scripts/entorno.ts';

const raiz = fileURLToPath(new URL('../../', import.meta.url));
const rutaEnv = resolve(raiz, '.env');
const env = existsSync(rutaEnv) ? leerEnv(readFileSync(rutaEnv, 'utf8')) : {};

const val = (clave: string, defecto: string) => process.env[clave] ?? env[clave] ?? defecto;

export const CONFIG_E2E = {
  urlEnrutador: `http://localhost:${val('PUERTO_ENRUTADOR', '8000')}`,
  urlMockGmail: `http://localhost:${val('PUERTO_MOCK_GMAIL', '4001')}`,
  urlMockOutlook: `http://localhost:${val('PUERTO_MOCK_OUTLOOK', '4002')}`,
  urlMockAerolinea: `http://localhost:${val('PUERTO_MOCK_AEROLINEA', '4003')}`,
  urlMockHotel: `http://localhost:${val('PUERTO_MOCK_HOTEL', '4004')}`,
  urlMockRentadora: `http://localhost:${val('PUERTO_MOCK_RENTADORA', '4005')}`,
  urlMockAgencia: `http://localhost:${val('PUERTO_MOCK_AGENCIA', '4006')}`,
  urlMockRedSocial: `http://localhost:${val('PUERTO_MOCK_REDSOCIAL', '4007')}`,
  contrasenaAnalista: val('CONTRASENA_ANALISTA', ''),
  secretoServicioPruebas: val('SECRETO_SERVICIO_PRUEBAS', ''),
  contrasenaDefecto: 'Viajar-E2E-2026!',
};

export type Region = 'region-1' | 'region-2';

export interface SesionE2E {
  usuarioId: string;
  nombre: string;
  email: string;
  contrasena: string;
  region: Region;
  jwt: string;
}

export function idAleatorio(): string {
  return randomUUID().slice(0, 8);
}

export function emailAleatorio(prefijo: string, dominio = 'correo.example'): string {
  return `${prefijo}-${idAleatorio()}@${dominio}`;
}

export function subDeJwt(jwt: string): string {
  const carga = jwt.split('.')[1];
  if (!carga) throw new Error('JWT sin payload');
  const claims = JSON.parse(Buffer.from(carga, 'base64url').toString('utf8')) as { sub?: string };
  if (!claims.sub) throw new Error('JWT sin claim sub');
  return claims.sub;
}

const ORIGENES_LOCALES_E2E = new Set([
  CONFIG_E2E.urlEnrutador,
  CONFIG_E2E.urlMockGmail,
  CONFIG_E2E.urlMockOutlook,
  CONFIG_E2E.urlMockAerolinea,
  CONFIG_E2E.urlMockHotel,
  CONFIG_E2E.urlMockRentadora,
  CONFIG_E2E.urlMockAgencia,
  CONFIG_E2E.urlMockRedSocial,
]);

/** Las pruebas ejecutan comandos síncronos de Docker entre peticiones al sistema y mocks. */
export function pedirHttpE2E(url: string, init: RequestInit = {}): Promise<Response> {
  if (!ORIGENES_LOCALES_E2E.has(new URL(url).origin)) return fetch(url, init);
  const headers = new Headers(init.headers);
  // Evita reutilizar una conexión cerrada entre comandos o reinicios de contenedores.
  headers.set('Connection', 'close');
  return fetch(url, { ...init, headers });
}

/** Comprueba si el enrutador global y los servicios están respondiendo. */
export async function sistemaDisponible(): Promise<boolean> {
  try {
    const res = await pedirHttpE2E(`${CONFIG_E2E.urlEnrutador}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Petición JSON con reintentos opcionales ante 503 transitorio. */
export async function pedirJson<T>(
  url: string,
  init: RequestInit = {},
  reintentos503 = 2,
): Promise<{ status: number; datos: T | undefined; texto: string; headers: Headers }> {
  for (let intento = 0; intento <= reintentos503; intento += 1) {
    const resp = await pedirHttpE2E(url, init);
    const texto = await resp.text();
    let datos: T | undefined;
    if (texto) {
      try {
        datos = JSON.parse(texto) as T;
      } catch {
        datos = undefined;
      }
    }
    if (resp.status !== 503 || intento === reintentos503) {
      return { status: resp.status, datos, texto, headers: resp.headers };
    }
    await new Promise((r) => setTimeout(r, 400 * (intento + 1)));
  }
  throw new Error('Inalcanzable');
}

/** Registra un usuario nuevo en la región indicada y obtiene su JWT de sesión. */
export async function registrarYLogin(
  opciones: {
    nombre?: string;
    email?: string;
    contrasena?: string;
    region?: Region;
    idioma?: 'es' | 'en';
  } = {},
): Promise<SesionE2E> {
  const region = opciones.region ?? 'region-1';
  const nombre = opciones.nombre ?? `Usuario E2E ${idAleatorio()}`;
  const email = opciones.email ?? emailAleatorio('e2e-user');
  const contrasena = opciones.contrasena ?? CONFIG_E2E.contrasenaDefecto;
  const idioma = opciones.idioma ?? 'es';

  const reg = await pedirJson<{ usuarioId: string }>(
    `${CONFIG_E2E.urlEnrutador}/api/autenticacion/registro`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Region': region },
      body: JSON.stringify({ nombre, email, contrasena, region, idioma }),
    },
  );
  if (reg.status !== 201) {
    throw new Error(`Falló registro E2E (${email}): HTTP ${reg.status} ${reg.texto}`);
  }

  const login = await pedirJson<{ jwt: string }>(
    `${CONFIG_E2E.urlEnrutador}/api/autenticacion/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Region': region },
      body: JSON.stringify({ email, contrasena }),
    },
  );
  if (login.status !== 200 || !login.datos?.jwt) {
    throw new Error(`Falló login E2E (${email}): HTTP ${login.status} ${login.texto}`);
  }

  return {
    usuarioId: subDeJwt(login.datos.jwt),
    nombre,
    email,
    contrasena,
    region,
    jwt: login.datos.jwt,
  };
}

/** Inicia sesión como el analista de prueba del sistema. */
export async function loginAnalista(region: Region = 'region-1'): Promise<{ jwt: string }> {
  if (!CONFIG_E2E.contrasenaAnalista) {
    throw new Error('No se encontró CONTRASENA_ANALISTA en el entorno.');
  }
  const login = await pedirJson<{ jwt: string }>(
    `${CONFIG_E2E.urlEnrutador}/api/autenticacion/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Region': region },
      body: JSON.stringify({
        email: 'analista@trotamundos.example',
        contrasena: CONFIG_E2E.contrasenaAnalista,
      }),
    },
  );
  if (login.status !== 200 || !login.datos?.jwt) {
    throw new Error(`Falló login del analista: HTTP ${login.status} ${login.texto}`);
  }
  return { jwt: login.datos.jwt };
}

/** Conecta un buzón de Gmail u Outlook en mock-gmail o mock-outlook mediante OAuth 2.0 real. */
export async function conectarOAuthMock(params: {
  proveedor: 'gmail' | 'outlook';
  emailBuzon: string;
  jwt: string;
  region: Region;
}): Promise<void> {
  const { proveedor, emailBuzon, jwt, region } = params;
  const urlMock = proveedor === 'gmail' ? CONFIG_E2E.urlMockGmail : CONFIG_E2E.urlMockOutlook;

  // Asegurar que el buzón exista en el mock antes de aprobar el permiso OAuth.
  const buzonCodificado = encodeURIComponent(emailBuzon.toLowerCase());
  const existeBuzon = await fetch(`${urlMock}/admin/buzones/${buzonCodificado}/correos`);
  if (existeBuzon.status === 404) {
    await fetch(`${urlMock}/admin/buzones/${buzonCodificado}/correos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        de: 'bienvenida@sistema.example',
        asunto: 'Bienvenida',
        texto: 'Buzón inicializado.',
      }),
    });
  }

  const { status, datos, texto } = await pedirJson<{ urlAutorizacion: string }>(
    `${CONFIG_E2E.urlEnrutador}/api/correo/cuentas-correo/${proveedor}/conectar`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'X-Region': region },
    },
  );
  if (status !== 200 || !datos?.urlAutorizacion) {
    throw new Error(`No se pudo iniciar OAuth (${proveedor}): HTTP ${status} ${texto}`);
  }

  const urlAuth = new URL(datos.urlAutorizacion);
  const rutaDecision =
    proveedor === 'gmail' ? '/o/oauth2/v2/auth/decision' : '/common/oauth2/v2.0/authorize/decision';
  const formulario = new URLSearchParams();
  for (const clave of ['client_id', 'redirect_uri', 'scope', 'state', 'access_type']) {
    const valor = urlAuth.searchParams.get(clave);
    if (valor !== null) formulario.set(clave, valor);
  }
  formulario.set('email', emailBuzon);
  formulario.set('decision', 'permitir');

  const respDecision = await fetch(`${urlMock}${rutaDecision}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formulario.toString(),
    redirect: 'manual',
  });
  const urlCallback = respDecision.headers.get('location');
  if (respDecision.status !== 302 || !urlCallback) {
    const detalle = await respDecision.text();
    throw new Error(
      `El mock ${proveedor} no redirigió al callback: HTTP ${respDecision.status} ${detalle}`,
    );
  }

  const respCallback = await fetch(urlCallback, { redirect: 'manual' });
  const destinoFinal = respCallback.headers.get('location') ?? '';
  if (respCallback.status !== 302 || !destinoFinal.includes('resultado=conectada')) {
    const detalle = await respCallback.text();
    throw new Error(
      `Callback OAuth ${proveedor} falló: HTTP ${respCallback.status} Location=${destinoFinal} ` +
        detalle,
    );
  }
}

/** Desconecta todas las cuentas de correo asociadas a la sesión del usuario. */
export async function desconectarCuentasCorreo(sesion: SesionE2E): Promise<void> {
  try {
    const resp = await pedirJson<{ cuentas: { id: string }[] }>(
      `${CONFIG_E2E.urlEnrutador}/api/correo/cuentas-correo`,
      { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
    );
    for (const cuenta of resp.datos?.cuentas ?? []) {
      await fetch(`${CONFIG_E2E.urlEnrutador}/api/correo/cuentas-correo/${cuenta.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
      });
    }
  } catch {
    // Limpieza de mejor esfuerzo.
  }
}

/** Elimina todas las reservas actuales del usuario en el panel. */
export async function eliminarReservasUsuario(sesion: SesionE2E): Promise<void> {
  try {
    const panel = await pedirJson<{ viajes: { reservas: { reservaId: string }[] }[] }>(
      `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
      { headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region } },
    );
    for (const viaje of panel.datos?.viajes ?? []) {
      for (const res of viaje.reservas ?? []) {
        await fetch(`${CONFIG_E2E.urlEnrutador}/api/viajes/reservas/${res.reservaId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
        });
      }
    }
  } catch {
    // Limpieza de mejor esfuerzo.
  }
}

/** Inyecta un correo en un buzón de mock-gmail o mock-outlook. */
export async function inyectarCorreo(
  urlMock: string,
  buzonEmail: string,
  correo: { de: string; asunto: string; texto: string; html?: string },
): Promise<void> {
  const buzon = encodeURIComponent(buzonEmail.toLowerCase());
  const resp = await fetch(`${urlMock}/admin/buzones/${buzon}/correos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(correo),
  });
  if (resp.status !== 201) {
    const detalle = await resp.text();
    throw new Error(`Falló inyectar correo en ${buzonEmail}: HTTP ${resp.status} ${detalle}`);
  }
}

/** Reinicia el estado de un mock externo mediante su ruta /admin/reiniciar. */
export async function reiniciarMock(urlMock: string): Promise<void> {
  try {
    await fetch(`${urlMock}/admin/reiniciar`, { method: 'POST' });
  } catch {
    // Si el mock no tiene reiniciar o no responde, omitir.
  }
}

/** Ejecuta una operación de prueba dentro de la red privada de la región. */
export function ejecutarNodeEnRegion(region: Region, codigo: string, entrada: string): string {
  const proyecto = region === 'region-1' ? 'r1' : 'r2';
  return execFileSync(
    'docker',
    ['exec', '-i', `${proyecto}-viajes-1`, 'node', '--input-type=module', '-e', codigo],
    { input: entrada, encoding: 'utf8', timeout: 25_000 },
  ).trim();
}

/** Emite el JWT del servicio pruebas según el contrato de Autenticación. */
export function tokenServicioDePruebas(region: Region = 'region-1'): string {
  return ejecutarNodeEnRegion(
    region,
    `
    let secreto = '';
    for await (const parte of process.stdin) secreto += parte;
    const respuesta = await fetch('http://autenticacion:3001/interna/tokens-servicio', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ servicio: 'pruebas', secreto }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!respuesta.ok) throw new Error('Emisión del token de pruebas: HTTP ' + respuesta.status);
    const { tokenServicio } = await respuesta.json();
    if (typeof tokenServicio !== 'string' || !tokenServicio) {
      throw new Error('Autenticación no devolvió tokenServicio');
    }
    console.log(tokenServicio);
  `,
    CONFIG_E2E.secretoServicioPruebas,
  );
}

/** Firma el token interno propio del servicio Autenticación dentro de su contenedor regional. */
export function tokenServicioAutenticacion(region: Region = 'region-1'): string {
  const proyecto = region === 'region-1' ? 'r1' : 'r2';
  return execFileSync(
    'docker',
    [
      'exec',
      `${proyecto}-autenticacion-1`,
      'node',
      '--input-type=module',
      '-e',
      `
        import { leerClaves } from './services/autenticacion/src/claves.ts';
        import { firmarTokenDeServicio } from './services/autenticacion/src/tokens.ts';
        const claves = leerClaves(process.env.JWT_CLAVE_PRIVADA, process.env.REGION);
        console.log(await firmarTokenDeServicio(claves, 'autenticacion', process.env.REGION));
      `,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  ).trim();
}

/** Dispara en el acto la tarea de archivado de Viajes desde la red privada. */
export function ejecutarArchivadoEnRegion(region: Region = 'region-1'): void {
  const token = tokenServicioDePruebas(region);
  ejecutarNodeEnRegion(
    region,
    `
    let token = '';
    for await (const parte of process.stdin) token += parte;
    const respuesta = await fetch('http://127.0.0.1:3004/interna/archivado/ejecutar', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(15_000),
    });
    if (!respuesta.ok && respuesta.status !== 409) {
      throw new Error('Archivado de Viajes: HTTP ' + respuesta.status);
    }
  `,
    token,
  );
}

/** Espera hasta que una condición asíncrona retorne un valor definido. */
export async function esperarCondicion<T>(
  verificar: () => Promise<T | undefined>,
  timeoutMs = 15_000,
  intervaloMs = 500,
): Promise<T> {
  const limite = Date.now() + timeoutMs;
  let ultimoError: unknown;
  while (Date.now() < limite) {
    try {
      const resultado = await verificar();
      if (resultado !== undefined) return resultado;
    } catch (err) {
      ultimoError = err;
    }
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
  throw new Error(
    `Tiempo de espera agotado (${timeoutMs} ms). Último error: ${String(ultimoError)}`,
  );
}
