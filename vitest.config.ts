import { defineConfig } from 'vitest/config';

// Pruebas unitarias y de contrato de cada paquete, servicio y mock, más las pruebas de los
// contratos compartidos (tests/contratos) y los cálculos de las mediciones (tests/carga). Las
// pruebas de todo el sistema (tests/e2e, tests/caos y las mediciones de tests/carga) tienen su
// propio comando.
export default defineConfig({
  test: {
    include: [
      'packages/*/{src,test}/**/*.test.ts',
      'services/*/{src,test}/**/*.test.ts',
      'mocks/*/{src,test}/**/*.test.ts',
      'web/{src,test}/**/*.test.{ts,tsx}',
      'tests/contratos/**/*.test.ts',
      'tests/carga/calculos.test.ts',
      'infra/scripts/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/{e2e,caos}/**'],
  },
});