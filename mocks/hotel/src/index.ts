// Arranque del mock de Hotel Cordillera (puerto 4004).
import { cargarConfig, crearLogger } from '@trotamundos/comun';
import { crearMockHotel } from './app.ts';
import { esquemaConfig } from './config.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({ servicio: 'mock-hotel', region: 'global', nivel: config.NIVEL_LOG });

const mock = crearMockHotel({
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
