// Pruebas del mock de Hotel Cordillera contra specs/externos/hotel.md:
// autenticación X-Api-Key, consulta por modifiedSince con paginación por cursor, consulta puntual,
// cambios/cancelaciones desde /admin, demoras y fallas (503 y no-responder).
import { crearLogger } from '@trotamundos/comun';
import { afterEach, describe, expect, it } from 'vitest';
import { crearMockHotel, type MockHotel } from '../src/app.ts';

const API_KEY = 'clave-prueba-hotel-123';
const AUTH = { 'X-Api-Key': API_KEY };
const logger = crearLogger({ servicio: 'mock-hotel-test', region: 'global', nivel: 'error' });

describe('mocks/hotel (specs/externos/hotel.md)', () => {
  let mock: MockHotel | undefined;

  afterEach(async () => {
    await mock?.detener();
    mock = undefined;
  });

  it('valida X-Api-Key, consulta individual, modifiedSince obligatorio y paginación por cursor', async () => {
    let relojMs = Date.parse('2026-11-28T12:00:00Z');
    mock = crearMockHotel({
      puerto: 0,
      logger,
      apiKey: API_KEY,
      semillas: true,
      reloj: () => relojMs,
    });
    const puerto = await mock.iniciar();
    const base = `http://127.0.0.1:${puerto}`;

    const sinKey = await fetch(`${base}/v1/reservations/HC-48213`);
    expect(sinKey.status).toBe(401);
    expect(await sinKey.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });

    const individual = await fetch(`${base}/v1/reservations/HC-48213`, { headers: AUTH });
    expect(individual.status).toBe(200);
    expect(await individual.json()).toMatchObject({
      reservationId: 'HC-48213',
      status: 'confirmed',
      revision: 1,
      hotel: { name: 'Hotel Cordillera', city: 'Santiago' },
    });

    const noExiste = await fetch(`${base}/v1/reservations/HC-99999`, { headers: AUTH });
    expect(noExiste.status).toBe(404);
    expect(await noExiste.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const sinFecha = await fetch(`${base}/v1/reservations`, { headers: AUTH });
    expect(sinFecha.status).toBe(400);
    expect(await sinFecha.json()).toMatchObject({ error: { code: 'INVALID_PARAMETER' } });

    // Generamos 2 cambios posteriores a 12:00Z y paginamos de a 1 con cursor.
    relojMs = Date.parse('2026-11-28T12:05:00Z');
    const mod1 = await fetch(`${base}/admin/reservas/HC-48213/cambiar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkIn: '2026-12-11T15:00:00-03:00' }),
    });
    expect(mod1.status).toBe(200);
    expect(await mod1.json()).toMatchObject({ status: 'modified', revision: 2 });

    relojMs = Date.parse('2026-11-28T12:06:00Z');
    const todas = mock.almacen.listarTodas();
    const otraId = todas.find((r) => r.reservationId !== 'HC-48213')?.reservationId ?? '';
    expect(otraId).not.toBe('');
    await fetch(`${base}/admin/reservas/${otraId}/cancelar`, { method: 'POST' });

    const pag1 = await fetch(`${base}/v1/reservations?modifiedSince=2026-11-28T12:04:00Z&limit=1`, {
      headers: AUTH,
    });
    expect(pag1.status).toBe(200);
    const body1 = (await pag1.json()) as {
      reservations: { reservationId: string; status: string }[];
      nextCursor: string | null;
    };
    expect(body1.reservations).toHaveLength(1);
    expect(body1.reservations[0]?.reservationId).toBe('HC-48213');
    expect(body1.nextCursor).not.toBeNull();

    const pag2 = await fetch(
      `${base}/v1/reservations?modifiedSince=2026-11-28T12:04:00Z&limit=1&cursor=${encodeURIComponent(body1.nextCursor ?? '')}`,
      { headers: AUTH },
    );
    const body2 = (await pag2.json()) as {
      reservations: { reservationId: string; status: string }[];
      nextCursor: string | null;
    };
    expect(body2.reservations).toHaveLength(1);
    expect(body2.reservations[0]).toMatchObject({ reservationId: otraId, status: 'cancelled' });
    expect(body2.nextCursor).toBeNull();
  });

  it('soporta demora, falla 503 y no-responder desde /admin/comportamiento', async () => {
    mock = crearMockHotel({ puerto: 0, logger, apiKey: API_KEY });
    const puerto = await mock.iniciar();
    const base = `http://127.0.0.1:${puerto}`;

    await fetch(`${base}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demoraMs: 120 }),
    });
    const t0 = performance.now();
    const r = await fetch(`${base}/v1/reservations/HC-48213`, { headers: AUTH });
    expect(r.status).toBe(200);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(100);

    await fetch(`${base}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demoraMs: 0, modoFalla: '503' }),
    });
    const r503 = await fetch(`${base}/v1/reservations/HC-48213`, { headers: AUTH });
    expect(r503.status).toBe(503);
    expect(await r503.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });

    await fetch(`${base}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modoFalla: 'no-responder' }),
    });
    await expect(
      fetch(`${base}/v1/reservations/HC-48213`, {
        headers: AUTH,
        signal: AbortSignal.timeout(120),
      }),
    ).rejects.toThrow();
  });
});
