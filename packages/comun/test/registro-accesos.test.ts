import { describe, expect, it } from 'vitest';
import { crearEvento, validadorEventos, type Sobre, type TipoEvento } from '../src/eventos.ts';
import { loggerDePrueba } from '../src/pruebas/index.ts';
import { registroPorEvento, type AccesoRechazado } from '../src/registro-accesos.ts';

const rechazo: AccesoRechazado = {
  servicio: 'viajes',
  metodo: 'GET',
  ruta: '/viajes/9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e',
  status: 403,
  motivo: 'sin-permiso',
  usuarioId: '6c1e8a2f-4b3d-4e5f-9a0b-1c2d3e4f5a6b',
  ip: '10.0.0.7',
  requestId: '7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c',
};

describe('registroPorEvento', () => {
  it('publica un AccesoRechazado que cumple su esquema, sin esperar', async () => {
    const publicados: Sobre<unknown>[] = [];
    const registrar = registroPorEvento(
      {
        publicarEvento: async <D>(tipo: TipoEvento, datos: D) => {
          const sobre = crearEvento(tipo, datos, 'region-1');
          validadorEventos().validar(sobre);
          publicados.push(sobre);
          return sobre;
        },
      },
      loggerDePrueba().logger,
    );
    expect(registrar(rechazo)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(publicados[0]).toMatchObject({ tipo: 'AccesoRechazado', datos: rechazo });
  });

  it('si el broker falla no rompe la solicitud: queda en el log', async () => {
    const { logger, lineas } = loggerDePrueba();
    const registrar = registroPorEvento(
      {
        publicarEvento: () => Promise.reject(new Error('broker caído')),
      },
      logger,
    );
    expect(() => registrar(rechazo)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(
      lineas.some((l) => l.nivel === 'warn' && l.mensaje === 'No se pudo publicar AccesoRechazado'),
    ).toBe(true);
  });
});
