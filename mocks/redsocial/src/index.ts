// Arranque del mock de Red Social (puerto 4007).
import { cargarConfig, crearLogger } from '@trotamundos/comun';
import { crearMockRedSocial } from './app.ts';
import { esquemaConfig } from './config.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({
  servicio: 'mock-redsocial',
  region: 'global',
  nivel: config.NIVEL_LOG,
});

const mock = crearMockRedSocial({
  puerto: config.PUERTO,
  logger,
  apiToken: config.API_TOKEN,
  urlPublica: config.URL_PUBLICA,
  cuenta: config.CUENTA,
});

for (const senal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(senal, () => {
    void mock.detener().then(() => process.exit(0));
  });
}

await mock.iniciar();
