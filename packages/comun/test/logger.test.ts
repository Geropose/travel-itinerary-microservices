import { describe, expect, it } from 'vitest';
import { conContexto } from '../src/contexto.ts';
import { loggerDePrueba } from '../src/pruebas/index.ts';

describe('logger', () => {
  it('cada línea lleva servicio y region, y el requestId dentro de una solicitud', () => {
    const { logger, lineas } = loggerDePrueba('viajes', 'region-2');
    logger.info('afuera');
    conContexto({ requestId: '7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c' }, () =>
      logger.info('adentro'),
    );
    expect(lineas[0]).toMatchObject({
      servicio: 'viajes',
      region: 'region-2',
      mensaje: 'afuera',
      nivel: 'info',
    });
    expect(lineas[0]).not.toHaveProperty('requestId');
    expect(lineas[1]).toMatchObject({
      requestId: '7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c',
      mensaje: 'adentro',
    });
  });

  it('nunca escribe el token', () => {
    const { logger, lineas } = loggerDePrueba();
    logger.info({ headers: { authorization: 'Bearer secreto' }, token: 'secreto' }, 'pedido');
    expect(JSON.stringify(lineas[0])).not.toContain('secreto');
  });
});
