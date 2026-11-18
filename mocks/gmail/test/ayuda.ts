// Ayudas de las pruebas: mock en un puerto libre con reloj simulado, receptor de avisos push y
// flujo OAuth completo.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crearLogger } from '@trotamundos/comun';
import { crearMock, type Mock, type OpcionesMock } from '../src/app.ts';
import { SCOPE_LECTURA } from '../src/oauth.ts';

export const CLIENTE = 'trotamundos-local.apps.googleusercontent.com';
export const SECRETO = 'secreto-de-prueba';
export const REDIRECT = 'http://localhost:8000/region-1/api/correo/oauth/callback';
export const TOPICO = 'projects/trotamundos/topics/gmail-avisos-region-1';

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
    logger: crearLogger({ servicio: 'mock-gmail', region: 'global', nivel: 'silent' }),
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

/** Pantalla de permiso → "Permitir" → canje del código. Devuelve la respuesta de /token. */
export async function conectar(
  url: string,
  email: string,
  { scope = SCOPE_LECTURA, offline = true } = {},
) {
  const decision = await fetch(`${url}/o/oauth2/v2/auth/decision`, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({
      client_id: CLIENTE,
      redirect_uri: REDIRECT,
      scope,
      state: 'state-firmado',
      access_type: offline ? 'offline' : 'online',
      email,
      decision: 'permitir',
    }),
  });
  const code = new URL(decision.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const respuesta = await fetch(`${url}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      code,
      client_id: CLIENTE,
      client_secret: SECRETO,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  });
  return (await respuesta.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: string;
  };
}

/** GET a la Gmail API con el token. */
export async function gmail(url: string, token: string, ruta: string, init: RequestInit = {}) {
  const respuesta = await fetch(`${url}/gmail/v1/users/me${ruta}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
  return { status: respuesta.status, cuerpo: (await respuesta.json()) as Record<string, unknown> };
}

export interface Receptor {
  url: string;
  recibidos: { cuerpo: Record<string, unknown>; en: number }[];
  /** Status de las próximas respuestas (después, 200). */
  fallar: number[];
  cerrar(): Promise<void>;
}

/** Hace de URL de avisos del Servicio de Correo. */
export async function receptor(): Promise<Receptor> {
  const estado: Omit<Receptor, 'url' | 'cerrar'> = { recibidos: [], fallar: [] };
  const servidor: Server = createServer((req, res) => {
    let datos = '';
    req.on('data', (t: Buffer) => (datos += t.toString()));
    req.on('end', () => {
      estado.recibidos.push({
        cuerpo: JSON.parse(datos) as Record<string, unknown>,
        en: Date.now(),
      });
      res.statusCode = estado.fallar.shift() ?? 200;
      res.end();
    });
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  const { port } = servidor.address() as AddressInfo;
  return Object.assign(estado, {
    url: `http://127.0.0.1:${port}/notificaciones/gmail?token=secreto-push`,
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
