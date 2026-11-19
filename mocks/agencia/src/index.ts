// Arranque del mock de Viajes del Plata / agencia (puerto 4006).
import { cargarConfig, crearLogger } from '@trotamundos/comun';
import { crearMockAgencia } from './app.ts';
import { esquemaConfig } from './config.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({ servicio: 'mock-agencia', region: 'global', nivel: config.NIVEL_LOG });

const mock = crearMockAgencia({
  puerto: config.PUERTO,
  logger,
  apiKey: config.API_KEY,
});

for (const senal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(senal, () => {
    void mock.detener().then(() => process.exit(0));
  });
}

await mock.iniciar();
