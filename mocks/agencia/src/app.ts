// Mock de Viajes del Plata (specs/externos/agencia.md, puerto 4006): crea tickets/casos estilo
// Zendesk con POST /api/v2/tickets y expone /admin/casos + /admin/comportamiento.
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
import {
  aTicketPublico,
  crearAlmacenCasos,
  type AlmacenCasos,
  type PrioridadCaso,
  type SolicitanteCaso,
} from './casos.ts';
import { responderInvalido, responderNoAutorizado, responderNoDisponible } from './errores.ts';

export interface OpcionesMockAgencia {
  puerto: number;
  logger: Logger;
  apiKey: string;
  reloj?: () => number;
}

export interface MockAgencia {
  app: express.Express;
  almacen: AlmacenCasos;
  comportamiento: ControlComportamiento;
  iniciar(): Promise<number>;
  detener(): Promise<void>;
}

const PRIORIDADES = new Set<PrioridadCaso>(['urgent', 'high', 'normal', 'low']);

export function crearMockAgencia(opciones: OpcionesMockAgencia): MockAgencia {
  const { logger, apiKey, reloj = Date.now } = opciones;
  const comportamiento = crearControlComportamiento();
  const almacen = crearAlmacenCasos(reloj);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

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

  // --- API de negocio (specs/externos/agencia.md) ------------------------------------------------

  const exigirAuth: RequestHandler = (req, res, next) => {
    const token = leerBearer(req.header('authorization'));
    if (!token || !compararSeguro(token, apiKey)) {
      responderNoAutorizado(res);
      return;
    }
    next();
  };

  const api = Router();
  api.use(crearMiddlewareComportamiento(comportamiento, responderNoDisponible));
  api.use(exigirAuth);

  api.post('/tickets', (req, res) => {
    const cuerpo = req.body as { ticket?: Record<string, unknown> } | undefined;
    const ticket = cuerpo?.ticket;
    const detalles: Record<string, { description: string }[]> = {};

    if (!ticket || typeof ticket !== 'object') {
      responderInvalido(res, { ticket: [{ description: 'Ticket: es obligatorio' }] });
      return;
    }

    const subject = typeof ticket.subject === 'string' ? ticket.subject.trim() : '';
    if (!subject) {
      detalles.subject = [{ description: 'Subject: no puede estar vacío' }];
    }

    const commentObj = ticket.comment as { body?: unknown } | undefined;
    const commentBody = typeof commentObj?.body === 'string' ? commentObj.body.trim() : '';
    if (!commentBody) {
      detalles['comment.body'] = [{ description: 'Comment body: no puede estar vacío' }];
    }

    let priority: PrioridadCaso = 'normal';
    if (ticket.priority !== undefined) {
      if (
        typeof ticket.priority !== 'string' ||
        !PRIORIDADES.has(ticket.priority as PrioridadCaso)
      ) {
        detalles.priority = [{ description: 'Priority: debe ser urgent, high, normal o low' }];
      } else {
        priority = ticket.priority as PrioridadCaso;
      }
    }

    if (Object.keys(detalles).length > 0) {
      responderInvalido(res, detalles);
      return;
    }

    const externalId =
      typeof ticket.external_id === 'string' && ticket.external_id.trim().length > 0
        ? ticket.external_id.trim()
        : undefined;

    const tags = Array.isArray(ticket.tags)
      ? ticket.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : [];

    let requester: SolicitanteCaso | undefined;
    if (ticket.requester && typeof ticket.requester === 'object') {
      const reqObj = ticket.requester as { name?: unknown; email?: unknown };
      const name =
        typeof reqObj.name === 'string' && reqObj.name.trim() ? reqObj.name.trim() : undefined;
      const email =
        typeof reqObj.email === 'string' && reqObj.email.trim() ? reqObj.email.trim() : undefined;
      if (name || email) {
        requester = { ...(name ? { name } : {}), ...(email ? { email } : {}) };
      }
    }

    const creado = almacen.crear({
      subject,
      commentBody,
      priority,
      ...(externalId ? { external_id: externalId } : {}),
      tags,
      ...(requester ? { requester } : {}),
    });

    res.status(201).json({ ticket: aTicketPublico(creado) });
  });

  app.use('/api/v2', api);

  // --- Rutas /admin (solo pruebas y demo) --------------------------------------------------------

  const admin = Router();
  montarRutasComportamiento(admin, comportamiento);

  admin.get('/casos', (_req, res) => {
    res.json({ casos: almacen.listar() });
  });

  admin.get('/casos/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return void res.status(400).json({ error: 'ID inválido' });
    const caso = almacen.buscar(id);
    if (!caso) return void res.status(404).json({ error: 'Caso no encontrado' });
    res.json({ caso });
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
          logger.info({ puerto }, 'mock agencia iniciado');
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
