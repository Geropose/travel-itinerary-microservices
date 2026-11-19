// Mock de Red Social (specs/externos/redsocial.md, puerto 4007): publicación de estados estilo
// Mastodon (POST /api/v1/statuses → 200 OK) con Idempotency-Key y rutas /admin.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@trotamundos/comun';
import {
  compararSeguro,
  crearControlComportamiento,
  crearMiddlewareComportamiento,
  leerBearer,
  montarRutasComportamiento,
  type ControlComportamiento,
} from '@trotamundos/mocks-comun';
import express, { Router, type RequestHandler } from 'express';
import { responderInvalido, responderNoAutorizado, responderNoDisponible } from './errores.ts';
import {
  crearAlmacenPublicaciones,
  type AlmacenPublicaciones,
  type Visibilidad,
} from './publicaciones.ts';

export interface OpcionesMockRedSocial {
  puerto: number;
  logger: Logger;
  apiToken: string;
  urlPublica?: string;
  cuenta?: string;
  reloj?: () => number;
}

export interface MockRedSocial {
  app: express.Express;
  almacen: AlmacenPublicaciones;
  comportamiento: ControlComportamiento;
  iniciar(): Promise<number>;
  detener(): Promise<void>;
}

const VISIBILIDADES = new Set<Visibilidad>(['public', 'unlisted', 'private', 'direct']);
const MAX_CARACTERES = 500;

export function crearMockRedSocial(opciones: OpcionesMockRedSocial): MockRedSocial {
  const { logger, apiToken, reloj = Date.now } = opciones;
  const comportamiento = crearControlComportamiento();
  const almacen = crearAlmacenPublicaciones({
    urlPublica: opciones.urlPublica ?? 'https://redsocial.example',
    cuenta: opciones.cuenta ?? 'trotamundos',
    reloj,
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    const inicio = performance.now();
    res.on('finish', () => {
      logger.info(
        {
          metodo: req.method,
          ruta: req.path,
          estado: res.statusCode,
          duracionMs: Math.round(performance.now() - inicio),
        },
        'solicitud',
      );
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ estado: 'ok' });
  });

  // --- API de negocio (specs/externos/redsocial.md) ----------------------------------------------

  const exigirAuth: RequestHandler = (req, res, next) => {
    const token = leerBearer(req.header('authorization'));
    if (!token || !compararSeguro(token, apiToken)) {
      responderNoAutorizado(res);
      return;
    }
    next();
  };

  const api = Router();
  api.use(crearMiddlewareComportamiento(comportamiento, responderNoDisponible));
  api.use(exigirAuth);

  api.post('/statuses', (req, res) => {
    const cuerpo = (req.body ?? {}) as Record<string, unknown>;
    const status = typeof cuerpo.status === 'string' ? cuerpo.status : '';
    if (status.trim().length === 0) {
      responderInvalido(res, "Text can't be blank");
      return;
    }
    if ([...status].length > MAX_CARACTERES) {
      responderInvalido(res, `Text character limit of ${MAX_CARACTERES} exceeded`);
      return;
    }

    let visibility: Visibilidad = 'public';
    if (cuerpo.visibility !== undefined) {
      if (
        typeof cuerpo.visibility !== 'string' ||
        !VISIBILIDADES.has(cuerpo.visibility as Visibilidad)
      ) {
        responderInvalido(res, 'Visibility is not included in the list');
        return;
      }
      visibility = cuerpo.visibility as Visibilidad;
    }

    let language = 'es';
    if (cuerpo.language !== undefined) {
      if (typeof cuerpo.language !== 'string' || !/^[a-z]{2}$/i.test(cuerpo.language)) {
        responderInvalido(res, 'Language must be a 2-letter ISO 639-1 code');
        return;
      }
      language = cuerpo.language.toLowerCase();
    }

    const idempotencyKey = req.header('idempotency-key')?.trim() || undefined;
    const publicada = almacen.publicar({
      status,
      visibility,
      language,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    // Mastodon responde 200 OK (no 201).
    res.status(200).json(publicada);
  });

  app.use('/api/v1', api);

  // --- Rutas /admin (solo pruebas y demo) --------------------------------------------------------

  const admin = Router();
  montarRutasComportamiento(admin, comportamiento);

  admin.get('/publicaciones', (_req, res) => {
    res.json({ publicaciones: almacen.listar() });
  });

  admin.post('/reiniciar', (_req, res) => {
    comportamiento.reiniciar();
    almacen.limpiar();
    res.json({ ok: true });
  });

  app.use('/admin', admin);

  let servidor: Server | undefined;

  return {
    app,
    almacen,
    comportamiento,
    iniciar() {
      return new Promise<number>((resolve, reject) => {
        servidor = app.listen(opciones.puerto, () => {
          const puerto = (servidor?.address() as AddressInfo).port;
          logger.info({ puerto }, 'mock redsocial iniciado');
          resolve(puerto);
        });
        servidor.on('error', reject);
      });
    },
    detener() {
      comportamiento.detener();
      return new Promise<void>((resolve) => {
        if (!servidor) return resolve();
        servidor.close(() => {
          servidor = undefined;
          resolve();
        });
        servidor.closeAllConnections();
      });
    },
  };
}
