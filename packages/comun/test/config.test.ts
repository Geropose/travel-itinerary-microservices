import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cargarConfig, esquemaBase } from '../src/config.ts';

class Salida extends Error {
  readonly codigo: number;
  constructor(codigo: number) {
    super(`salir(${codigo})`);
    this.codigo = codigo;
  }
}

const esquema = esquemaBase.extend({ URL_BASE: z.url() });
const salir = (codigo: number): never => {
  throw new Salida(codigo);
};

describe('cargarConfig', () => {
  it('devuelve la configuración tipada y con valores por defecto', () => {
    const config = cargarConfig(esquema, {
      env: { REGION: 'region-1', PUERTO: '3002', URL_BASE: 'postgres://u:c@db:5432/usuarios' },
      salir,
    });
    expect(config).toEqual({
      REGION: 'region-1',
      PUERTO: 3002,
      NIVEL_LOG: 'info',
      URL_BASE: 'postgres://u:c@db:5432/usuarios',
    });
  });

  it('si falta una variable escribe un error claro y termina con código 1', () => {
    let texto = '';
    expect(() =>
      cargarConfig(esquema, {
        env: { REGION: 'region-3', PUERTO: '3002' },
        salir,
        escribir: (t) => (texto += t),
      }),
    ).toThrow(Salida);
    expect(texto).toContain('Configuración inválida');
    expect(texto).toContain('REGION');
    expect(texto).toContain('URL_BASE');
    expect(texto).not.toContain('PUERTO');
  });
});
