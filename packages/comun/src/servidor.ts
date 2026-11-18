import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AsyncResource } from 'node:async_hooks';
import express, { type Express, type RequestHandler } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import type { Region } from './config.ts';
import { conContexto } from './contexto.ts';
import { aProblema, errores, manejadorErrores } from './errores.ts';
import type { Logger } from './logger.ts';
import { cargarSpec, type Spec } from './spec.ts';
import type { Validador } from './validador.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Chequeo = () => Promise<unknown>;

export interface OpcionesServidor {
  servicio: string;
  /** specs/openapi/<servicio>.yaml */
  rutaSpec: string;
  region: Region;
  puerto: number;
  logger: Logger;
  /** Validador de Intercepción. Sin él, ninguna ruta protegida se puede atender (todas 401). */
  validador?: Validador;
  /** Validar también las respuestas contra el contrato (por defecto sí). */
  validarRespuestas?: boolean;
  /** Tiempo máximo de cada chequeo de /health (por defecto 1 s). */
  tiempoChequeoMs?: number;
  /** Escuchar SIGTERM y SIGINT para apagar en orden (por defecto sí). */
  manejarSenales?: boolean;
}

export interface Servidor {
  app: Express;
  spec: Spec;
  /** Agrega un chequeo a /health (por ejemplo "base" o "broker"): si lanza, /health responde 503. */
  registrarChequeo(nombre: string, chequeo: Chequeo): void;
  /** Tarea a correr al apagar (cerrar el broker, el pool...), en orden inverso al registro. */
  alApagar(tarea: () => Promise<unknown>): void;
  /** Agrega el manejo de errores, descarga las claves y empieza a escuchar. Devuelve el puerto. */
  iniciar(): Promise<number>;
  /** Apagado ordenado: deja de aceptar solicitudes, espera las que están en curso y cierra todo. */
  detener(): Promise<void>;
}

function sinValidador(): RequestHandler {
  // Sin validador ninguna ruta protegida pasa: mejor un 401 que atender sin verificar.
  return (_req, res) => {
    res
      .status(401)
      .type('application/problem+json')
      .json(aProblema(errores.noAutenticado(), randomUUID()));
  };
}

/**
 * Arma el servidor Express de un servicio: X-Request-Id, log de cada solicitud, GET /health con
 * chequeos registrables, Validador de Intercepción, validación de solicitudes y respuestas contra
 * el contrato (express-openapi-validator), errores problem+json y apagado ordenado.
 */
export function crearServidor(opciones: OpcionesServidor): Servidor {
  const { servicio, region, puerto, logger, validador } = opciones;
  const spec = cargarSpec(opciones.rutaSpec);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  const chequeos = new Map<string, Chequeo>();
  const tareasApagado: (() => Promise<unknown>)[] = [];
  let servidorHttp: Server | undefined;
  let apagando = false;
  const tiempoChequeo = opciones.tiempoChequeoMs ?? 1000;

  // X-Request-Id: se usa el que viene (si es un UUID) o se crea uno; viaja en el contexto.
  app.use((req, res, next) => {
    const recibido = req.headers['x-request-id'];
    const requestId = typeof recibido === 'string' && UUID.test(recibido) ? recibido : randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-Id', requestId);
    conContexto({ requestId }, () => {
      const inicio = performance.now();
      res.on(
        'finish',
        AsyncResource.bind(() => {
          logger.info(
            {
              metodo: req.method,
              ruta: req.path,
              status: res.statusCode,
              duracionMs: Math.round((performance.now() - inicio) * 10) / 10,
            },
            'Solicitud atendida',
          );
        }),
      );
      next();
    });
  });

  app.get('/health', async (_req, res) => {
    const fallas: string[] = [];
    if (apagando) fallas.push('apagando');
    await Promise.all(
      [...chequeos].map(async ([nombre, chequeo]) => {
        let temporizador: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            chequeo(),
            new Promise((_r, rechazar) => {
              temporizador = setTimeout(() => rechazar(new Error('tiempo agotado')), tiempoChequeo);
            }),
          ]);
        } catch (error) {
          logger.warn({ err: error, chequeo: nombre }, 'Chequeo de salud fallido');
          fallas.push(nombre);
        } finally {
          clearTimeout(temporizador);
        }
      }),
    );
    if (fallas.length === 0) {
      res.json({ estado: 'ok' });
      return;
    }
    const error = errores.noDisponible(`Falla: ${fallas.sort().join(', ')}.`);
    res
      .status(503)
      .type('application/problem+json')
      .json(aProblema(error, String(res.getHeader('X-Request-Id'))));
  });

  app.use(validador ? validador.middleware(spec) : sinValidador());
  app.use(express.json({ limit: '1mb' }));
  app.use(
    OpenApiValidator.middleware({
      // Copia: el validador modifica el documento que recibe.
      apiSpec: structuredClone(spec.documento) as unknown as Parameters<
        typeof OpenApiValidator.middleware
      >[0]['apiSpec'],
      validateRequests: true,
      validateResponses: opciones.validarRespuestas ?? true,
      validateSecurity: false,
      validateApiSpec: false,
      fileUploader: false,
      ignoreUndocumented: false,
    }),
  );

  async function detener(): Promise<void> {
    if (apagando) return;
    apagando = true;
    logger.info('Apagando');
    validador?.detener();
    if (servidorHttp) {
      const http = servidorHttp;
      await new Promise<void>((resolver) => {
        http.close(() => resolver());
        http.closeIdleConnections();
      });
    }
    for (const tarea of [...tareasApagado].reverse()) {
      await tarea().catch((error: unknown) =>
        logger.warn({ err: error }, 'Falló una tarea de apagado'),
      );
    }
    logger.info('Apagado');
  }

  return {
    app,
    spec,
    registrarChequeo: (nombre, chequeo) => {
      chequeos.set(nombre, chequeo);
    },
    alApagar: (tarea) => {
      tareasApagado.push(tarea);
    },
    async iniciar() {
      app.use(manejadorErrores(logger));
      await validador?.iniciar();
      servidorHttp = await new Promise<Server>((resolver) => {
        const s = app.listen(puerto, () => resolver(s));
      });
      const real = (servidorHttp.address() as AddressInfo).port;
      logger.info({ puerto: real, servicio, region }, 'Servicio escuchando');
      if (opciones.manejarSenales ?? true) {
        for (const senal of ['SIGTERM', 'SIGINT'] as const) {
          process.once(senal, () => {
            void detener().finally(() => process.exit(0));
          });
        }
      }
      return real;
    },
    detener,
  };
}
