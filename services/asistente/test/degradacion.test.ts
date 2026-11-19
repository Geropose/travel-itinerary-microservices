// Pruebas unitarias de P2.D5 (sin Docker):
// - Métricas de tiempo de respuesta por mensaje (QA-12: < 3 s, percentiles y logs Pino).
// - Timeouts de 2 s y clasificación de errores en `crearClientesAsistente` (ADR-019).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loggerDePrueba, USUARIO_PRUEBA } from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearClientesAsistente, ErrorDependenciaNoDisponible } from '../src/clientes.ts';
import { crearMetricasAsistente } from '../src/metricas.ts';

describe('Métricas de latencia del asistente (QA-12)', () => {
  it('calcula percentiles, porcentaje QA-12 y emite logs estructurados en Pino', () => {
    const { logger, lineas } = loggerDePrueba('asistente');
    const metricas = crearMetricasAsistente(logger);

    metricas.registrar({
      conversacionId: 'c-1',
      intencion: 'problemaMenor',
      estado: 'respondido',
      resultado: 'respondido',
      duracionMs: 42.3,
    });
    metricas.registrar({
      conversacionId: 'c-1',
      intencion: 'estado',
      estado: 'respondido',
      resultado: 'respondido',
      duracionMs: 210.5,
    });
    metricas.registrar({
      conversacionId: 'c-1',
      intencion: 'reprogramar',
      estado: 'consultando',
      resultado: 'consultando',
      duracionMs: 3020,
    });
    metricas.registrar({
      conversacionId: 'c-1',
      intencion: 'estado',
      estado: 'respondido',
      resultado: 'respondido',
      duracionMs: 3600,
    });

    const resumen = metricas.resumen();
    expect(resumen.total).toBe(4);
    expect(resumen.cumplenQa12).toBe(3);
    expect(resumen.porcentajeQa12).toBe(75);
    expect(resumen.maximoMs).toBe(3600);
    expect(resumen.p50Ms).toBe(210.5);
    expect(lineas).toHaveLength(4);
    expect(lineas[0]?.cumpleQa12).toBe(true);
    expect(lineas[3]?.cumpleQa12).toBe(false);
  });
});

describe('Clientes HTTP del asistente: timeout de 2 s y clasificación de fallas (ADR-019)', () => {
  let servidorLento: Server;
  let urlLento = '';

  beforeAll(async () => {
    servidorLento = createServer((req, res) => {
      if (req.url?.startsWith('/503-proveedor')) {
        res.writeHead(503, { 'Content-Type': 'application/problem+json' });
        res.end(
          JSON.stringify({
            type: 'https://trotamundos.example/errores/tercero-no-disponible',
            title: 'Tercero no disponible',
            status: 503,
            requestId: 'req-1',
          }),
        );
        return;
      }
      // Simula servicio colgado sin responder (más de 2 s).
      const t = setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ reservas: [] }));
        }
      }, 5000);
      res.once('close', () => clearTimeout(t));
    });
    await new Promise<void>((resolve) => {
      servidorLento.listen(0, () => resolve());
    });
    const puerto = (servidorLento.address() as AddressInfo).port;
    urlLento = `http://127.0.0.1:${puerto}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      servidorLento.close(() => resolve());
      servidorLento.closeAllConnections();
    });
  });

  it('corta a los 2 s (configurable) cuando Viajes o Usuarios no responden y clasifica el servicio', async () => {
    const clientes = crearClientesAsistente({
      urlViajes: urlLento,
      urlUsuarios: urlLento,
      urlIntegraciones: urlLento,
      timeoutServiciosMs: 300,
    });

    const inicio = Date.now();
    await expect(clientes.viajes.listarReservas(USUARIO_PRUEBA, 'jwt')).rejects.toMatchObject({
      name: ErrorDependenciaNoDisponible.name,
      servicio: 'viajes',
    });
    expect(Date.now() - inicio).toBeLessThan(1200);

    await expect(clientes.usuarios.obtenerPerfil('jwt')).rejects.toMatchObject({
      name: ErrorDependenciaNoDisponible.name,
      servicio: 'usuarios',
    });
  });
});
