// Pruebas del mock de Viajes del Plata contra specs/externos/agencia.md:
// autenticación Bearer, creación de tickets 201 (incluyendo requester opcional), validación 422,
// inspección desde /admin/casos, demoras y fallas (503 y no-responder).
import { crearLogger } from '@trotamundos/comun';
import { afterEach, describe, expect, it } from 'vitest';
import { crearMockAgencia, type MockAgencia } from '../src/app.ts';

const API_KEY = 'clave-prueba-agencia-123';
const AUTH = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
const logger = crearLogger({ servicio: 'mock-agencia-test', region: 'global', nivel: 'error' });

describe('mocks/agencia (specs/externos/agencia.md)', () => {
  let mock: MockAgencia | undefined;

  afterEach(async () => {
    await mock?.detener();
    mock = undefined;
  });

  it('valida Bearer, crea tickets 201 con requester opcional y rechaza campos inválidos con 422', async () => {
    mock = crearMockAgencia({ puerto: 0, logger, apiKey: API_KEY });
    const puerto = await mock.iniciar();
    const base = `http://127.0.0.1:${puerto}`;

    const sinAuth = await fetch(`${base}/api/v2/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: { subject: 'Hola', comment: { body: 'Ayuda' } } }),
    });
    expect(sinAuth.status).toBe(401);

    const invalido = await fetch(`${base}/api/v2/tickets`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        ticket: { subject: '', comment: { body: '' }, priority: 'super-alta' },
      }),
    });
    expect(invalido.status).toBe(422);
    expect(await invalido.json()).toMatchObject({
      error: 'RecordInvalid',
      details: {
        subject: [expect.anything()],
        'comment.body': [expect.anything()],
        priority: [expect.anything()],
      },
    });

    const creado = await fetch(`${base}/api/v2/tickets`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        ticket: {
          subject: 'Trotamundos: vuelo XKQ7PL cancelado',
          comment: { body: 'Resumen: vuelo cancelado sin opciones.' },
          priority: 'high',
          external_id: '6b1e7c2a-4f3d-4e8b-9c0a-1d2e3f4a5b6c',
          tags: ['trotamundos', 'asistente-virtual'],
          requester: { name: 'Ana García', email: 'ana@correo.example' },
        },
      }),
    });
    expect(creado.status).toBe(201);
    const { ticket } = (await creado.json()) as {
      ticket: { id: number; status: string; subject: string; priority: string };
    };
    expect(ticket).toMatchObject({
      id: 35436,
      status: 'new',
      subject: 'Trotamundos: vuelo XKQ7PL cancelado',
      priority: 'high',
      external_id: '6b1e7c2a-4f3d-4e8b-9c0a-1d2e3f4a5b6c',
      requester: { name: 'Ana García', email: 'ana@correo.example' },
    });

    // Visible desde /admin/casos con el cuerpo completo del comentario.
    const admin = await fetch(`${base}/admin/casos`);
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({
      casos: [{ id: 35436, comment: { body: 'Resumen: vuelo cancelado sin opciones.' } }],
    });
  });

  it('soporta demora, falla 503 y no-responder desde /admin/comportamiento', async () => {
    mock = crearMockAgencia({ puerto: 0, logger, apiKey: API_KEY });
    const puerto = await mock.iniciar();
    const base = `http://127.0.0.1:${puerto}`;
    const payload = JSON.stringify({
      ticket: { subject: 'Ayuda', comment: { body: 'Detalle del caso' } },
    });

    await fetch(`${base}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demoraMs: 120 }),
    });
    const t0 = performance.now();
    const ok = await fetch(`${base}/api/v2/tickets`, {
      method: 'POST',
      headers: AUTH,
      body: payload,
    });
    expect(ok.status).toBe(201);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(100);

    await fetch(`${base}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demoraMs: 0, modoFalla: '503' }),
    });
    const caida = await fetch(`${base}/api/v2/tickets`, {
      method: 'POST',
      headers: AUTH,
      body: payload,
    });
    expect(caida.status).toBe(503);

    await fetch(`${base}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modoFalla: 'no-responder' }),
    });
    await expect(
      fetch(`${base}/api/v2/tickets`, {
        method: 'POST',
        headers: AUTH,
        body: payload,
        signal: AbortSignal.timeout(120),
      }),
    ).rejects.toThrow();
  });
});
