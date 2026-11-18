// Suscripciones y change notifications contra specs/externos/outlook.md, secciones 4 y 5.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLIENTE,
  conectar,
  esperarA,
  graph,
  levantar,
  receptor,
  type Entorno,
  type Receptor,
} from './ayuda.ts';

let e: Entorno;
let r: Receptor;
let token: string;
const ANA = 'ana.garcia@outlook.example';
const INBOX = "me/mailFolders('Inbox')/messages";

beforeEach(async () => {
  r = await receptor();
  e = await levantar({ avisos: { reintentos: 2, esperaMs: 20 } });
  ({ access_token: token } = await conectar(e.url, ANA));
});
afterEach(async () => {
  await e.cerrar();
  await r.cerrar();
});

const enDias = (dias: number) => new Date(e.reloj.ahora + dias * 86_400_000).toISOString();

const suscribir = (cuerpo: object = {}) =>
  graph(e.url, token, '/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      changeType: 'created',
      notificationUrl: r.url,
      resource: INBOX,
      expirationDateTime: enDias(6),
      clientState: 'secreto-de-la-cuenta',
      ...cuerpo,
    }),
  });

const inyectar = (cuerpo: object) =>
  fetch(`${e.url}/admin/buzones/${ANA}/correos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  }).then((res) => res.json() as Promise<{ correos: { id: string }[] }>);

describe('4.1 y 4.2 crear la suscripción con el handshake de validationToken', () => {
  it('valida la URL (POST text/plain vacío) y responde 201 con el formato del ejemplo', async () => {
    const { status, cuerpo } = await suscribir();
    expect(status).toBe(201);
    expect(r.validaciones).toHaveLength(1);
    expect(r.validaciones[0]?.tipo).toBe('text/plain; charset=utf-8');
    expect(r.validaciones[0]?.cuerpo).toBe('');
    // El token es opaco y tiene espacios y ":": llega codificado en la URL.
    expect(r.validaciones[0]?.token).toMatch(/^Validation: .+ Request-Id: /);
    expect(Object.keys(cuerpo)).toEqual([
      '@odata.context',
      'id',
      'resource',
      'applicationId',
      'changeType',
      'clientState',
      'notificationUrl',
      'expirationDateTime',
      'creatorId',
      'latestSupportedTlsVersion',
      'notificationContentType',
    ]);
    expect(cuerpo).toMatchObject({
      '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#subscriptions/$entity',
      resource: INBOX,
      applicationId: CLIENTE,
      changeType: 'created',
      clientState: 'secreto-de-la-cuenta',
      notificationUrl: r.url,
      expirationDateTime: enDias(6).replace(/\.\d{3}Z$/, 'Z'),
      latestSupportedTlsVersion: 'v1_2',
      notificationContentType: 'application/json',
    });
  });

  it('si la URL no devuelve el token decodificado, o da error: 400 y no la crea', async () => {
    r.validar = 'codificado';
    const codificado = await suscribir();
    expect(codificado.status).toBe(400);
    expect(codificado.cuerpo).toMatchObject({ error: { code: 'ValidationError' } });
    r.validar = 'error';
    expect((await suscribir()).status).toBe(400);
    const buzones = (await (await fetch(`${e.url}/admin/buzones`)).json()) as {
      email: string;
      suscripciones: number;
    }[];
    expect(buzones.find((b) => b.email === ANA)?.suscripciones).toBe(0);
  });

  it('la misma changeType y resource: 409 Conflict', async () => {
    expect((await suscribir()).status).toBe(201);
    expect((await suscribir()).status).toBe(409);
  });

  it('vencimiento: más de 10.080 minutos es 400; menos de 45 minutos se lleva a 45', async () => {
    expect((await suscribir({ expirationDateTime: enDias(7.01) })).status).toBe(400);
    const corta = await suscribir({ expirationDateTime: enDias(0.001) });
    expect(corta.status).toBe(201);
    expect(corta.cuerpo.expirationDateTime).toBe(
      new Date(e.reloj.ahora + 45 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    );
  });

  it('un resource que no es de mensajes: 400', async () => {
    expect((await suscribir({ resource: 'me/events' })).status).toBe(400);
  });
});

describe('4.3 renovar y borrar', () => {
  it('PATCH cambia expirationDateTime y responde 200; DELETE responde 204', async () => {
    const { cuerpo } = await suscribir();
    const id = String(cuerpo.id);
    const patch = (expirationDateTime: string) =>
      graph(e.url, token, `/subscriptions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expirationDateTime }),
      });
    e.reloj.ahora += 5 * 86_400_000;
    // El access token dura una hora: la aplicación lo renovó.
    ({ access_token: token } = await conectar(e.url, ANA));
    const renovada = await patch(enDias(6));
    expect(renovada.status).toBe(200);
    expect(renovada.cuerpo).toMatchObject({
      id,
      expirationDateTime: enDias(6).replace(/\.\d{3}Z$/, 'Z'),
    });
    expect((await graph(e.url, token, `/subscriptions/${id}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect((await patch(enDias(6))).status).toBe(404);
  });

  it('otro usuario no ve la suscripción (404)', async () => {
    const { cuerpo } = await suscribir();
    const otro = await conectar(e.url, 'bruno.diaz@outlook.example');
    const respuesta = await graph(e.url, otro.access_token, `/subscriptions/${String(cuerpo.id)}`, {
      method: 'DELETE',
    });
    expect(respuesta.status).toBe(404);
  });
});

describe('5. change notification', () => {
  it('al entrar un correo manda value con el formato del ejemplo, sin el contenido', async () => {
    const { cuerpo } = await suscribir();
    const { correos } = await inyectar({ tipo: 'vuelo' });
    await esperarA(() => r.avisos.length === 1);
    const aviso = r.avisos[0]?.value[0] ?? {};
    const perfil = await graph(e.url, token, '/me?$select=id');
    const recurso = `Users/${String(perfil.cuerpo.id)}/Messages/${correos[0]?.id ?? ''}`;
    expect(aviso).toEqual({
      id: expect.any(String) as string,
      subscriptionId: cuerpo.id,
      subscriptionExpirationDateTime: cuerpo.expirationDateTime,
      clientState: 'secreto-de-la-cuenta',
      changeType: 'created',
      resource: recurso,
      tenantId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      resourceData: {
        '@odata.type': '#Microsoft.Graph.Message',
        '@odata.id': recurso,
        '@odata.etag': expect.stringMatching(/^W\/"/) as string,
        id: correos[0]?.id,
      },
    });
    // Con resourceData.id se lee el correo (sección 3).
    expect((await graph(e.url, token, `/me/messages/${correos[0]?.id ?? ''}`)).status).toBe(200);
  });

  it('varios correos que entran juntos van en el mismo value', async () => {
    await suscribir();
    const { correos } = await inyectar({ cantidad: 3, semilla: 1 });
    await esperarA(() => r.avisos.length >= 1);
    await new Promise((listo) => setTimeout(listo, 50));
    expect(r.avisos).toHaveLength(1);
    expect(r.avisos[0]?.value.map((a) => (a.resourceData as { id: string }).id)).toEqual(
      correos.map((c) => c.id),
    );
  });

  it('si el Servicio de Correo responde un error, reintenta el mismo aviso', async () => {
    await suscribir();
    r.fallar.push(500, 503);
    await inyectar({ tipo: 'hotel' });
    await esperarA(() => r.avisos.length === 3);
    expect(new Set(r.avisos.map((a) => a.value[0]?.id)).size).toBe(1);
  });

  it('sin suscripción, o con la suscripción vencida, no hay avisos', async () => {
    await inyectar({ tipo: 'auto' });
    await suscribir();
    e.reloj.ahora += 7 * 86_400_000;
    await inyectar({ tipo: 'auto' });
    await new Promise((listo) => setTimeout(listo, 100));
    expect(r.avisos).toHaveLength(0);
  });
});
