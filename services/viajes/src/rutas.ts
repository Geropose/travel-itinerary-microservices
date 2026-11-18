// Rutas HTTP del Servicio de Viajes (specs/openapi/viajes.yaml):
// - CQRS liviano del panel (GET /panel con X-Origen-Dato: cache | replica)
// - Gestión manual de reservas UC-4 (POST /reservas, PATCH/DELETE /reservas/:reservaId)
// - Consulta interna de dueño para Usuarios (GET /interna/viajes/:viajeId/dueno)
import {
  autenticacion,
  contextoActual,
  enTransaccion,
  errores,
  type Logger,
  type Pool,
  type RegistrarRechazo,
  type Servidor,
} from '@trotamundos/comun';
import type { Request } from 'express';
import type { CachePanel } from './cache.ts';
import { ErrorNegocioViajes, type GestorViajes } from './gestor.ts';
import {
  aReservaPublica,
  aViajePublico,
  type CambioReservaDatos,
  type NuevaReservaDatos,
  type PanelPublico,
  type ReservaPublica,
} from './modelo.ts';
import * as repositorio from './repositorio.ts';

export type OrigenDatoPanel = 'cache' | 'replica';

export interface NegocioViajes {
  poolPrincipal: Pool;
  poolLectura: Pool;
  cache: CachePanel;
  gestor: GestorViajes;
  logger: Logger;
  registrar?: RegistrarRechazo;
  obtenerPanel(usuarioId: string): Promise<{ panel: PanelPublico; origenDato: OrigenDatoPanel }>;
  crearReserva(usuarioId: string, datos: NuevaReservaDatos): Promise<ReservaPublica>;
  modificarReserva(
    usuarioId: string,
    reservaId: string,
    cambios: CambioReservaDatos,
  ): Promise<ReservaPublica>;
  eliminarReserva(usuarioId: string, reservaId: string): Promise<void>;
  consultarDuenoViaje(
    usuarioId: string,
    viajeId: string,
  ): Promise<{ viajeId: string; esDueno: boolean }>;
}

export interface OpcionesNegocioViajes {
  poolPrincipal: Pool;
  /** Pool de la read replica (si se omite, lee desde poolPrincipal). */
  poolLectura?: Pool;
  cache: CachePanel;
  gestor: GestorViajes;
  logger: Logger;
  registrar?: RegistrarRechazo;
}

/**
 * Arma la fachada CQRS liviano de Viajes:
 * - Lecturas del panel: Redis -> read replica -> fallback a base principal -> guarda en Redis.
 * - Escrituras manuales: siempre en base principal + outbox ViajeActualizado + invalidación de cache.
 */
export function crearNegocioViajes(opciones: OpcionesNegocioViajes): NegocioViajes {
  const { poolPrincipal, cache, gestor, logger, registrar } = opciones;
  const poolLectura = opciones.poolLectura ?? poolPrincipal;

  async function leerActivosConFallback(usuarioId: string) {
    try {
      return await repositorio.listarViajesConReservas(poolLectura, usuarioId, 'activo');
    } catch (err) {
      if (poolLectura === poolPrincipal) throw err;
      logger.warn(
        { err, usuarioId },
        'read replica no disponible al leer el panel; se usa la base principal',
      );
      return await repositorio.listarViajesConReservas(poolPrincipal, usuarioId, 'activo');
    }
  }

  return {
    poolPrincipal,
    poolLectura,
    cache,
    gestor,
    logger,
    ...(registrar ? { registrar } : {}),

    async obtenerPanel(usuarioId) {
      const enCache = await cache.obtener(usuarioId);
      if (enCache !== null) {
        return { panel: enCache, origenDato: 'cache' };
      }

      const viajes = await leerActivosConFallback(usuarioId);
      const panel: PanelPublico = { viajes: viajes.map(aViajePublico) };
      await cache.guardar(usuarioId, panel);
      return { panel, origenDato: 'replica' };
    },

    async crearReserva(usuarioId, datos) {
      const creada = await enTransaccion(poolPrincipal, (db) =>
        gestor.crearReservaManual(db, usuarioId, datos),
      );
      await cache.invalidar(usuarioId);
      return aReservaPublica(creada);
    },

    async modificarReserva(usuarioId, reservaId, cambios) {
      const modificada = await enTransaccion(poolPrincipal, (db) =>
        gestor.modificarReservaManual(db, usuarioId, reservaId, cambios),
      );
      await cache.invalidar(usuarioId);
      return aReservaPublica(modificada);
    },

    async eliminarReserva(usuarioId, reservaId) {
      await enTransaccion(poolPrincipal, (db) =>
        gestor.eliminarReservaManual(db, usuarioId, reservaId),
      );
      await cache.invalidar(usuarioId);
    },

    async consultarDuenoViaje(usuarioId, viajeId) {
      const viaje = await repositorio.buscarViajePorId(poolPrincipal, viajeId);
      if (!viaje) {
        throw new ErrorNegocioViajes('no-encontrado', 'El viaje no existe.');
      }
      return { viajeId, esDueno: viaje.usuarioId === usuarioId };
    },
  };
}

export function registrarRutas(servidor: Servidor, servicio: string, negocio: NegocioViajes): void {
  const { app } = servidor;

  function registrarProhibido(req: Request, usuarioId: string): void {
    negocio.registrar?.({
      servicio,
      metodo: req.method,
      ruta: req.baseUrl + req.path,
      status: 403,
      motivo: 'sin-permiso',
      usuarioId,
      ...(req.ip ? { ip: req.ip } : {}),
      requestId: contextoActual()?.requestId ?? '',
    });
  }

  function traducirError(req: Request, usuarioId: string, err: unknown): never {
    if (err instanceof ErrorNegocioViajes) {
      switch (err.codigo) {
        case 'solicitud-invalida':
          throw errores.solicitudInvalida(err.message);
        case 'no-encontrado':
          throw errores.noEncontrado(err.message);
        case 'conflicto':
          throw errores.conflicto(err.message);
        case 'prohibido':
          registrarProhibido(req, usuarioId);
          throw errores.prohibido(err.message);
      }
    }
    throw err;
  }

  app.get('/panel', async (req, res) => {
    const { sub } = autenticacion(req);
    const { panel, origenDato } = await negocio.obtenerPanel(sub);
    res.setHeader('X-Origen-Dato', origenDato);
    res.json(panel);
  });

  app.post('/reservas', async (req, res) => {
    const { sub } = autenticacion(req);
    try {
      const reserva = await negocio.crearReserva(sub, req.body as NuevaReservaDatos);
      res
        .status(201)
        .setHeader('Location', `/api/viajes/reservas/${reserva.reservaId}`)
        .json(reserva);
    } catch (err) {
      traducirError(req, sub, err);
    }
  });

  app.patch('/reservas/:reservaId', async (req, res) => {
    const { sub } = autenticacion(req);
    try {
      const reserva = await negocio.modificarReserva(
        sub,
        String(req.params.reservaId),
        req.body as CambioReservaDatos,
      );
      res.json(reserva);
    } catch (err) {
      traducirError(req, sub, err);
    }
  });

  app.delete('/reservas/:reservaId', async (req, res) => {
    const { sub } = autenticacion(req);
    try {
      await negocio.eliminarReserva(sub, String(req.params.reservaId));
      res.status(204).end();
    } catch (err) {
      traducirError(req, sub, err);
    }
  });

  app.get('/interna/viajes/:viajeId/dueno', async (req, res) => {
    const { sub } = autenticacion(req);
    try {
      const resultado = await negocio.consultarDuenoViaje(sub, String(req.params.viajeId));
      res.json(resultado);
    } catch (err) {
      traducirError(req, sub, err);
    }
  });
}
