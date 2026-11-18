// Cliente mínimo de la API de Docker (Engine API) por el socket: listar los contenedores de la
// región y reiniciar uno. No usa ninguna librería: son dos llamadas HTTP.
import { request } from 'node:http';

/** Puerto de GET /health de cada servicio que vigila el monitor (CONVENCIONES 4.2). */
export const PUERTOS: Record<string, number> = {
  gateway: 3000,
  autenticacion: 3001,
  usuarios: 3002,
  correo: 3003,
  viajes: 3004,
  integraciones: 3005,
  analitica: 3006,
  asistente: 3007,
};

/** Un contenedor de la región que tiene que responder al ping. */
export interface Instancia {
  id: string;
  /** Nombre del contenedor, por ejemplo r1-gateway-1. */
  nombre: string;
  /** Etiqueta trotamundos.servicio. */
  servicio: string;
  corriendo: boolean;
  /** http://<ip>:<puerto> en la red de la región; undefined si no está corriendo. */
  url: string | undefined;
}

export interface ClienteDocker {
  /** Instancias de los servicios de PUERTOS en el proyecto de compose de la región. */
  listar(): Promise<Instancia[]>;
  /** Reinicia el contenedor (también lo arranca si estaba detenido). */
  reiniciar(id: string): Promise<void>;
}

interface Contenedor {
  Id: string;
  Names: string[];
  State: string;
  Labels: Record<string, string>;
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
}

/** Pasa la respuesta de GET /containers/json a instancias. */
export function aInstancias(contenedores: Contenedor[], proyecto: string): Instancia[] {
  const instancias: Instancia[] = [];
  for (const c of contenedores) {
    const servicio = c.Labels['trotamundos.servicio'] ?? '';
    const puerto = PUERTOS[servicio];
    if (puerto === undefined) continue;
    const redes = c.NetworkSettings?.Networks ?? {};
    // La IP de la red de la región, que es la que comparte con el monitor.
    const ip = redes[`${proyecto}_region`]?.IPAddress;
    const corriendo = c.State === 'running';
    instancias.push({
      id: c.Id,
      nombre: (c.Names[0] ?? c.Id).replace(/^\//, ''),
      servicio,
      corriendo,
      url: corriendo && ip ? `http://${ip}:${puerto}` : undefined,
    });
  }
  return instancias.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

export interface OpcionesDocker {
  /** Socket de Docker (por defecto /var/run/docker.sock). */
  socket: string;
  /** Proyecto de docker compose de la región (r1 o r2). */
  proyecto: string;
  /** Segundos que Docker espera antes de matar el contenedor al reiniciarlo. */
  esperaReinicioSeg?: number;
}

function llamar(socket: string, metodo: string, ruta: string): Promise<unknown> {
  return new Promise((resolver, rechazar) => {
    const req = request({ socketPath: socket, method: metodo, path: ruta }, (res) => {
      let cuerpo = '';
      res.setEncoding('utf8');
      res.on('data', (parte: string) => (cuerpo += parte));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status >= 300) {
          rechazar(new Error(`Docker respondió ${status} a ${metodo} ${ruta}: ${cuerpo}`));
          return;
        }
        resolver(cuerpo ? (JSON.parse(cuerpo) as unknown) : undefined);
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error('Docker no respondió')));
    req.on('error', rechazar);
    req.end();
  });
}

export function crearClienteDocker(o: OpcionesDocker): ClienteDocker {
  const filtros = encodeURIComponent(
    JSON.stringify({ label: [`com.docker.compose.project=${o.proyecto}`, 'trotamundos.servicio'] }),
  );
  return {
    async listar() {
      // all=true: también los detenidos (una instancia que se cayó sigue en la lista).
      const contenedores = (await llamar(
        o.socket,
        'GET',
        `/containers/json?all=true&filters=${filtros}`,
      )) as Contenedor[];
      return aInstancias(contenedores, o.proyecto);
    },
    async reiniciar(id) {
      const t = o.esperaReinicioSeg ?? 5;
      await llamar(o.socket, 'POST', `/containers/${encodeURIComponent(id)}/restart?t=${t}`);
    },
  };
}
