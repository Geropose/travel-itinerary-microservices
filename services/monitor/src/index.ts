// Arranque del monitor de salud: lee la configuración, conecta con la API de Docker, empieza el
// ping-echo de las instancias de la región y escucha.
import { cargarConfig, crearLogger } from '@trotamundos/comun';
import { crearApp, SERVICIO } from './app.ts';
import { esquemaConfig } from './config.ts';
import { crearClienteDocker } from './docker.ts';
import { crearVigilante } from './vigilante.ts';

const config = cargarConfig(esquemaConfig);
const logger = crearLogger({ servicio: SERVICIO, region: config.REGION, nivel: config.NIVEL_LOG });

const docker = crearClienteDocker({
  socket: config.SOCKET_DOCKER,
  proyecto: config.PROYECTO_DOCKER,
});
const vigilante = crearVigilante({
  docker,
  logger,
  intervaloMs: config.INTERVALO_PING_MS,
  fallasParaCaida: config.FALLAS_PARA_CAIDA,
  tiempoPingMs: config.TIEMPO_PING_MS,
  graciaReinicioMs: config.GRACIA_REINICIO_MS,
});

const servidor = crearApp({
  region: config.REGION,
  puerto: config.PUERTO,
  logger,
  vigilante,
  chequeos: {
    // Sin la API de Docker no puede vigilar ni reiniciar nada.
    docker: () => docker.listar(),
  },
});
servidor.alApagar(async () => vigilante.detener());

await servidor.iniciar();
vigilante.iniciar();
logger.info(
  { proyecto: config.PROYECTO_DOCKER, intervaloMs: config.INTERVALO_PING_MS },
  'Monitor de salud vigilando la región',
);
