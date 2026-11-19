// Mock de Hotel Cordillera (specs/externos/hotel.md, puerto 4004): proveedor que NO avisa; solo
// expone consulta paginada por modifiedSince y consulta individual con X-Api-Key.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@trotamundos/comun';
import {
  compararSeguro,
  crearControlComportamiento,
  crearMiddlewareComportamiento,
  esFechaIsoValida,
  montarRutasComportamiento,
  type ControlComportamiento,
} from '@trotamundos/mocks-comun';
import express, { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { responderError } from './errores.ts';
import { crearAlmacenHotel, decodificarCursor, type AlmacenHotel } from './reservas.ts';

export interface OpcionesMockHotel {
  puerto: number;
  logger: Logger;
  apiKey: string;
  semillas?: boolean;
  reloj?: () => number;
}

export interface MockHotel {
  app: express.Express;
  almacen: AlmacenHotel;
  comportamiento: ControlComportamiento;
  iniciar(): Promise<number>;
  detener(): Promise<void>;
}

const esquemaCambioAdmin = z.object({
  checkIn: z.string().min(1).optional(),
  checkOut: z.string().min(1).optional(),
  roomDescription: z.string().min(1).optional(),
  roomType: z.string().min(1).optional(),
  guests: z.number().int().min(1).max(10).optional(),
  hotelName: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
});

const esquemaReservaAdmin = z.object({
  reservationId: z.string().min(3),
  status: z.enum(['confirmed', 'modified', 'cancelled']).default('confirmed'),
  hotelName: z.string().min(1).default('Hotel Cordillera'),
  city: z.string().min(1).default('Santiago'),
  address: z.string().min(1).default('Av. Providencia 1234'),
  countryCode: z.string().length(2).default('CL'),
  guestFirstName: z.string().min(1).default('Ana'),
  guestLastName: z.string().min(1).default('García'),
  checkIn: z.string().min(1),
  checkOut: z.string().min(1),
  roomDescription: z.string().min(1).default('Doble superior'),
});

const esquemaTormenta = z.object({
  cantidad: z.number().int().min(1).max(10_000).default(10),
});

export function crearMockHotel(opciones: OpcionesMockHotel): MockHotel {
  const { logger, apiKey, reloj = Date.now } = opciones;
  const comportamiento = crearControlComportamiento();
  const almacen = crearAlmacenHotel(reloj);
  if (opciones.semillas !== false) almacen.cargarSemillas();

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

  // --- API de negocio (specs/externos/hotel.md) --------------------------------------------------

  const exigirAuth: RequestHandler = (req, res, next) => {
    const clave = req.header('x-api-key');
    if (!clave || !compararSeguro(clave, apiKey)) {
      responderError(res, 401, 'UNAUTHORIZED', 'Missing or invalid X-Api-Key header');
      return;
    }
    next();
  };

  const api = Router();
  api.use(
    crearMiddlewareComportamiento(comportamiento, (res) =>
      responderError(res, 503, 'SERVICE_UNAVAILABLE', 'Simulated hotel service outage'),
    ),
  );
  api.use(exigirAuth);

  api.get('/reservations', (req, res) => {
    const modifiedSince =
      typeof req.query.modifiedSince === 'string' ? req.query.modifiedSince.trim() : '';
    if (!modifiedSince || !esFechaIsoValida(modifiedSince)) {
      responderError(
        res,
        400,
        'INVALID_PARAMETER',
        'Query parameter modifiedSince is required and must be a valid ISO 8601 date-time',
      );
      return;
    }

    let limit = 100;
    if (req.query.limit !== undefined) {
      const parsed = Number(req.query.limit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
        responderError(res, 400, 'INVALID_PARAMETER', 'Query parameter limit must be 1..500');
        return;
      }
      limit = parsed;
    }

    let cursor: ReturnType<typeof decodificarCursor>;
    if (typeof req.query.cursor === 'string' && req.query.cursor.length > 0) {
      cursor = decodificarCursor(req.query.cursor);
      if (!cursor) {
        responderError(res, 400, 'INVALID_PARAMETER', 'Invalid cursor');
        return;
      }
    }

    res.json(
      almacen.consultarModificadas({
        modifiedSince,
        limit,
        ...(cursor ? { cursor } : {}),
      }),
    );
  });

  api.get('/reservations/:reservationId', (req, res) => {
    const id = req.params.reservationId ?? '';
    const reserva = almacen.buscar(id);
    if (!reserva) {
      responderError(res, 404, 'NOT_FOUND', `Reservation ${id} not found`);
      return;
    }
    res.json(reserva);
  });

  app.use('/v1', api);

  // --- Rutas /admin (solo pruebas y demo) --------------------------------------------------------

  const admin = Router();
  montarRutasComportamiento(admin, comportamiento);

  admin.get('/reservas', (_req, res) => {
    res.json({ reservations: almacen.listarTodas() });
  });

  admin.post('/reservas', (req, res) => {
    const parsed = esquemaReservaAdmin.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    const d = parsed.data;
    const ahora = new Date(reloj()).toISOString();
    const creada = almacen.guardar({
      reservationId: d.reservationId,
      status: d.status,
      revision: 1,
      createdAt: ahora,
      lastModified: ahora,
      hotel: {
        code: 'HC-SCL-01',
        name: d.hotelName,
        address: d.address,
        city: d.city,
        countryCode: d.countryCode,
      },
      guest: { firstName: d.guestFirstName, lastName: d.guestLastName },
      checkIn: d.checkIn,
      checkOut: d.checkOut,
      room: { type: 'DBL', description: d.roomDescription, guests: 2 },
    });
    res.status(201).json(creada);
  });

  admin.post('/reservas/:id/cambiar', (req, res) => {
    const parsed = esquemaCambioAdmin.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    const c = parsed.data;
    const actualizada = almacen.cambiar(req.params.id ?? '', {
      ...(c.checkIn !== undefined ? { checkIn: c.checkIn } : {}),
      ...(c.checkOut !== undefined ? { checkOut: c.checkOut } : {}),
      ...(c.roomDescription !== undefined ? { roomDescription: c.roomDescription } : {}),
      ...(c.roomType !== undefined ? { roomType: c.roomType } : {}),
      ...(c.guests !== undefined ? { guests: c.guests } : {}),
      ...(c.hotelName !== undefined ? { hotelName: c.hotelName } : {}),
      ...(c.city !== undefined ? { city: c.city } : {}),
    });
    if (!actualizada) return void res.status(404).json({ error: 'Reserva no encontrada' });
    res.json(actualizada);
  });

  admin.post('/reservas/:id/cancelar', (req, res) => {
    const actualizada = almacen.cancelar(req.params.id ?? '');
    if (!actualizada) return void res.status(404).json({ error: 'Reserva no encontrada' });
    res.json(actualizada);
  });

  admin.post('/tormenta', (req, res) => {
    const parsed = esquemaTormenta.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    const afectadas = almacen.tormenta(parsed.data.cantidad);
    res.status(202).json({
      canceladas: afectadas.length,
      muestraIds: afectadas.slice(0, 20).map((r) => r.reservationId),
    });
  });

  admin.post('/reiniciar', (_req, res) => {
    comportamiento.reiniciar();
    almacen.limpiar();
    if (opciones.semillas !== false) almacen.cargarSemillas();
    res.json({ ok: true, reservas: almacen.listarTodas().length });
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
          logger.info({ puerto }, 'mock hotel iniciado');
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
