// Arranque del mock de Outlook: lee la configuración, carga las semillas y empieza a escuchar.
import { cargarConfig, crearLogger } from '@trotamundos/comun';
import { crearMock } from './app.ts';
import { esquemaConfig } from './config.ts';

const config = cargarConfig(esquemaConfig);
// Como Microsoft Graph, no es de ninguna región: lo usan las dos.
const logger = crearLogger({ servicio: 'mock-outlook', region: 'global', nivel: config.NIVEL_LOG });

const mock = crearMock({
  puerto: config.PUERTO,
  logger,
  clientId: config.CLIENT_ID,
  clientSecret: config.CLIENT_SECRET,
  redirectUris: config.REDIRECT_URIS.split(',')
    .map((u) => u.trim())
    .filter(Boolean),
  vidaTokenS: config.VIDA_TOKEN_S,
  limiteSolicitudes: config.LIMITE_SOLICITUDES,
  ventanaLimiteS: config.VENTANA_LIMITE_S,
  semillas: config.SEMILLAS,
});

for (const senal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(senal, () => {
    void mock.detener().then(() => process.exit(0));
  });
}

await mock.iniciar();
