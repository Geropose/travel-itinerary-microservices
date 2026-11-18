import { defineConfig } from 'vitest/config';

// Pruebas de caos: rompen a propósito una parte del sistema levantado (npm run infra:levantar) y
// comprueban que sigue atendiendo (QA-4, ADR-006 a ADR-008). Corren de a una: npm run caos.
export default defineConfig({
  test: {
    root: 'tests/caos',
    include: ['**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
