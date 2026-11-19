// Pruebas del mock de Rentadora Sur contra specs/externos/rentadora.md:
// autenticación Bearer, paginación por page/pageSize con updatedSince, estados en mayúsculas,
// consulta individual, cambios/cancelaciones desde /admin, demoras y fallas (503 / no-responder).
import { crearLogger } from '@trotamundos/comun';
import { afterEach, describe, expect, it } from 'vitest';
import { crearMockRentadora, type MockRentadora } from '../src/app.ts';

const API_KEY = 'clave-prueba-rentadora-123';
const AUTH = { Authorization: `Bearer ${API_KEY}` };
const logger = crearLogger({ servicio: 'mock-rentadora-test', region: 'global', nivel: 'error' });

describe('mocks/rentadora (specs/externos/rentadora.md)', () => {
  let mock: MockRentadora | undefined;

  afterEach(async () => {
    await mock?.detener();
    mock = undefined;
  });

  it('valida Bearer, consulta individual, updatedSince y paginación por número de página', async () => {
    let relojMs = Date.parse('2026-11-28T12:00:00Z');
    mock = crearMockRentadora({
      puerto: 0,
      logger,
      apiKey: API_KEY,
      semillas: true,
      reloj: () => relojMs,
    });
    const puerto = await mock.iniciar();
    const base = `http://127.0.0.1:${puerto}`;

    const sinAuth = await fetch(`${base}/api/v1/bookings/RS-77120`);
    expect(sinAuth.status).toBe(401);
    expect(await sinAuth.json()).toMatchObject({ status: 401, errorCode: 'UNAUTHORIZED' });

    const individual = await fetch(`${base}/api/v1/bookings/RS-77120`, { headers: AUTH });
    expect(individual.status).toBe(200);
    expect(await individual.json()).toMatchObject({
      confirmationNumber: 'RS-77120',
      status: 'CONFIRMED',
      version: 1,
      vehicle: { acrissCode: 'ECMR', make: 'Toyota', model: 'Yaris' },
    });

    const noExiste = await fetch(`${base}/api/v1/bookings/RS-99999`, { headers: AUTH });
    expect(noExiste.status).toBe(404);
    expect(await noExiste.json()).toMatchObject({ status: 404, errorCode: 'BOOKING_NOT_FOUND' });

    const sinFecha = await fetch(`${base}/api/v1/bookings`, { headers: AUTH });
    expect(sinFecha.status).toBe(400);
    expect(await sinFecha.json()).toMatchObject({ status: 400, errorCode: 'INVALID_REQUEST' });

    // Generamos 2 actualizaciones y consultamos con pageSize=1.
    relojMs = Date.parse('2026-11-28T12:05:00Z');
    await fetch(`${base}/admin/reservas/RS-77120/cancelar`, { method: 'POST' });

    relojMs = Date.parse('2026-11-28T12:07:00Z');
    const otra = mock.almacen.listarTodas().find((b) => b.confirmationNumber !== 'RS-77120');
    expect(otra).toBeDefined();
    await fetch(`${base}/admin/reservas/${otra?.confirmationNumber}/cambiar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicleModel: 'Corolla' }),
    });

    const p1 = await fetch(
      `${base}/api/v1/bookings?updatedSince=2026-11-28T12:04:00Z&page=1&pageSize=1`,
      { headers: AUTH },
    );
    expect(p1.status).toBe(200);
    expect(await p1.json()).toMatchObject({
      page: 1,
      pageSize: 1,
      totalCount: 2,
      bookings: [{ confirmationNumber: 'RS-77120', status: 'CANCELLED', version: 2 }],
    });

    const p2 = await fetch(
      `${base}/api/v1/bookings?updatedSince=2026-11-28T12:04:00Z&page=2&pageSize=1`,
      { headers: AUTH },
    );
    expect(await p2.json()).toMatchObject({
      page: 2,
      pageSize: 1,
      totalCount: 2,
      bookings: [
        {
          confirmationNumber: otra?.confirmationNumber,
          status: 'MODIFIED',
          vehicle: { model: 'Corolla' },
        },
      ],
    });
  });

  it('soporta demora, 503 y no-responder desde /admin/comportamiento', async () => {
    mock = crearMockRentadora({ puerto: 0, logger, apiKey: API_KEY });
    const puerto = await mock.iniciar();
    const base = `http://127.0.0.1:${puerto}`;

    await fetch(`${base}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demoraMs: 120 }),
    });
    const t0 = performance.now();
    const ok = await fetch(`${base}/api/v1/bookings/RS-77120`, { headers: AUTH });
    expect(ok.status).toBe(200);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(100);

    await fetch(`${base}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demoraMs: 0, modoFalla: '503' }),
    });
    const r503 = await fetch(`${base}/api/v1/bookings/RS-77120`, { headers: AUTH });
    expect(r503.status).toBe(503);
    expect(await r503.json()).toMatchObject({ status: 503, errorCode: 'SERVICE_UNAVAILABLE' });

    await fetch(`${base}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modoFalla: 'no-responder' }),
    });
    await expect(
      fetch(`${base}/api/v1/bookings/RS-77120`, {
        headers: AUTH,
        signal: AbortSignal.timeout(120),
      }),
    ).rejects.toThrow();
  });
});
