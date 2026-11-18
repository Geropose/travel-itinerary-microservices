// Enrutamiento de /api/<servicio>/* (specs/openapi/gateway.yaml, Iteración 1, ADR-005): rutas
// internas → 404, Validador de Intercepción con el contrato del servicio, límite de cuerpo y
// proxy al servicio interno de la región con tiempo máximo.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP, type Socket } from 'node:net';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aProblema,
  cargarSpec,
  contextoActual,
  errores,
  sinValidador,
  type AjustesContrato,
  type Logger,
  type RegistrarRechazo,
  type Spec,
  type Validador,
} from '@trotamundos/comun';
import express, { type Express, type Request, type RequestHandler } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

export interface ServicioInterno {
  /** URL del servicio dentro de la red de la región. */
  url: string;
  /** Reglas y roles para interceptar sus rutas, si no alcanzan los de por defecto. */
  ajustes?: AjustesContrato;
  /** Tiempo máximo propio, si necesita más que el general. */
  tiempoMaximoMs?: number;
}

/** Tabla de enrutamiento de specs/openapi/gateway.yaml: prefijo → servicio interno. */
export const SERVICIOS_INTERNOS: Record<string, ServicioInterno> = {
  autenticacion: {
    url: 'http://autenticacion:3001',
    // El analista también cierra su sesión (la misma regla que tiene Autenticación).
    ajustes: { reglas: { 'POST /logout': { roles: ['usuario', 'analista'] } } },
  },
  usuarios: { url: 'http://usuarios:3002' },
  correo: { url: 'http://correo:3003' },
  viajes: { url: 'http://viajes:3004' },
  integraciones: { url: 'http://integraciones:3005' },
  // Las rutas de analítica son solo del analista, y el analista solo entra a estas (CONVENCIONES 4.6).
  analitica: { url: 'http://analitica:3006', ajustes: { rolesPorDefecto: ['analista'] } },
  // El asistente responde hasta 3 s antes de pasar a 202 (asistente.yaml): necesita más de 2 s.
  asistente: { url: 'http://asistente:3007', tiempoMaximoMs: 5000 },
};

/** Contrato de un servicio: specs/openapi/<servicio>.yaml. */
export const rutaSpecDe = (servicio: string) =>
  fileURLToPath(new URL(`../../../specs/openapi/${servicio}.yaml`, import.meta.url));

export interface OpcionesEnrutamiento {
  servicio: string;
  logger: Logger;
  validador: Validador | undefined;
  registrar: RegistrarRechazo;
  servicios: Record<string, ServicioInterno>;
  tiempoMaximoMs: number;
  limiteCuerpo: string;
  origenWeb: string;
}

/**
 * ¿Es una ruta /interna/...? Se mira la ruta decodificada, normalizada y en minúsculas, para que
 * /%69nterna/..., /x/../interna/... o /INTERNA/... tampoco lleguen al servicio.
 */
export function esRutaInterna(ruta: string): boolean {
  let decodificada = ruta;
  try {
    decodificada = decodeURIComponent(ruta);
  } catch {
    // Codificación inválida: se mira tal cual.
  }
  const normalizada = posix.normalize(decodificada).toLowerCase();
  return normalizada === '/interna' || normalizada.startsWith('/interna/');
}

function ipDe(req: Request): string | undefined {
  const ip = (req.ip ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return isIP(ip) ? ip : undefined;
}

/** CORS solo para el origen de la web: a cualquier otro origen el navegador no lo deja leer. */
function cors(origenWeb: string): RequestHandler {
  return (req, res, next) => {
    const origen = req.headers.origin;
    const permitido = origen === origenWeb;
    res.vary('Origin');
    if (permitido) {
      res.setHeader('Access-Control-Allow-Origin', origenWeb);
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Location, Retry-After');
    }
    // Consulta previa (preflight) del navegador: se responde acá, sin pasar por el validador.
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      if (!permitido) throw errores.prohibido('Origen no permitido.');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-Request-Id, X-Region',
      );
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Responde 503 problem+json si el servicio interno no responde (o no responde a tiempo). */
function respuestaNoDisponible(nombre: string, logger: Logger) {
  return (error: Error, req: IncomingMessage, res: ServerResponse | Socket) => {
    logger.warn({ err: error, servicioInterno: nombre }, 'El servicio interno no respondió');
    if (!('writeHead' in res) || res.headersSent) {
      // Ya se había empezado a mandar la respuesta: lo único posible es cortarla.
      res.destroy();
      return;
    }
    const requestId = String(req.headers['x-request-id'] ?? '');
    const problema = aProblema(
      errores.noDisponible(`El servicio ${nombre} no respondió. Probá de nuevo.`),
      requestId,
    );
    res.writeHead(503, { 'content-type': 'application/problem+json; charset=utf-8' });
    res.end(JSON.stringify(problema));
  };
}

/**
 * Proxy al servicio interno. El cuerpo ya está leído (para limitar su tamaño), así que se reenvía
 * a mano; X-Request-Id y Authorization viajan tal como quedaron en la solicitud.
 */
function proxyA(nombre: string, servicio: ServicioInterno, o: OpcionesEnrutamiento) {
  return createProxyMiddleware<Request>({
    target: servicio.url,
    changeOrigin: true,
    xfwd: true,
    proxyTimeout: Math.max(servicio.tiempoMaximoMs ?? 0, o.tiempoMaximoMs),
    on: {
      proxyReq: (proxyReq, req) => {
        const cuerpo: unknown = req.body;
        if (!Buffer.isBuffer(cuerpo) || cuerpo.length === 0) return;
        proxyReq.removeHeader('transfer-encoding');
        proxyReq.setHeader('content-length', cuerpo.length);
        proxyReq.write(cuerpo);
      },
      error: respuestaNoDisponible(nombre, o.logger),
    },
  });
}

/**
 * Monta /api/<servicio>/* en la app del gateway. Por cada solicitud, en orden: CORS, ruta interna
 * (404 y registro), operación que no está en el contrato (404), Validador de Intercepción con el contrato del servicio (las rutas públicas
 * pasan sin token), límite del cuerpo y proxy.
 */
export function montarEnrutamiento(app: Express, o: OpcionesEnrutamiento): void {
  app.use('/api', cors(o.origenWeb));

  for (const [nombre, servicio] of Object.entries(o.servicios)) {
    const spec: Spec = cargarSpec(rutaSpecDe(nombre));
    const interceptar = o.validador
      ? o.validador.middleware(spec, servicio.ajustes)
      : sinValidador(spec);

    const noExponerInternas: RequestHandler = (req, _res, next) => {
      if (!esRutaInterna(req.path)) {
        next();
        return;
      }
      const ip = ipDe(req);
      // Sin esperar (QA-9): el registro nunca demora ni cambia la respuesta.
      o.registrar({
        servicio: o.servicio,
        metodo: req.method,
        ruta: req.baseUrl + req.path,
        status: 404,
        motivo: 'ruta-interna',
        ...(ip ? { ip } : {}),
        requestId: contextoActual()?.requestId ?? '',
      });
      o.logger.info(
        { metodo: req.method, ruta: req.baseUrl + req.path },
        'Ruta interna pedida desde afuera',
      );
      throw errores.noEncontrado('La ruta no existe.');
    };

    // Solo se exponen las operaciones del contrato del servicio; el resto, 404 acá mismo.
    const soloDelContrato: RequestHandler = (req, _res, next) => {
      if (!spec.buscar(req.method, req.path)) throw errores.noEncontrado('La ruta no existe.');
      next();
    };

    app.use(
      `/api/${nombre}`,
      noExponerInternas,
      soloDelContrato,
      interceptar,
      // Se lee el cuerpo crudo solo para limitar su tamaño (413); el servicio lo valida con su contrato.
      express.raw({ type: () => true, limit: o.limiteCuerpo, inflate: false }),
      proxyA(nombre, servicio, o),
    );
  }

  // Un prefijo que no está en la tabla.
  app.use('/api', () => {
    throw errores.noEncontrado('La ruta no existe.');
  });
}
