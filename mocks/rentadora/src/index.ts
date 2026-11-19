// Arranque del mock de Rentadora Sur (puerto 4005).
import { cargarConfig, crearLogger } from '@trotamundos/comun';
import { crearMockRentadora } from './app.ts';
import { esquemaConfig } from './config.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({
  servicio: 'mock-rentadora',
  region: 'global',
  nivel: config.NIVEL_LOG,
});

const mock = crearMockRentadora({
  puerto: config.PUERTO,
  logger,
  apiKey: config.API_KEY,
  semillas: config.SEMILLAS,
});

for (const senal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(senal, () => {
    void mock.detener().then(() => process.exit(0));
  });
}

await mock.iniciar();
