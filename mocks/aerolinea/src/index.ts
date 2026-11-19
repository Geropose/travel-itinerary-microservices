// Arranque del mock de Aerolínea Andina (puerto 4003).
import { cargarConfig, crearLogger } from '@trotamundos/comun';
import { crearMockAerolinea } from './app.ts';
import { esquemaConfig, leerUrlsWebhook } from './config.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({
  servicio: 'mock-aerolinea',
  region: 'global',
  nivel: config.NIVEL_LOG,
});

const mock = crearMockAerolinea({
  puerto: config.PUERTO,
  logger,
  apiKey: config.API_KEY,
  webhookSecret: config.WEBHOOK_SECRET,
  webhookUrls: leerUrlsWebhook(config.WEBHOOK_URLS),
  semillas: config.SEMILLAS,
});

for (const senal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(senal, () => {
    void mock.detener().then(() => process.exit(0));
  });
}

await mock.iniciar();
