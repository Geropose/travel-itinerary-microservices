import { defineConfig, devices } from '@playwright/test';

// Pruebas de la aplicación compilada (vite preview, con el service worker), en una computadora y en
// un teléfono (CONST-1). La API se simulan con el contrato (e2e/api-falsa.ts): no hace falta
// levantar el sistema. npm run e2e:web
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'computadora', use: { ...devices['Desktop Chrome'], locale: 'es-AR' } },
    { name: 'telefono', use: { ...devices['Pixel 7'], locale: 'es-AR' } },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
