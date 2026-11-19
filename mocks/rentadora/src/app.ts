// Mock de Rentadora Sur (specs/externos/rentadora.md, puerto 4005): proveedor que NO avisa;
// expone consulta por updatedSince con paginación por número de página y Bearer auth.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@trotamundos/comun';
import {
  compararSeguro,
  crearControlComportamiento,
  crearMiddlewareComportamiento,
  esFechaIsoValida,
  leerBearer,
  montarRutasComportamiento,
  type ControlComportamiento,
} from '@trotamundos/mocks-comun';
import express, { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { responderError } from './errores.ts';
import { crearAlmacenRentadora, type AlmacenRentadora } from './reservas.ts';

export interface OpcionesMockRentadora {
  puerto: number;
  logger: Logger;
  apiKey: string;
  semillas?: boolean;
  reloj?: () => number;
}

export interface MockRentadora {
  app: express.Express;
  almacen: AlmacenRentadora;
  comportamiento: ControlComportamiento;
  iniciar(): Promise<number>;
  detener(): Promise<void>;
}

const esquemaCambioAdmin = z.object({
  pickUpDateTime: z.string().min(1).optional(),
  dropOffDateTime: z.string().min(1).optional(),
  pickUpLocationName: z.string().min(1).optional(),
  dropOffLocationName: z.string().min(1).optional(),
  vehicleMake: z.string().min(1).optional(),
  vehicleModel: z.string().min(1).optional(),
  vehicleCategoryName: z.string().min(1).optional(),
  vehicleAcrissCode: z.string().length(4).optional(),
});

const esquemaReservaAdmin = z.object({
  confirmationNumber: z.string().min(3),
  status: z.enum(['CONFIRMED', 'MODIFIED', 'CANCELLED']).default('CONFIRMED'),
  driverFirstName: z.string().min(1).default('Ana'),
  driverLastName: z.string().min(1).default('García'),
  vehicleMake: z.string().min(1).default('Toyota'),
  vehicleModel: z.string().min(1).default('Yaris'),
  vehicleCategoryName: z.string().min(1).default('Económico'),
  vehicleAcrissCode: z.string().length(4).default('ECMR'),
  pickUpLocationName: z.string().min(1).default('Rentadora Sur Aeropuerto SCL'),
  dropOffLocationName: z.string().min(1).default('Rentadora Sur Aeropuerto SCL'),
  city: z.string().min(1).default('Santiago'),
  pickUpDateTime: z.string().min(1),
  dropOffDateTime: z.string().min(1),
});

const esquemaTormenta = z.object({
  cantidad: z.number().int().min(1).max(10_000).default(10),
});

export function crearMockRentadora(opciones: OpcionesMockRentadora): MockRentadora {
  const { logger, apiKey, reloj = Date.now } = opciones;
  const comportamiento = crearControlComportamiento();
  const almacen = crearAlmacenRentadora(reloj);
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

  // --- API de negocio (specs/externos/rentadora.md) ----------------------------------------------

  const exigirAuth: RequestHandler = (req, res, next) => {
    const token = leerBearer(req.header('authorization'));
    if (!token || !compararSeguro(token, apiKey)) {
      responderError(res, 401, 'UNAUTHORIZED', 'Missing or invalid Bearer token');
      return;
    }
    next();
  };

  const api = Router();
  api.use(
    crearMiddlewareComportamiento(comportamiento, (res) =>
      responderError(res, 503, 'SERVICE_UNAVAILABLE', 'Simulated car rental service outage'),
    ),
  );
  api.use(exigirAuth);

  api.get('/bookings', (req, res) => {
    const updatedSince =
      typeof req.query.updatedSince === 'string' ? req.query.updatedSince.trim() : '';
    if (!updatedSince || !esFechaIsoValida(updatedSince)) {
      responderError(
        res,
        400,
        'INVALID_REQUEST',
        'Query parameter updatedSince is required and must be a valid ISO 8601 date-time',
      );
      return;
    }

    let page = 1;
    if (req.query.page !== undefined) {
      const parsed = Number(req.query.page);
      if (!Number.isInteger(parsed) || parsed < 1) {
        responderError(res, 400, 'INVALID_REQUEST', 'Query parameter page must be >= 1');
        return;
      }
      page = parsed;
    }

    let pageSize = 50;
    if (req.query.pageSize !== undefined) {
      const parsed = Number(req.query.pageSize);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
        responderError(res, 400, 'INVALID_REQUEST', 'Query parameter pageSize must be 1..200');
        return;
      }
      pageSize = parsed;
    }

    res.json(almacen.consultarActualizadas({ updatedSince, page, pageSize }));
  });

  api.get('/bookings/:confirmationNumber', (req, res) => {
    const num = req.params.confirmationNumber ?? '';
    const reserva = almacen.buscar(num);
    if (!reserva) {
      responderError(res, 404, 'BOOKING_NOT_FOUND', `Booking ${num} does not exist`);
      return;
    }
    res.json(reserva);
  });

  app.use('/api/v1', api);

  // --- Rutas /admin (solo pruebas y demo) --------------------------------------------------------

  const admin = Router();
  montarRutasComportamiento(admin, comportamiento);

  admin.get('/reservas', (_req, res) => {
    res.json({ bookings: almacen.listarTodas() });
  });

  admin.post('/reservas', (req, res) => {
    const parsed = esquemaReservaAdmin.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    const d = parsed.data;
    const ahora = new Date(reloj()).toISOString();
    const creada = almacen.guardar({
      confirmationNumber: d.confirmationNumber,
      status: d.status,
      version: 1,
      createdAt: ahora,
      updatedAt: ahora,
      driver: { firstName: d.driverFirstName, lastName: d.driverLastName },
      vehicle: {
        acrissCode: d.vehicleAcrissCode,
        categoryName: d.vehicleCategoryName,
        make: d.vehicleMake,
        model: d.vehicleModel,
      },
      pickUp: {
        locationCode: 'SCLA01',
        locationName: d.pickUpLocationName,
        city: d.city,
        dateTime: d.pickUpDateTime,
      },
      dropOff: {
        locationCode: 'SCLA01',
        locationName: d.dropOffLocationName,
        city: d.city,
        dateTime: d.dropOffDateTime,
      },
    });
    res.status(201).json(creada);
  });

  admin.post('/reservas/:id/cambiar', (req, res) => {
    const parsed = esquemaCambioAdmin.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    const c = parsed.data;
    const actualizada = almacen.cambiar(req.params.id ?? '', {
      ...(c.pickUpDateTime !== undefined ? { pickUpDateTime: c.pickUpDateTime } : {}),
      ...(c.dropOffDateTime !== undefined ? { dropOffDateTime: c.dropOffDateTime } : {}),
      ...(c.pickUpLocationName !== undefined ? { pickUpLocationName: c.pickUpLocationName } : {}),
      ...(c.dropOffLocationName !== undefined
        ? { dropOffLocationName: c.dropOffLocationName }
        : {}),
      ...(c.vehicleMake !== undefined ? { vehicleMake: c.vehicleMake } : {}),
      ...(c.vehicleModel !== undefined ? { vehicleModel: c.vehicleModel } : {}),
      ...(c.vehicleCategoryName !== undefined
        ? { vehicleCategoryName: c.vehicleCategoryName }
        : {}),
      ...(c.vehicleAcrissCode !== undefined ? { vehicleAcrissCode: c.vehicleAcrissCode } : {}),
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
      muestraNumeros: afectadas.slice(0, 20).map((b) => b.confirmationNumber),
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
          logger.info({ puerto }, 'mock rentadora iniciado');
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
