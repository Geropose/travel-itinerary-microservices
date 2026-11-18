// Spec-driven (CONST-5): los tipos del cliente tienen que salir de los contratos actuales. Si un
// contrato cambió, esta prueba falla hasta correr npm run web:api.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generar, rutaGenerado, SERVICIOS_WEB } from '../scripts/generar-api.ts';

describe('tipos generados desde specs/openapi', () => {
  it.each(SERVICIOS_WEB)('web/src/api/generado/%s.ts está al día', async (servicio) => {
    const actual = readFileSync(rutaGenerado(servicio), 'utf8');
    expect(actual === (await generar(servicio)), 'Correr npm run web:api').toBe(true);
  });
});
