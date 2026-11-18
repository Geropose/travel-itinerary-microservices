// Arranque del enrutador global: lee la configuración y empieza a escuchar.
import { cargarConfig, crearLogger } from '@trotamundos/comun';
import { crearApp } from './app.ts';
import { esquemaConfig } from './config.ts';

const config = cargarConfig(esquemaConfig);
// No es de ninguna región: está delante de las dos (Iteración 6).
const logger = crearLogger({ servicio: 'enrutador', region: 'global', nivel: config.NIVEL_LOG });

const enrutador = crearApp({
  puerto: config.PUERTO,
  logger,
  regiones: { 'region-1': config.URL_REGION_1, 'region-2': config.URL_REGION_2 },
  regionPorDefecto: config.REGION_POR_DEFECTO,
  tiempoMaximoMs: config.TIEMPO_MAXIMO_MS,
  limiteCuerpo: config.LIMITE_CUERPO,
});

for (const senal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(senal, () => {
    void enrutador.detener().then(() => process.exit(0));
  });
}

await enrutador.iniciar();
