// Pruebas del mock de Aerolínea Andina contra specs/externos/aerolinea.md:
// autenticación Bearer, consulta por PNR/ID, webhooks firmados con HMAC + reintentos,
// reprogramación (0..3 ofertas, aplicar, vencida/usada 422), tormenta masiva, demoras y fallas.
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crearLogger } from '@trotamundos/comun';
import { afterEach, describe, expect, it } from 'vitest';
import { crearMockAerolinea, type MockAerolinea } from '../src/app.ts';

const API_KEY = 'clave-prueba-aerolinea-123';
const WEBHOOK_SECRET = 'secreto-webhook-aerolinea-123';
const AUTH = { Authorization: `Bearer ${API_KEY}` };
const logger = crearLogger({ servicio: 'mock-aerolinea-test', region: 'global', nivel: 'error' });

interface WebhookRecibido {
  cuerpoCrudo: string;
  json: Record<string, unknown>;
  firma: string | undefined;
}

function crearReceptorWebhook(responderCon: (intento: number) => number = () => 200) {
  const recibidos: WebhookRecibido[] = [];
  let intentos = 0;
  const server = createServer((req: IncomingMessage, res) => {
    const trozos: Buffer[] = [];
    req.on('data', (c: Buffer) => trozos.push(c));
    req.on('end', () => {
      intentos += 1;
      const cuerpoCrudo = Buffer.concat(trozos).toString('utf8');
      recibidos.push({
        cuerpoCrudo,
        json: JSON.parse(cuerpoCrudo) as Record<string, unknown>,
        firma: req.headers['x-webhook-signature'] as string | undefined,
      });
      res.statusCode = responderCon(intentos);
      res.end();
    });
  });

  return {
    recibidos,
    iniciar: () =>
      new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address() as AddressInfo;
          resolve(`http://127.0.0.1:${port}/webhook`);
        });
      }),
    detener: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function esperar(condicion: () => boolean, timeoutMs = 2000) {
  const fin = Date.now() + timeoutMs;
  while (!condicion()) {
    if (Date.now() > fin) throw new Error('Timeout esperando condición');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('mocks/aerolinea (specs/externos/aerolinea.md)', () => {
  let mock: MockAerolinea | undefined;
  let receptor: ReturnType<typeof crearReceptorWebhook> | undefined;

  afterEach(async () => {
    await mock?.detener();
    mock = undefined;
    await receptor?.detener();
    receptor = undefined;
  });

  it('autentica con Bearer, lista semillas por booking_reference y devuelve 404 en formato Duffel', async () => {
    mock = crearMockAerolinea({
      puerto: 0,
      logger,
      apiKey: API_KEY,
      webhookSecret: WEBHOOK_SECRET,
      semillas: true,
    });
    const puerto = await mock.iniciar();
    const base = `http://127.0.0.1:${puerto}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ estado: 'ok' });

    const sinAuth = await fetch(`${base}/air/orders?booking_reference=XKQ7PL`);
    expect(sinAuth.status).toBe(401);
    expect(await sinAuth.json()).toMatchObject({
      errors: [{ code: 'unauthorized', title: 'Unauthorized' }],
      meta: { status: 401 },
    });

    const ok = await fetch(`${base}/air/orders?booking_reference=XKQ7PL`, { headers: AUTH });
    expect(ok.status).toBe(200);
    const cuerpo = (await ok.json()) as {
      data: { id: string; booking_reference: string; status: string; version: number }[];
      meta: { limit: number; after: null; before: null };
    };
    expect(cuerpo.data).toHaveLength(1);
    expect(cuerpo.data[0]).toMatchObject({
      id: 'ord_0000AN000XKQ7PL',
      booking_reference: 'XKQ7PL',
      status: 'confirmed',
      version: 1,
    });

    const porId = await fetch(`${base}/air/orders/ord_0000AN000XKQ7PL`, { headers: AUTH });
    expect(porId.status).toBe(200);

    const inexistente = await fetch(`${base}/air/orders/ord_inexistente`, { headers: AUTH });
    expect(inexistente.status).toBe(404);
    expect(await inexistente.json()).toMatchObject({
      errors: [{ code: 'not_found' }],
      meta: { status: 404 },
    });
  });

  it('envía webhooks firmados con X-Webhook-Signature al cambiar y cancelar, y reintenta ante errores', async () => {
    let falloPrimero = true;
    receptor = crearReceptorWebhook(() => {
      if (falloPrimero) {
        falloPrimero = false;
        return 503;
      }
      return 200;
    });
    const urlWebhook = await receptor.iniciar();

    mock = crearMockAerolinea({
      puerto: 0,
      logger,
      apiKey: API_KEY,
      webhookSecret: WEBHOOK_SECRET,
      webhookUrls: [urlWebhook],
      avisos: { reintentos: 3, esperaMs: 30 },
    });
    const puerto = await mock.iniciar();
    const base = `http://127.0.0.1:${puerto}`;

    const cambio = await fetch(`${base}/admin/ordenes/XKQ7PL/cambiar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desplazarMinutos: 165 }),
    });
    expect(cambio.status).toBe(200);

    await esperar(() => (receptor?.recibidos.length ?? 0) >= 2);
    const ultimo = receptor.recibidos.at(-1);
    expect(ultimo).toBeDefined();
    expect(ultimo?.json).toMatchObject({
      type: 'order.airline_initiated_change_detected',
      idempotency_key: 'XKQ7PL-v2',
    });

    // Verifica firma HMAC-SHA256 sobre t + "." + cuerpoCrudo.
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(ultimo?.firma ?? '');
    expect(match).not.toBeNull();
    const esperado = createHmac('sha256', WEBHOOK_SECRET)
      .update(`${match?.[1]}.${ultimo?.cuerpoCrudo}`)
      .digest('hex');
    expect(match?.[2]).toBe(esperado);

    // Cancelación envía added: [] y status: cancelled.
    const cancel = await fetch(`${base}/admin/ordenes/XKQ7PL/cancelar`, { method: 'POST' });
    expect(cancel.status).toBe(200);
    await esperar(() => (receptor?.recibidos.length ?? 0) >= 3);
    const evCancel = receptor.recibidos.at(-1)?.json as {
      data: { object: { order: { status: string; version: number }; added: unknown[] } };
    };
    expect(evCancel.data.object.order.status).toBe('cancelled');
    expect(evCancel.data.object.order.version).toBe(3);
    expect(evCancel.data.object.added).toEqual([]);
  });

  it('reprogramación: devuelve ofertas incluso en orden cancelada, aplica una y emite order.updated; rechaza 422 si ya se usó o venció', async () => {
    receptor = crearReceptorWebhook();
    const urlWebhook = await receptor.iniciar();
    mock = crearMockAerolinea({
      puerto: 0,
      logger,
      apiKey: API_KEY,
      webhookSecret: WEBHOOK_SECRET,
      webhookUrls: [urlWebhook],
    });
    const puerto = await mock.iniciar();
    const base = `http://127.0.0.1:${puerto}`;

    // Cancelamos XKQ7PL primero y pedimos opciones igual (reubicación).
    await fetch(`${base}/admin/ordenes/XKQ7PL/cancelar`, { method: 'POST' });

    const reqOpciones = await fetch(`${base}/air/order_change_requests`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { order_id: 'ord_0000AN000XKQ7PL' } }),
    });
    expect(reqOpciones.status).toBe(201);
    const { data: pedido } = (await reqOpciones.json()) as {
      data: { order_change_offers: { id: string }[] };
    };
    expect(pedido.order_change_offers.length).toBeGreaterThanOrEqual(1);
    const ofertaId = pedido.order_change_offers[0]?.id ?? '';

    const aplicar = await fetch(`${base}/air/order_changes`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { selected_order_change_offer: ofertaId } }),
    });
    expect(aplicar.status).toBe(201);

    await esperar(() => receptor?.recibidos.some((r) => r.json.type === 'order.updated') ?? false);

    // Reintentar la misma oferta -> 422 offer_no_longer_available.
    const repetida = await fetch(`${base}/air/order_changes`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { selected_order_change_offer: ofertaId } }),
    });
    expect(repetida.status).toBe(422);
    expect(await repetida.json()).toMatchObject({
      errors: [{ code: 'offer_no_longer_available' }],
    });

    // Oferta configurada con TTL vencido -> 422.
    await fetch(`${base}/admin/ordenes/XKQ7PL/opciones`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cantidad: 1, ttlSeg: -10 }),
    });
    const reqVencida = await fetch(`${base}/air/order_change_requests`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { order_id: 'ord_0000AN000XKQ7PL' } }),
    });
    const { data: pedidoVencido } = (await reqVencida.json()) as {
      data: { order_change_offers: { id: string }[] };
    };
    const aplicarVencida = await fetch(`${base}/air/order_changes`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: { selected_order_change_offer: pedidoVencido.order_change_offers[0]?.id },
      }),
    });
    expect(aplicarVencida.status).toBe(422);
  });

  it('soporta tormenta masiva, demora configurable, falla 503 y no-responder desde /admin', async () => {
    receptor = crearReceptorWebhook();
    const urlWebhook = await receptor.iniciar();
    mock = crearMockAerolinea({
      puerto: 0,
      logger,
      apiKey: API_KEY,
      webhookSecret: WEBHOOK_SECRET,
      webhookUrls: [urlWebhook],
    });
    const puerto = await mock.iniciar();
    const base = `http://127.0.0.1:${puerto}`;

    // Tormenta de 30 cancelaciones.
    const tormenta = await fetch(`${base}/admin/tormenta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cantidad: 30, enviarWebhooks: true }),
    });
    expect(tormenta.status).toBe(202);
    expect(await tormenta.json()).toMatchObject({ canceladas: 30, webhooksDisparados: 30 });
    await esperar(() => (receptor?.recibidos.length ?? 0) >= 30);

    // Demora de 150 ms.
    await fetch(`${base}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demoraMs: 150, modoFalla: 'ninguna' }),
    });
    const t0 = performance.now();
    const lenta = await fetch(`${base}/air/orders?booking_reference=XKQ7PL`, { headers: AUTH });
    expect(lenta.status).toBe(200);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(120);

    // Falla 503.
    await fetch(`${base}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demoraMs: 0, modoFalla: '503' }),
    });
    const caida = await fetch(`${base}/air/orders?booking_reference=XKQ7PL`, { headers: AUTH });
    expect(caida.status).toBe(503);
    expect(await caida.json()).toMatchObject({ errors: [{ code: 'service_unavailable' }] });

    // No responder (el cliente corta por timeout).
    await fetch(`${base}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modoFalla: 'no-responder' }),
    });
    await expect(
      fetch(`${base}/air/orders?booking_reference=XKQ7PL`, {
        headers: AUTH,
        signal: AbortSignal.timeout(120),
      }),
    ).rejects.toThrow();

    // Limpiar comportamiento recupera 200.
    await fetch(`${base}/admin/comportamiento`, { method: 'DELETE' });
    const recuperada = await fetch(`${base}/air/orders?booking_reference=XKQ7PL`, {
      headers: AUTH,
    });
    expect(recuperada.status).toBe(200);
  });
});
