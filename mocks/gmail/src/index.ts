// Arranque del mock de Gmail: lee la configuración, carga las semillas y empieza a escuchar.
import { cargarConfig, crearLogger } from '@trotamundos/comun';
import { crearMock } from './app.ts';
import { leerSuscripciones } from './avisos.ts';
import { esquemaConfig } from './config.ts';

const config = cargarConfig(esquemaConfig);
// Como el Gmail real, no es de ninguna región: lo usan las dos.
const logger = crearLogger({ servicio: 'mock-gmail', region: 'global', nivel: config.NIVEL_LOG });

const mock = crearMock({
  puerto: config.PUERTO,
  logger,
  clientId: config.CLIENT_ID,
  clientSecret: config.CLIENT_SECRET,
  redirectUris: config.REDIRECT_URIS.split(',')
    .map((u) => u.trim())
    .filter(Boolean),
  vidaTokenS: config.VIDA_TOKEN_S,
  cuotaPorMinuto: config.CUOTA_POR_MINUTO,
  suscripciones: leerSuscripciones(config.SUSCRIPCIONES_PUSH),
  semillas: config.SEMILLAS,
});

for (const senal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(senal, () => {
    void mock.detener().then(() => process.exit(0));
  });
}

await mock.iniciar();
