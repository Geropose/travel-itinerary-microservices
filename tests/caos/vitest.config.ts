import { defineConfig } from 'vitest/config';

// Pruebas de caos: rompen a propósito una parte del sistema levantado (npm run infra:levantar) y
// comprueban que sigue atendiendo (QA-4, ADR-006 a ADR-008, ADR-011, ADR-012).
// Corren de a una: npm run caos. Se usa 5 min por prueba para permitir pausas de 2 min en Viajes.
export default defineConfig({
  test: {
    root: 'tests/caos',
    include: ['**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
