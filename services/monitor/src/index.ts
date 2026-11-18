// Arranque de monitor: lee la configuración, abre las conexiones y empieza a escuchar.
import { cargarConfig, crearLogger } from '@trotamundos/comun';
import { crearApp, SERVICIO } from './app.ts';
import { esquemaConfig } from './config.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({ servicio: SERVICIO, region: config.REGION, nivel: config.NIVEL_LOG });

const servidor = crearApp({
  region: config.REGION,
  puerto: config.PUERTO,
  logger,
});

await servidor.iniciar();
