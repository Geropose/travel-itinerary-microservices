// Ayudas de las pruebas: mock en un puerto libre con reloj simulado, receptor de avisos que hace de
// Servicio de Correo y flujo OAuth completo.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crearLogger } from '@trotamundos/comun';
import { crearMock, type Mock, type OpcionesMock } from '../src/app.ts';

export const CLIENTE = '11112222-bbbb-3333-cccc-4444dddd5555';
export const SECRETO = 'secreto-de-prueba';
export const REDIRECT = 'http://localhost:8000/region-1/api/correo/oauth/callback';
export const SCOPES =
  'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read';

export interface Entorno {
  mock: Mock;
  url: string;
  /** Reloj simulado: las pruebas lo adelantan. */
  reloj: { ahora: number };
  cerrar(): Promise<void>;
}

export async function levantar(extra: Partial<OpcionesMock> = {}): Promise<Entorno> {
  const reloj = { ahora: Date.parse('2026-11-28T12:00:00Z') };
  const mock = crearMock({
    puerto: 0,
    logger: crearLogger({ servicio: 'mock-outlook', region: 'global', nivel: 'silent' }),
    clientId: CLIENTE,
    clientSecret: SECRETO,
    redirectUris: [REDIRECT],
    semillas: true,
    reloj: () => reloj.ahora,
    ...extra,
  });
  const puerto = await mock.iniciar();
  return { mock, url: `http://127.0.0.1:${puerto}`, reloj, cerrar: () => mock.detener() };
}

/** Manda el formulario de la pantalla de permiso y devuelve la URL de vuelta. */
export async function decidir(url: string, email: string, decision = 'permitir', scope = SCOPES) {
  const respuesta = await fetch(`${url}/common/oauth2/v2.0/authorize/decision`, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({
      client_id: CLIENTE,
      redirect_uri: REDIRECT,
      scope,
      state: 'state-firmado',
      email,
      decision,
    }),
  });
  return new URL(respuesta.headers.get('location') ?? '');
}

export const token = (url: string, datos: Record<string, string>) =>
  fetch(`${url}/common/oauth2/v2.0/token`, { method: 'POST', body: new URLSearchParams(datos) });

/** Pantalla de permiso → "Permitir" → canje del código. */
export async function conectar(url: string, email: string, scope = SCOPES) {
  const code = (await decidir(url, email, 'permitir', scope)).searchParams.get('code') ?? '';
  const respuesta = await token(url, {
    client_id: CLIENTE,
    scope,
    code,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
    client_secret: SECRETO,
  });
  return (await respuesta.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    refresh_token?: string;
  };
}

/** Llamada a Graph con el token. */
export async function graph(
  url: string,
  accessToken: string,
  ruta: string,
  init: RequestInit = {},
) {
  const respuesta = await fetch(`${url}/v1.0${ruta}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...init.headers },
  });
  const texto = await respuesta.text();
  return {
    status: respuesta.status,
    headers: respuesta.headers,
    cuerpo: (texto ? JSON.parse(texto) : {}) as Record<string, unknown>,
  };
}

export interface Receptor {
  url: string;
  /** Validaciones recibidas (el validationToken decodificado) y avisos. */
  validaciones: { token: string; tipo: string; cuerpo: string }[];
  avisos: { value: Record<string, unknown>[] }[];
  /** Cómo responde la validación: bien, con el token codificado o con un error. */
  validar: 'bien' | 'codificado' | 'error';
  /** Status de los próximos avisos (después, 202). */
  fallar: number[];
  cerrar(): Promise<void>;
}

/** Hace de /notificaciones/outlook del Servicio de Correo (secciones 4.2 y 5). */
export async function receptor(): Promise<Receptor> {
  const estado: Omit<Receptor, 'url' | 'cerrar'> = {
    validaciones: [],
    avisos: [],
    validar: 'bien',
    fallar: [],
  };
  const servidor: Server = createServer((req, res) => {
    let datos = '';
    req.on('data', (t: Buffer) => (datos += t.toString()));
    req.on('end', () => {
      const consulta = new URL(req.url ?? '', 'http://x').searchParams;
      const validationToken = consulta.get('validationToken');
      if (validationToken !== null) {
        estado.validaciones.push({
          token: validationToken,
          tipo: req.headers['content-type'] ?? '',
          cuerpo: datos,
        });
        if (estado.validar === 'error') {
          res.statusCode = 500;
          return void res.end();
        }
        res.setHeader('Content-Type', 'text/plain');
        res.end(estado.validar === 'bien' ? validationToken : encodeURIComponent(validationToken));
        return;
      }
      estado.avisos.push(JSON.parse(datos) as { value: Record<string, unknown>[] });
      res.statusCode = estado.fallar.shift() ?? 202;
      res.end();
    });
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  const { port } = servidor.address() as AddressInfo;
  return Object.assign(estado, {
    url: `http://127.0.0.1:${port}/notificaciones/outlook`,
    cerrar: () => new Promise<void>((r) => servidor.close(() => r())),
  });
}

/** Espera hasta que se cumpla la condición (o falla a los 3 s). */
export async function esperarA(condicion: () => boolean, maximoMs = 3000) {
  const inicio = Date.now();
  while (!condicion()) {
    if (Date.now() - inicio > maximoMs) throw new Error('No se cumplió a tiempo');
    await new Promise((r) => setTimeout(r, 10));
  }
}
