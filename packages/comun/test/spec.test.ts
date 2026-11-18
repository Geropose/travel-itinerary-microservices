import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cargarSpec } from '../src/spec.ts';

const usuarios = fileURLToPath(new URL('../../../specs/openapi/usuarios.yaml', import.meta.url));

describe('cargarSpec', () => {
  const spec = cargarSpec(usuarios);

  it('resuelve los $ref a comun.yaml y deja un único servidor "/"', () => {
    const texto = JSON.stringify(spec.documento);
    expect(texto).not.toContain('"$ref":"./comun.yaml');
    expect(spec.documento.servers).toEqual([{ url: '/' }]);
    expect(texto).not.toContain('http://usuarios:3002');
  });

  it('calcula la seguridad de cada operación', () => {
    expect(spec.buscar('GET', '/health')?.seguridad).toEqual([]);
    const permiso = spec.buscar(
      'get',
      '/interna/permisos/itinerarios/9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e',
    );
    expect(permiso).toMatchObject({
      metodo: 'GET',
      ruta: '/interna/permisos/itinerarios/{viajeId}',
      operationId: 'consultarPermisoItinerario',
      seguridad: ['bearerJWT'],
    });
    expect(spec.buscar('POST', '/interna/cuentas')?.seguridad).toEqual(['tokenServicio']);
    expect(spec.buscar('GET', '/no-existe')).toBeUndefined();
  });

  it('todos los contratos de specs/openapi se cargan', async () => {
    const { readdirSync } = await import('node:fs');
    const dir = fileURLToPath(new URL('../../../specs/openapi/', import.meta.url));
    for (const archivo of readdirSync(dir).filter(
      (f) => f.endsWith('.yaml') && f !== 'comun.yaml',
    )) {
      const cargado = cargarSpec(`${dir}${archivo}`);
      expect(cargado.operaciones.length, archivo).toBeGreaterThan(0);
      expect(JSON.stringify(cargado.documento), archivo).not.toMatch(/"\$ref":"[^#]/);
    }
  });
});
