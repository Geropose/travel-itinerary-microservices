import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Convenciones de nombres de los contratos REST que acordamos en la revisión cruzada (P0.5):
// la salud se llama igual en todos los servicios y los parámetros de ruta dicen qué identifican.

const dirOpenApi = fileURLToPath(new URL('../../specs/openapi/', import.meta.url));
const contratos = readdirSync(dirOpenApi).filter((f) => f.endsWith('.yaml') && f !== 'comun.yaml');

/** Claves de ruta del contrato (líneas "  /ruta:" dentro de paths). */
function rutas(texto: string): string[] {
  return [...texto.matchAll(/^ {2}(\/\S*):\s*$/gm)].map((m) => m[1] ?? '');
}

describe.each(contratos)('nombres en %s', (archivo) => {
  const texto = readFileSync(`${dirOpenApi}${archivo}`, 'utf8');

  it('GET /health se llama consultarSalud', () => {
    const salud = /^ {2}\/health:\s*\n {4}get:\s*\n(?: {6}.*\n)*? {6}operationId: (\w+)/m.exec(
      texto,
    );
    expect(salud?.[1]).toBe('consultarSalud');
  });

  it('ningún parámetro de ruta se llama solo {id}', () => {
    expect(rutas(texto).filter((r) => r.includes('{id}'))).toEqual([]);
  });
});
