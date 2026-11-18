// Cache local del panel en IndexedDB (QA-3), con fake-indexeddb en lugar del navegador.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { borrarPanel, guardarPanel, leerPanel, type Panel } from '../src/cache/panel.ts';

const panel: Panel = {
  viajes: [
    {
      viajeId: '9b2d6c1e-1f4a-4b7e-8c3d-2a1b0c9d8e7f',
      usuarioId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      destino: 'Santiago de Chile',
      inicio: '2026-12-10T09:00:00Z',
      fin: '2026-12-15T18:00:00Z',
      estado: 'activo',
      reservas: [],
    },
  ],
};

describe('guardarPanel / leerPanel', () => {
  it('guarda el último panel de cada usuario y lo devuelve con la fecha', async () => {
    const ahora = new Date('2026-11-20T13:45:00Z');
    await guardarPanel('usuario-a', panel, ahora);
    await guardarPanel('usuario-b', { viajes: [] }, ahora);
    expect(await leerPanel('usuario-a')).toEqual({ panel, guardadoEn: '2026-11-20T13:45:00.000Z' });
    expect((await leerPanel('usuario-b'))?.panel.viajes).toEqual([]);
  });

  it('reemplaza el anterior, y sin panel guardado devuelve undefined', async () => {
    await guardarPanel('usuario-c', panel);
    await guardarPanel('usuario-c', { viajes: [] });
    expect((await leerPanel('usuario-c'))?.panel).toEqual({ viajes: [] });
    expect(await leerPanel('nadie')).toBeUndefined();
  });

  it('al cerrar sesión se borra', async () => {
    await guardarPanel('usuario-d', panel);
    await borrarPanel('usuario-d');
    expect(await leerPanel('usuario-d')).toBeUndefined();
  });
});
