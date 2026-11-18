// Enrutador global (specs/openapi/gateway.yaml, sección Enrutador global; Iteración 6, ADR-017):
// el único punto de entrada de la web. Manda cada solicitud al nginx de una región, sin cambiarla.
import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  request as pedirHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import {
  aProblema,
  conContexto,
  errores,
  manejadorErrores,
  type Logger,
  type Region,
} from '@trotamundos/comun';
import express, { type Request, type RequestHandler, type Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { elegirRegion, esRegion, type Motivo } from './region.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Operaciones en las que Autenticación puede responder 307 hacia la otra región (ADR-017). */
export const RUTAS_CON_307 = ['/api/autenticacion/login', '/api/autenticacion/registro'];

/** Headers de un solo tramo (RFC 9110): no se reenvían. */
const DE_UN_TRAMO = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'host',
  'content-length',
]);

export interface OpcionesApp {
  puerto: number;
  logger: Logger;
  /** URL del nginx de cada región. */
  regiones: Record<Region, string>;
  /** Región para las solicitudes sin JWT, prefijo ni X-Region. */
  regionPorDefecto: Region;
  /** Tiempo máximo para que responda la región (por defecto 10 s); si no, 503. */
  tiempoMaximoMs?: number;
  /** Tamaño máximo del cuerpo del login y el registro (por defecto 1mb); si lo supera, 413. */
  limiteCuerpo?: string;
}

export interface Enrutador {
  app: express.Express;
  /** Empieza a escuchar. Devuelve el puerto. */
  iniciar(): Promise<number>;
  /** Deja de aceptar solicitudes y espera las que están en curso. */
  detener(): Promise<void>;
}

/** Datos de la solicitud que se guardan en res.locals para el log. */
interface Locales {
  region?: Region;
  motivo?: Motivo;
  reenviadaA?: Region;
}

const locales = (res: Response) => res.locals as Locales;

/** Ruta para el log: sin la query y con los emails tapados (por ejemplo .../designados/{email}). */
export function rutaParaLog(ruta: string): string {
  return ruta
    .split('/')
    .map((parte) => (/@|%40/i.test(parte) ? ':email' : parte))
    .join('/');
}

interface RespuestaRegion {
  status: number;
  headers: IncomingHttpHeaders;
  cuerpo: Buffer;
}

/** Copia los headers que se pueden reenviar, más los X-Forwarded-* (como el proxy). */
function headersParaRegion(req: Request, cuerpo: Buffer): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [nombre, valor] of Object.entries(req.headers)) {
    if (valor !== undefined && !DE_UN_TRAMO.has(nombre)) headers[nombre] = valor;
  }
  const ip = req.socket.remoteAddress ?? '';
  const previo = req.headers['x-forwarded-for'];
  headers['x-forwarded-for'] = previo ? `${String(previo)},${ip}` : ip;
  headers['x-forwarded-proto'] = 'http';
  if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;
  headers['content-length'] = cuerpo.length;
  return headers;
}

/** Manda la solicitud (con el cuerpo ya leído) a una región y lee la respuesta entera. */
function enviar(
  base: string,
  req: Request,
  cuerpo: Buffer,
  tiempoMaximoMs: number,
): Promise<RespuestaRegion> {
  return new Promise((resolver, rechazar) => {
    const pedido = pedirHttp(
      new URL(req.url, base),
      { method: req.method, headers: headersParaRegion(req, cuerpo), timeout: tiempoMaximoMs },
      (respuesta) => {
        const trozos: Buffer[] = [];
        respuesta.on('data', (trozo: Buffer) => trozos.push(trozo));
        respuesta.on('error', rechazar);
        respuesta.on('end', () =>
          resolver({
            status: respuesta.statusCode ?? 502,
            headers: respuesta.headers,
            cuerpo: Buffer.concat(trozos),
          }),
        );
      },
    );
    pedido.on('timeout', () => pedido.destroy(new Error('tiempo agotado')));
    pedido.on('error', rechazar);
    pedido.end(cuerpo);
  });
}

/** Región del cuerpo de un 307 de Autenticación ({"region": "region-2"}), si es válida. */
function regionDel307(cuerpo: Buffer): Region | undefined {
  try {
    const datos: unknown = JSON.parse(cuerpo.toString('utf8'));
    const region =
      typeof datos === 'object' && datos !== null
        ? (datos as Record<string, unknown>).region
        : undefined;
    return esRegion(region) ? region : undefined;
  } catch {
    return undefined;
  }
}

/** 503 problem+json si la región no responde (o no responde a tiempo). */
function regionNoDisponible(region: Region, logger: Logger) {
  return (error: Error, req: IncomingMessage, res: ServerResponse | Socket) => {
    logger.warn({ err: error, regionDestino: region }, 'La región no respondió');
    if (!('writeHead' in res) || res.headersSent) {
      // Ya se había empezado a mandar la respuesta: lo único posible es cortarla.
      res.destroy();
      return;
    }
    const problema = aProblema(
      errores.noDisponible(`La región ${region} no respondió. Probá de nuevo.`),
      String(req.headers['x-request-id'] ?? ''),
    );
    res.writeHead(503, { 'content-type': 'application/problem+json; charset=utf-8' });
    res.end(JSON.stringify(problema));
  };
}

/**
 * Arma el enrutador global. Por cada solicitud: X-Request-Id, elección de la región (JWT, prefijo,
 * X-Region o región por defecto) y proxy al nginx de esa región. En el login y el registro, si la
 * región responde 307 hacia la otra, repite la solicitud ahí (ADR-017). No guarda cuerpos ni los
 * escribe en el log.
 */
export function crearApp(o: OpcionesApp): Enrutador {
  const { logger } = o;
  const tiempoMaximoMs = o.tiempoMaximoMs ?? 10_000;
  const app = express();
  app.disable('x-powered-by');
  let servidorHttp: Server | undefined;
  let apagando = false;

  // X-Request-Id y una línea de log por solicitud: método, ruta, status, región y motivo. Nunca el
  // cuerpo, los headers, la query ni la IP (datos personales).
  app.use((req, res, next) => {
    const recibido = req.headers['x-request-id'];
    const requestId = typeof recibido === 'string' && UUID.test(recibido) ? recibido : randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-Id', requestId);
    const ruta = rutaParaLog(req.path);
    conContexto({ requestId }, () => {
      const inicio = performance.now();
      res.on(
        'finish',
        AsyncResource.bind(() => {
          const { region, motivo, reenviadaA } = locales(res);
          logger.info(
            {
              metodo: req.method,
              ruta,
              status: res.statusCode,
              ...(region ? { regionDestino: region, motivo } : {}),
              ...(reenviadaA ? { reenviadaA } : {}),
              duracionMs: Math.round((performance.now() - inicio) * 10) / 10,
            },
            'Solicitud enrutada',
          );
        }),
      );
      next();
    });
  });

  app.get('/health', (_req, res) => {
    if (apagando) throw errores.noDisponible('Apagando.');
    res.json({ estado: 'ok' });
  });

  // Región de la solicitud. Se quita el prefijo /region-N de la URL, si lo tiene.
  app.use((req, res, next) => {
    const eleccion = elegirRegion(
      { url: req.url, authorization: req.headers.authorization, xRegion: req.headers['x-region'] },
      o.regionPorDefecto,
    );
    locales(res).region = eleccion.region;
    locales(res).motivo = eleccion.motivo;
    req.url = eleccion.url;
    next();
  });

  // Login y registro: se lee el cuerpo para poder repetirlo en la otra región si responde 307.
  // El cuerpo solo pasa: no se guarda ni se escribe en el log.
  app.post(
    RUTAS_CON_307,
    express.raw({ type: () => true, limit: o.limiteCuerpo ?? '1mb', inflate: false }),
    async (req, res) => {
      const cuerpo: unknown = req.body;
      const datos = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.alloc(0);
      const region = locales(res).region ?? o.regionPorDefecto;
      const aRegion = async (destino: Region) => {
        try {
          return await enviar(o.regiones[destino], req, datos, tiempoMaximoMs);
        } catch (error) {
          logger.warn({ err: error, regionDestino: destino }, 'La región no respondió');
          throw errores.noDisponible(`La región ${destino} no respondió. Probá de nuevo.`);
        }
      };
      let respuesta = await aRegion(region);
      const otra = respuesta.status === 307 ? regionDel307(respuesta.cuerpo) : undefined;
      if (otra && otra !== region) {
        locales(res).reenviadaA = otra;
        respuesta = await aRegion(otra);
      }
      res.status(respuesta.status);
      for (const [nombre, valor] of Object.entries(respuesta.headers)) {
        if (valor !== undefined && !DE_UN_TRAMO.has(nombre)) res.setHeader(nombre, valor);
      }
      res.end(respuesta.cuerpo);
    },
  );

  // Todo lo demás pasa en streaming al nginx de la región.
  const proxyA = (region: Region): RequestHandler =>
    createProxyMiddleware<Request>({
      target: o.regiones[region],
      changeOrigin: true,
      xfwd: true,
      proxyTimeout: tiempoMaximoMs,
      on: { error: regionNoDisponible(region, logger) },
    });
  const proxies: Record<Region, RequestHandler> = {
    'region-1': proxyA('region-1'),
    'region-2': proxyA('region-2'),
  };
  app.use((req, res, next) => {
    void proxies[locales(res).region ?? o.regionPorDefecto](req, res, next);
  });

  app.use(manejadorErrores(logger));

  return {
    app,
    async iniciar() {
      servidorHttp = await new Promise<Server>((resolver) => {
        const s = app.listen(o.puerto, () => resolver(s));
      });
      const puerto = (servidorHttp.address() as AddressInfo).port;
      logger.info({ puerto, regionPorDefecto: o.regionPorDefecto }, 'Enrutador escuchando');
      return puerto;
    },
    async detener() {
      if (apagando) return;
      apagando = true;
      const http = servidorHttp;
      if (!http) return;
      await new Promise<void>((resolver) => {
        http.close(() => resolver());
        http.closeIdleConnections();
      });
      logger.info('Apagado');
    },
  };
}
