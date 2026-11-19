// Rutas HTTP del Servicio de Viajes (specs/openapi/viajes.yaml):
// - CQRS liviano del panel y archivados (GET /panel con X-Origen-Dato: cache | replica, GET /archivados)
// - Detalle de viaje e itinerario compartido (GET /viajes/:viajeId con duenoODesignado, ADR-005)
// - Publicación en redes sociales sin datos sensibles (POST /viajes/:viajeId/compartir-red, Iteración 3)
// - Gestión manual de reservas UC-4 (POST /reservas, PATCH/DELETE /reservas/:reservaId)
// - Rutas internas para Usuarios, Correo, Asistente y ejecución de archivado en pruebas
import {
  autenticacion,
  contextoActual,
  crearClienteHttp,
  enTransaccion,
  errores,
  ErrorRespuestaHttp,
  type ClienteHttp,
  type Logger,
  type Pool,
  type RegistrarRechazo,
  type ReglaRuta,
  type Servidor,
  type Validador,
} from '@trotamundos/comun';
import type { Request, RequestHandler } from 'express';
import { ErrorArchivadoEnEjecucion, type TareaArchivado } from './archivado.ts';
import type { CachePanel } from './cache.ts';
import { ErrorNegocioViajes, type GestorViajes } from './gestor.ts';
import {
  aReservaPublica,
  armarItinerarioParaRed,
  aViajePublico,
  type CambioReservaDatos,
  type EstadoReserva,
  type ListaReservasPublica,
  type ListaViajesPublica,
  type NuevaReservaDatos,
  type PanelPublico,
  type PublicacionRed,
  type ReservaPublica,
  type ResultadoArchivado,
  type UsuariosConViajeProximoRespuesta,
  type ViajeConReservas,
} from './modelo.ts';
import * as repositorio from './repositorio.ts';

export type OrigenDatoPanel = 'cache' | 'replica';

/** Reglas de token de servicio del contrato specs/openapi/viajes.yaml (ADR-005). */
export const REGLAS_VALIDADOR_VIAJES: Record<string, ReglaRuta> = {
  'GET /interna/usuarios-con-viaje-proximo': { servicios: ['correo', 'pruebas'] },
  'POST /interna/archivado/ejecutar': { servicios: ['pruebas'] },
};

export interface NegocioViajes {
  poolPrincipal: Pool;
  poolLectura: Pool;
  cache: CachePanel;
  gestor: GestorViajes;
  logger: Logger;
  registrar?: RegistrarRechazo;
  clienteUsuarios?: ClienteHttp;
  urlUsuarios?: string;
  obtenerPanel(usuarioId: string): Promise<{ panel: PanelPublico; origenDato: OrigenDatoPanel }>;
  listarArchivados(usuarioId: string): Promise<ListaViajesPublica>;
  obtenerViajeConReservas(viajeId: string): Promise<ViajeConReservas | null>;
  compartirEnRed(
    usuarioId: string,
    viajeId: string,
    red: string,
    token: string,
  ): Promise<PublicacionRed>;
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
  listarReservasInterna(usuarioId: string, estado?: EstadoReserva): Promise<ListaReservasPublica>;
  obtenerReservaPorNumeroInterna(
    usuarioId: string,
    proveedor: string,
    numeroReserva: string,
  ): Promise<ReservaPublica | null>;
  listarUsuariosConViajeProximo(dias: number): Promise<UsuariosConViajeProximoRespuesta>;
  ejecutarArchivadoManual(): Promise<ResultadoArchivado>;
}

export interface OpcionesNegocioViajes {
  poolPrincipal: Pool;
  /** Pool de la read replica (si se omite, lee desde poolPrincipal). */
  poolLectura?: Pool;
  cache: CachePanel;
  gestor: GestorViajes;
  logger: Logger;
  registrar?: RegistrarRechazo;
  tareaArchivado?: TareaArchivado;
  clienteUsuarios?: ClienteHttp;
  urlUsuarios?: string;
  clienteIntegraciones?: ClienteHttp;
  urlIntegraciones?: string;
  ahora?: () => number;
}

function extraerDetalleProblema(cuerpo: unknown): string | undefined {
  if (typeof cuerpo === 'object' && cuerpo !== null && 'detail' in cuerpo) {
    const detalle = (cuerpo as { detail?: unknown }).detail;
    if (typeof detalle === 'string' && detalle.trim().length > 0) return detalle;
  }
  return undefined;
}

/**
 * Arma la fachada CQRS liviano de Viajes:
 * - Lecturas (panel, archivados, viaje compartido, consultas internas): Redis / read replica con
 *   fallback automático a base principal.
 * - Escrituras (manuales UC-4, eventos, archivado): siempre en base principal + outbox
 *   ViajeActualizado + invalidación de cache.
 */
export function crearNegocioViajes(opciones: OpcionesNegocioViajes): NegocioViajes {
  const { poolPrincipal, cache, gestor, logger, registrar, tareaArchivado } = opciones;
  const poolLectura = opciones.poolLectura ?? poolPrincipal;
  const ahora = opciones.ahora ?? Date.now;
  const clienteIntegraciones =
    opciones.clienteIntegraciones ??
    crearClienteHttp({
      urlBase: opciones.urlIntegraciones ?? 'http://integraciones:3005',
      tiempoMaximoMs: 2500,
    });

  async function leerConFallback<T>(
    operacion: (db: Pool) => Promise<T>,
    contextoLog: string,
  ): Promise<T> {
    try {
      return await operacion(poolLectura);
    } catch (err) {
      if (poolLectura === poolPrincipal) throw err;
      logger.warn(
        { err },
        `read replica no disponible al leer ${contextoLog}; se usa la base principal`,
      );
      return await operacion(poolPrincipal);
    }
  }

  return {
    poolPrincipal,
    poolLectura,
    cache,
    gestor,
    logger,
    ...(registrar ? { registrar } : {}),
    ...(opciones.clienteUsuarios ? { clienteUsuarios: opciones.clienteUsuarios } : {}),
    ...(opciones.urlUsuarios ? { urlUsuarios: opciones.urlUsuarios } : {}),

    async obtenerPanel(usuarioId) {
      const enCache = await cache.obtener(usuarioId);
      if (enCache !== null) {
        return { panel: enCache, origenDato: 'cache' };
      }

      const viajes = await leerConFallback(
        (db) => repositorio.listarViajesConReservas(db, usuarioId, 'activo'),
        'el panel',
      );
      const panel: PanelPublico = { viajes: viajes.map(aViajePublico) };
      await cache.guardar(usuarioId, panel);
      return { panel, origenDato: 'replica' };
    },

    async listarArchivados(usuarioId) {
      const viajes = await leerConFallback(
        (db) => repositorio.listarViajesConReservas(db, usuarioId, 'archivado'),
        'los viajes archivados',
      );
      return { viajes: viajes.map(aViajePublico) };
    },

    async obtenerViajeConReservas(viajeId) {
      const enLectura = await leerConFallback(
        (db) => repositorio.buscarViajeConReservasPorId(db, viajeId),
        'el detalle del viaje',
      );
      if (enLectura || poolLectura === poolPrincipal) return enLectura;
      // Si un viaje recién creado todavía no llegó a la read replica, comprobamos la principal.
      return await repositorio.buscarViajeConReservasPorId(poolPrincipal, viajeId);
    },

    async compartirEnRed(usuarioId, viajeId, red, token) {
      const viaje = await repositorio.buscarViajeConReservasPorId(poolPrincipal, viajeId);
      if (!viaje) {
        throw new ErrorNegocioViajes('no-encontrado', 'El viaje no existe.');
      }
      if (viaje.usuarioId !== usuarioId) {
        throw new ErrorNegocioViajes(
          'prohibido',
          'Solo el dueño puede publicar este viaje en una red social.',
        );
      }

      const itinerario = armarItinerarioParaRed(viaje);
      if (itinerario.reservas.length === 0) {
        throw new ErrorNegocioViajes(
          'solicitud-invalida',
          'El viaje no tiene reservas para compartir.',
        );
      }

      try {
        const { datos } = await clienteIntegraciones.post<PublicacionRed>(
          '/interna/redes/publicar',
          { red, itinerario },
          { token },
        );
        return datos;
      } catch (err) {
        if (err instanceof ErrorRespuestaHttp) {
          const detalle = extraerDetalleProblema(err.cuerpo);
          if (err.status === 404) {
            throw new ErrorNegocioViajes(
              'no-encontrado',
              detalle ?? `No hay un adaptador configurado para la red ${red}.`,
            );
          }
          if (err.status === 400) {
            throw new ErrorNegocioViajes(
              'solicitud-invalida',
              detalle ?? 'Los datos para publicar en la red social no son válidos.',
            );
          }
          if (err.status === 403) {
            throw new ErrorNegocioViajes(
              'prohibido',
              detalle ?? 'No tiene permiso para publicar en la red social.',
            );
          }
        }
        logger.warn(
          { err, viajeId, red },
          'falló la publicación del itinerario en el Servicio de Integraciones',
        );
        throw new ErrorNegocioViajes(
          'no-disponible',
          'No se pudo publicar el itinerario en la red social en este momento.',
        );
      }
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

    async listarReservasInterna(usuarioId, estado) {
      const reservas = await leerConFallback(
        (db) => repositorio.listarReservasActivasDeUsuario(db, usuarioId, estado),
        'las reservas del usuario',
      );
      return { reservas: reservas.map(aReservaPublica) };
    },

    async obtenerReservaPorNumeroInterna(usuarioId, proveedor, numeroReserva) {
      const reserva = await leerConFallback(
        (db) => repositorio.buscarReservaPorClave(db, proveedor, numeroReserva),
        'la reserva por número',
      );
      if (!reserva || reserva.usuarioId !== usuarioId) {
        return null;
      }
      return aReservaPublica(reserva);
    },

    async listarUsuariosConViajeProximo(dias) {
      const ahoraDate = new Date(ahora());
      const hastaDate = new Date(ahoraDate.getTime() + dias * 24 * 60 * 60 * 1000);
      const usuarioIds = await leerConFallback(
        (db) => repositorio.listarUsuariosConViajeProximo(db, ahoraDate, hastaDate),
        'los usuarios con viaje próximo',
      );
      return {
        dias,
        calculadoEn: ahoraDate.toISOString(),
        usuarioIds,
      };
    },

    async ejecutarArchivadoManual() {
      if (!tareaArchivado) {
        throw new ErrorNegocioViajes(
          'no-disponible',
          'La tarea de archivado no está inicializada en esta instancia.',
        );
      }
      try {
        const resultado = await tareaArchivado.ejecutar({ lanzarSiOcupado: true });
        if (!resultado) {
          throw new ErrorNegocioViajes('conflicto', 'La tarea de archivado ya está corriendo.');
        }
        return resultado;
      } catch (err) {
        if (err instanceof ErrorArchivadoEnEjecucion) {
          throw new ErrorNegocioViajes('conflicto', err.message);
        }
        throw err;
      }
    },
  };
}

export function registrarRutas(
  servidor: Servidor,
  servicio: string,
  negocio: NegocioViajes,
  validador?: Validador,
): void {
  const { app } = servidor;
  const viajePorRequest = new WeakMap<Request, ViajeConReservas>();

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
        case 'no-disponible':
          throw errores.noDisponible(err.message);
        case 'prohibido':
          registrarProhibido(req, usuarioId);
          throw errores.prohibido(err.message);
      }
    }
    throw err;
  }

  // Defensa en profundidad para itinerario compartido (ADR-005, Diagrama de secuencia B):
  // verifica dueño localmente o consulta a Usuarios si está designado; la cache nunca lo saltea.
  const controlarAccesoViaje: RequestHandler = validador
    ? validador.duenoODesignado({
        obtenerDueno: async (req) => {
          const viaje = await negocio.obtenerViajeConReservas(String(req.params.viajeId));
          if (!viaje) return undefined;
          viajePorRequest.set(req, viaje);
          return viaje.usuarioId;
        },
        viajeId: (req) => String(req.params.viajeId),
        ...(negocio.clienteUsuarios
          ? { usuarios: negocio.clienteUsuarios }
          : negocio.urlUsuarios
            ? { urlUsuarios: negocio.urlUsuarios }
            : {}),
      })
    : async (req, _res, next) => {
        const { sub } = autenticacion(req);
        const viaje = await negocio.obtenerViajeConReservas(String(req.params.viajeId));
        if (!viaje) throw errores.noEncontrado('El viaje no existe.');
        if (viaje.usuarioId !== sub) {
          registrarProhibido(req, sub);
          throw errores.prohibido('No es el dueño ni una persona designada.');
        }
        viajePorRequest.set(req, viaje);
        next();
      };

  app.get('/panel', async (req, res) => {
    const { sub } = autenticacion(req);
    const { panel, origenDato } = await negocio.obtenerPanel(sub);
    res.setHeader('X-Origen-Dato', origenDato);
    res.json(panel);
  });

  app.get('/archivados', async (req, res) => {
    const { sub } = autenticacion(req);
    const archivados = await negocio.listarArchivados(sub);
    res.json(archivados);
  });

  app.get('/viajes/:viajeId', controlarAccesoViaje, async (req, res) => {
    const viajeId = String(req.params.viajeId);
    const viaje = viajePorRequest.get(req) ?? (await negocio.obtenerViajeConReservas(viajeId));
    if (!viaje) throw errores.noEncontrado('El viaje no existe.');
    res.json(aViajePublico(viaje));
  });

  app.post('/viajes/:viajeId/compartir-red', async (req, res) => {
    const { sub, token } = autenticacion(req);
    const { red } = req.body as { red: string };
    try {
      const publicacion = await negocio.compartirEnRed(sub, String(req.params.viajeId), red, token);
      res.status(201).json(publicacion);
    } catch (err) {
      traducirError(req, sub, err);
    }
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

  app.get('/interna/reservas', async (req, res) => {
    const { sub } = autenticacion(req);
    const usuarioId = String(req.query.usuarioId);
    if (usuarioId !== sub) {
      registrarProhibido(req, sub);
      throw errores.prohibido('Solo se pueden consultar las reservas del usuario autenticado.');
    }
    const estado =
      typeof req.query.estado === 'string' ? (req.query.estado as EstadoReserva) : undefined;
    const lista = await negocio.listarReservasInterna(sub, estado);
    res.json(lista);
  });

  app.get('/interna/reservas/:numeroReserva', async (req, res) => {
    const { sub } = autenticacion(req);
    const numeroReserva = String(req.params.numeroReserva);
    const proveedor = String(req.query.proveedor);
    const reserva = await negocio.obtenerReservaPorNumeroInterna(sub, proveedor, numeroReserva);
    if (!reserva) {
      throw errores.noEncontrado('La reserva no existe.');
    }
    res.json(reserva);
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

  app.get('/interna/usuarios-con-viaje-proximo', async (req, res) => {
    const dias = req.query.dias !== undefined ? Number(req.query.dias) : 7;
    const resultado = await negocio.listarUsuariosConViajeProximo(dias);
    res.json(resultado);
  });

  app.post('/interna/archivado/ejecutar', async (req, res) => {
    const { sub } = autenticacion(req);
    try {
      const resultado = await negocio.ejecutarArchivadoManual();
      res.json(resultado);
    } catch (err) {
      traducirError(req, sub, err);
    }
  });
}
