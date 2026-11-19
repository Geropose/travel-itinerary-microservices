// Mock de Aerolínea Andina (specs/externos/aerolinea.md, puerto 4003): órdenes de vuelo con PNR,
// webhooks firmados con HMAC-SHA256, reprogramaciones (ofertas + confirmar) y rutas /admin.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@trotamundos/comun';
import {
  compararSeguro,
  crearControlComportamiento,
  crearEnviador,
  crearMiddlewareComportamiento,
  leerBearer,
  montarRutasComportamiento,
  type ControlComportamiento,
} from '@trotamundos/mocks-comun';
import express, { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { responderError } from './errores.ts';
import {
  crearAlmacenOrdenes,
  firmarWebhook,
  type AlmacenOrdenes,
  type EventoWebhookAerolinea,
} from './ordenes.ts';

export interface OpcionesMockAerolinea {
  puerto: number;
  logger: Logger;
  apiKey: string;
  webhookSecret: string;
  webhookUrls?: string[];
  semillas?: boolean;
  reloj?: () => number;
  avisos?: { reintentos?: number; esperaMs?: number; tiempoMaximoMs?: number };
}

export interface MockAerolinea {
  app: express.Express;
  almacen: AlmacenOrdenes;
  comportamiento: ControlComportamiento;
  iniciar(): Promise<number>;
  detener(): Promise<void>;
}

const esquemaPedidoCambio = z.object({
  data: z.object({ order_id: z.string().min(1) }),
});

const esquemaAplicarCambio = z.object({
  data: z.object({ selected_order_change_offer: z.string().min(1) }),
});

const esquemaCambioAdmin = z.object({
  departing_at: z.string().min(1).optional(),
  arriving_at: z.string().min(1).optional(),
  desplazarMinutos: z.number().int().optional(),
  flight_number: z.string().min(1).optional(),
  origin_iata: z.string().length(3).optional(),
  origin_city: z.string().min(1).optional(),
  destination_iata: z.string().length(3).optional(),
  destination_city: z.string().min(1).optional(),
  seat: z.string().min(1).optional(),
});

const esquemaOpcionesAdmin = z.object({
  cantidad: z.number().int().min(0).max(3).optional(),
  ttlSeg: z.number().int().min(-3600).max(86_400).optional(),
});

const esquemaTormenta = z.object({
  cantidad: z.number().int().min(1).max(50_000).default(10),
  prefijo: z.string().min(2).max(6).default('STM'),
  enviarWebhooks: z.boolean().default(true),
});

const esquemaWebhooks = z.object({
  urls: z.array(z.url()),
  secreto: z.string().min(8).optional(),
});

const esquemaOrdenAdmin = z.object({
  booking_reference: z.string().min(3),
  status: z.enum(['confirmed', 'changed', 'cancelled']).default('confirmed'),
  passenger: z
    .object({ given_name: z.string().min(1), family_name: z.string().min(1) })
    .default({ given_name: 'Ana', family_name: 'García' }),
  flight_number: z.string().min(1).default('1234'),
  origin_iata: z.string().length(3).default('EZE'),
  origin_city: z.string().min(1).default('Buenos Aires'),
  destination_iata: z.string().length(3).default('SCL'),
  destination_city: z.string().min(1).default('Santiago'),
  departing_at: z.string().min(1),
  arriving_at: z.string().min(1),
  seat: z.string().min(1).optional(),
});

export function crearMockAerolinea(opciones: OpcionesMockAerolinea): MockAerolinea {
  const { logger, apiKey, reloj = Date.now } = opciones;
  let webhookUrls = [...(opciones.webhookUrls ?? [])];
  let webhookSecret = opciones.webhookSecret;

  const enviador = crearEnviador({
    logger,
    reintentos: opciones.avisos?.reintentos ?? 5,
    esperaMs: opciones.avisos?.esperaMs ?? 500,
    tiempoMaximoMs: opciones.avisos?.tiempoMaximoMs ?? 5000,
  });
  const comportamiento = crearControlComportamiento();
  const almacen = crearAlmacenOrdenes(reloj);
  if (opciones.semillas !== false) almacen.cargarSemillas();

  function despacharWebhook(evento: EventoWebhookAerolinea): number {
    for (const url of webhookUrls) {
      enviador.enviar(url, evento, (cuerpoTexto) => ({
        'X-Webhook-Signature': firmarWebhook(cuerpoTexto, webhookSecret, reloj()),
      }));
    }
    return webhookUrls.length;
  }

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

  // --- API de negocio (specs/externos/aerolinea.md) ----------------------------------------------

  const exigirAuth: RequestHandler = (req, res, next) => {
    const token = leerBearer(req.header('authorization'));
    if (!token || !compararSeguro(token, apiKey)) {
      responderError(res, 401, 'unauthorized', 'Missing or invalid API key');
      return;
    }
    next();
  };

  const api = Router();
  api.use(
    crearMiddlewareComportamiento(comportamiento, (res) =>
      responderError(res, 503, 'service_unavailable', 'Simulated airline service outage'),
    ),
  );
  api.use(exigirAuth);

  api.get('/orders', (req, res) => {
    const ref = typeof req.query.booking_reference === 'string' ? req.query.booking_reference : '';
    const limiteBruto = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
    const limit =
      Number.isInteger(limiteBruto) && limiteBruto >= 1 && limiteBruto <= 500 ? limiteBruto : 50;
    const data = almacen.listar({ ...(ref ? { bookingReference: ref } : {}), limit });
    res.json({ data, meta: { limit, after: null, before: null } });
  });

  api.get('/orders/:id', (req, res) => {
    const orden = almacen.buscarPorId(req.params.id ?? '');
    if (!orden) {
      responderError(res, 404, 'not_found', `Order ${req.params.id} not found`);
      return;
    }
    res.json({ data: orden });
  });

  api.post('/order_change_requests', (req, res) => {
    const parsed = esquemaPedidoCambio.safeParse(req.body);
    if (!parsed.success) {
      responderError(res, 400, 'validation_error', 'data.order_id is required');
      return;
    }
    const pedido = almacen.crearPedidoCambio(parsed.data.data.order_id);
    if (!pedido) {
      responderError(res, 404, 'not_found', `Order ${parsed.data.data.order_id} not found`);
      return;
    }
    res.status(201).json({ data: pedido });
  });

  api.post('/order_changes', (req, res) => {
    const parsed = esquemaAplicarCambio.safeParse(req.body);
    if (!parsed.success) {
      responderError(res, 400, 'validation_error', 'data.selected_order_change_offer is required');
      return;
    }
    const resultado = almacen.aplicarOferta(parsed.data.data.selected_order_change_offer);
    if (!resultado.ok) {
      const status = resultado.motivo === 'not_found' ? 404 : 422;
      responderError(res, status, resultado.motivo, resultado.mensaje);
      return;
    }
    despacharWebhook(resultado.evento);
    res.status(201).json({ data: resultado.confirmacion });
  });

  app.use('/air', api);

  // --- Rutas /admin (solo pruebas y demo) --------------------------------------------------------

  const admin = Router();
  montarRutasComportamiento(admin, comportamiento);

  admin.get('/ordenes', (_req, res) => {
    res.json({ ordenes: almacen.listar({ limit: 500 }) });
  });

  admin.post('/ordenes', (req, res) => {
    const parsed = esquemaOrdenAdmin.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    const d = parsed.data;
    const orden = almacen.guardar({
      booking_reference: d.booking_reference,
      status: d.status,
      cancelled_at: d.status === 'cancelled' ? new Date(reloj()).toISOString() : null,
      owner: { iata_code: 'AN', name: 'Aerolínea Andina' },
      passengers: [{ id: 'pas_0001', ...d.passenger }],
      segments: [
        {
          id: `seg_${d.booking_reference}`,
          marketing_carrier: { iata_code: 'AN' },
          marketing_carrier_flight_number: d.flight_number,
          origin: { iata_code: d.origin_iata, city_name: d.origin_city },
          destination: { iata_code: d.destination_iata, city_name: d.destination_city },
          departing_at: d.departing_at,
          arriving_at: d.arriving_at,
          ...(d.seat ? { seat: d.seat } : {}),
        },
      ],
    });
    res.status(201).json({ data: orden });
  });

  admin.post('/ordenes/:ref/cambiar', (req, res) => {
    const parsed = esquemaCambioAdmin.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    const c = parsed.data;
    const resultado = almacen.cambiarOrden(req.params.ref ?? '', {
      ...(c.departing_at !== undefined ? { departing_at: c.departing_at } : {}),
      ...(c.arriving_at !== undefined ? { arriving_at: c.arriving_at } : {}),
      ...(c.desplazarMinutos !== undefined ? { desplazarMinutos: c.desplazarMinutos } : {}),
      ...(c.flight_number !== undefined ? { flight_number: c.flight_number } : {}),
      ...(c.origin_iata !== undefined ? { origin_iata: c.origin_iata } : {}),
      ...(c.origin_city !== undefined ? { origin_city: c.origin_city } : {}),
      ...(c.destination_iata !== undefined ? { destination_iata: c.destination_iata } : {}),
      ...(c.destination_city !== undefined ? { destination_city: c.destination_city } : {}),
      ...(c.seat !== undefined ? { seat: c.seat } : {}),
    });
    if (!resultado) return void res.status(404).json({ error: 'Orden no encontrada' });
    const avisos = despacharWebhook(resultado.evento);
    res.json({ orden: resultado.orden, evento: resultado.evento, webhooksDisparados: avisos });
  });

  admin.post('/ordenes/:ref/cancelar', (req, res) => {
    const resultado = almacen.cancelarOrden(req.params.ref ?? '');
    if (!resultado) return void res.status(404).json({ error: 'Orden no encontrada' });
    const avisos = despacharWebhook(resultado.evento);
    res.json({ orden: resultado.orden, evento: resultado.evento, webhooksDisparados: avisos });
  });

  admin.post('/ordenes/:ref/opciones', (req, res) => {
    const parsed = esquemaOpcionesAdmin.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    const orden = almacen.configurarOpciones(req.params.ref ?? '', {
      ...(parsed.data.cantidad !== undefined ? { cantidad: parsed.data.cantidad } : {}),
      ...(parsed.data.ttlSeg !== undefined ? { ttlSeg: parsed.data.ttlSeg } : {}),
    });
    if (!orden) return void res.status(404).json({ error: 'Orden no encontrada' });
    res.json({ orden, opciones: parsed.data });
  });

  admin.post('/tormenta', (req, res) => {
    const parsed = esquemaTormenta.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    const { ordenes, eventos } = almacen.tormenta(parsed.data.cantidad, parsed.data.prefijo);
    let webhooksDisparados = 0;
    if (parsed.data.enviarWebhooks) {
      for (const ev of eventos) webhooksDisparados += despacharWebhook(ev);
    }
    res.status(202).json({
      canceladas: ordenes.length,
      webhooksDisparados,
      muestraReferencias: ordenes.slice(0, 20).map((o) => o.booking_reference),
    });
  });

  admin.get('/webhooks', (_req, res) => {
    res.json({ urls: webhookUrls });
  });

  admin.put('/webhooks', (req, res) => {
    const parsed = esquemaWebhooks.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    webhookUrls = [...parsed.data.urls];
    if (parsed.data.secreto) webhookSecret = parsed.data.secreto;
    res.json({ urls: webhookUrls });
  });

  admin.post('/reiniciar', (_req, res) => {
    comportamiento.reiniciar();
    almacen.limpiar();
    if (opciones.semillas !== false) almacen.cargarSemillas();
    res.json({ ok: true, ordenes: almacen.listar({ limit: 500 }).length });
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
          logger.info({ puerto }, 'mock aerolinea iniciado');
          resolve(puerto);
        });
        servidor.on('error', reject);
      });
    },
    detener() {
      enviador.detener();
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
