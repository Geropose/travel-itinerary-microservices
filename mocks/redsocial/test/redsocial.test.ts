// Pruebas del mock de Red Social contra specs/externos/redsocial.md:
// autenticación Bearer, POST /api/v1/statuses -> 200 OK, límite 500 caracteres y visibilidad 422,
// Idempotency-Key (sin duplicar por 1 hora), /admin/publicaciones, demoras y fallas.
import { crearLogger } from '@trotamundos/comun';
import { afterEach, describe, expect, it } from 'vitest';
import { crearMockRedSocial, type MockRedSocial } from '../src/app.ts';

const API_TOKEN = 'token-prueba-redsocial-123';
const AUTH = { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' };
const logger = crearLogger({ servicio: 'mock-redsocial-test', region: 'global', nivel: 'error' });

describe('mocks/redsocial (specs/externos/redsocial.md)', () => {
  let mock: MockRedSocial | undefined;

  afterEach(async () => {
    await mock?.detener();
    mock = undefined;
  });

  it('valida Bearer, responde 200 OK, respeta 500 caracteres e Idempotency-Key', async () => {
    let relojMs = Date.parse('2026-11-28T15:04:47Z');
    mock = crearMockRedSocial({
      puerto: 0,
      logger,
      apiToken: API_TOKEN,
      reloj: () => relojMs,
    });
    const puerto = await mock.iniciar();
    const base = `http://127.0.0.1:${puerto}`;

    const sinAuth = await fetch(`${base}/api/v1/statuses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Hola mundo' }),
    });
    expect(sinAuth.status).toBe(401);
    expect(await sinAuth.json()).toEqual({ error: 'The access token is invalid' });

    const vacio = await fetch(`${base}/api/v1/statuses`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ status: '   ' }),
    });
    expect(vacio.status).toBe(422);

    const muyLargo = await fetch(`${base}/api/v1/statuses`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ status: 'a'.repeat(501) }),
    });
    expect(muyLargo.status).toBe(422);

    const visInvalida = await fetch(`${base}/api/v1/statuses`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ status: 'Viaje a Santiago', visibility: 'secreto' }),
    });
    expect(visInvalida.status).toBe(422);

    const cuerpo = JSON.stringify({
      status: 'Me voy de viaje a Santiago\n10/12 Vuelo AN 1234',
      visibility: 'public',
      language: 'es',
    });
    const primera = await fetch(`${base}/api/v1/statuses`, {
      method: 'POST',
      headers: { ...AUTH, 'Idempotency-Key': 'clave-unica-1' },
      body: cuerpo,
    });
    expect(primera.status).toBe(200);
    const pub1 = (await primera.json()) as { id: string; url: string; content: string };
    expect(pub1.url).toMatch(/^https:\/\/redsocial\.example\/@trotamundos\/\d+$/);
    expect(pub1.content).toContain('<br />');

    // Repetir con la misma Idempotency-Key dentro de la hora devuelve la misma publicación.
    relojMs += 5 * 60_000;
    const repetida = await fetch(`${base}/api/v1/statuses`, {
      method: 'POST',
      headers: { ...AUTH, 'Idempotency-Key': 'clave-unica-1' },
      body: cuerpo,
    });
    expect(repetida.status).toBe(200);
    expect(await repetida.json()).toEqual(pub1);

    const admin = await fetch(`${base}/admin/publicaciones`);
    const { publicaciones } = (await admin.json()) as { publicaciones: unknown[] };
    expect(publicaciones).toHaveLength(1);
  });

  it('soporta demora, falla 503 y no-responder desde /admin/comportamiento', async () => {
    mock = crearMockRedSocial({ puerto: 0, logger, apiToken: API_TOKEN });
    const puerto = await mock.iniciar();
    const base = `http://127.0.0.1:${puerto}`;
    const body = JSON.stringify({ status: 'Viaje a Mendoza' });

    await fetch(`${base}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demoraMs: 120 }),
    });
    const t0 = performance.now();
    const ok = await fetch(`${base}/api/v1/statuses`, { method: 'POST', headers: AUTH, body });
    expect(ok.status).toBe(200);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(100);

    await fetch(`${base}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demoraMs: 0, modoFalla: '503' }),
    });
    const caida = await fetch(`${base}/api/v1/statuses`, { method: 'POST', headers: AUTH, body });
    expect(caida.status).toBe(503);

    await fetch(`${base}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modoFalla: 'no-responder' }),
    });
    await expect(
      fetch(`${base}/api/v1/statuses`, {
        method: 'POST',
        headers: AUTH,
        body,
        signal: AbortSignal.timeout(120),
      }),
    ).rejects.toThrow();
  });
});
