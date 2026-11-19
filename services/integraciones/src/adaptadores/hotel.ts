import {
  ErrorModoNoSoportado,
  ErrorProveedorExterno,
  esCadenaNoVacia,
  esEnteroPositivo,
  esFechaIsoValida,
  esObjeto,
  fechaMasReciente,
  llamarProveedorHttp,
  serializarSinDatosPersonales,
  type AdaptadorProveedorViaje,
  type CambiosReserva,
  type EncabezadosAviso,
  type EstadoReservaProveedor,
  type EstadoReservaTraducido,
  type OpcionReprogramacion,
  type ResultadoAplicarReprogramacion,
  type ResultadoAvisoCrudo,
  type ResultadoConsultaCruda,
  type ResultadoTraduccion,
} from './tipos.ts';

export interface OpcionesAdaptadorHotel {
  nombre: string;
  url: string;
  claveApi: string;
  intervaloConsultaMs: number;
  limitePagina?: number;
  maxPaginas?: number;
  tiempoMaximoMs?: number;
  fetch?: typeof fetch;
}

const ESTADOS_HOTEL: Record<string, EstadoReservaTraducido> = {
  confirmed: 'confirmada',
  modified: 'modificada',
  cancelled: 'cancelada',
};

/**
 * Adaptador de hotel (inspirado en OpenTravel / OTA, specs/externos/hotel.md).
 * Trabaja en modo `consulta`: pide periódicamente las reservas modificadas con paginación por
 * cursor y compara contra el último estado visto para emitir solo los campos modificados.
 */
export function crearAdaptadorHotel(opciones: OpcionesAdaptadorHotel): AdaptadorProveedorViaje {
  const {
    nombre,
    url,
    claveApi,
    intervaloConsultaMs,
    limitePagina = 100,
    maxPaginas = 500,
    tiempoMaximoMs = 5000,
    fetch: hacerFetch = fetch,
  } = opciones;

  const baseUrl = url.replace(/\/+$/, '');

  function recibirAviso(_cuerpo: Buffer | string, _headers: EncabezadosAviso): ResultadoAvisoCrudo {
    throw new ErrorModoNoSoportado(`El proveedor ${nombre} trabaja por consulta, no por webhook.`);
  }

  async function consultarCambios(desde: string): Promise<ResultadoConsultaCruda> {
    const mensajes: unknown[] = [];
    let marcaMasAlta: string | undefined;
    let cursor: string | null = null;

    for (let pagina = 0; pagina < maxPaginas; pagina++) {
      const parametros = new URLSearchParams({
        modifiedSince: desde,
        limit: String(limitePagina),
      });
      if (cursor) parametros.set('cursor', cursor);

      const respuesta = await llamarProveedorHttp(
        hacerFetch,
        `${baseUrl}/v1/reservations?${parametros.toString()}`,
        {
          method: 'GET',
          headers: {
            'X-Api-Key': claveApi,
            Accept: 'application/json',
          },
        },
        tiempoMaximoMs,
        nombre,
      );

      if (respuesta.status === 503) {
        throw new ErrorProveedorExterno(503, 'proveedor-no-disponible', `${nombre} no disponible.`);
      }
      if (!respuesta.ok) {
        throw new ErrorProveedorExterno(
          502,
          'error-proveedor',
          `${nombre} respondió ${respuesta.status} al consultar reservas modificadas.`,
        );
      }

      const cuerpo: unknown = await respuesta.json();
      if (!esObjeto(cuerpo) || !Array.isArray(cuerpo.reservations)) {
        throw new ErrorProveedorExterno(
          502,
          'error-proveedor',
          `${nombre} devolvió un cuerpo inesperado al consultar reservas.`,
        );
      }

      for (const item of cuerpo.reservations) {
        mensajes.push(item);
        if (esObjeto(item)) {
          marcaMasAlta = fechaMasReciente(marcaMasAlta, item.lastModified);
        }
      }

      if (typeof cuerpo.nextCursor === 'string' && cuerpo.nextCursor.length > 0) {
        cursor = cuerpo.nextCursor;
      } else {
        break;
      }
    }

    return {
      mensajes,
      ...(marcaMasAlta ? { marcaMasAlta } : {}),
    };
  }

  function traducir(mensaje: unknown, estadoPrevio?: EstadoReservaProveedor): ResultadoTraduccion {
    const fallar = (motivo: string): ResultadoTraduccion => ({
      ok: false,
      motivo,
      cuerpoSinDatosPersonales: serializarSinDatosPersonales(mensaje),
    });

    if (!esObjeto(mensaje)) return fallar('La reserva del hotel no es un objeto JSON.');

    const reservationId = mensaje.reservationId;
    if (!esCadenaNoVacia(reservationId)) return fallar('Falta reservationId.');

    const statusCrudo = mensaje.status;
    const estado = typeof statusCrudo === 'string' ? ESTADOS_HOTEL[statusCrudo] : undefined;
    if (!estado) {
      return fallar(`status desconocido: ${String(statusCrudo)}.`);
    }

    const revision = mensaje.revision;
    if (!esEnteroPositivo(revision)) return fallar('Falta revision válida.');

    const checkIn = mensaje.checkIn;
    const checkOut = mensaje.checkOut;
    if (!esFechaIsoValida(checkIn) || !esFechaIsoValida(checkOut)) {
      return fallar('Fechas checkIn/checkOut inválidas o faltantes.');
    }

    const hotel = mensaje.hotel;
    if (!esObjeto(hotel) || !esCadenaNoVacia(hotel.city) || !esCadenaNoVacia(hotel.name)) {
      return fallar('Faltan datos del hotel (name o city).');
    }

    const room = mensaje.room;
    if (!esObjeto(room) || !esCadenaNoVacia(room.description)) {
      return fallar('Faltan datos de la habitación (room.description).');
    }

    const numeroReserva = reservationId.trim();
    const ciudad = hotel.city.trim();
    const nombreHotel = hotel.name.trim();
    const habitacion = room.description.trim();
    const marcaTemporal = esFechaIsoValida(mensaje.lastModified) ? mensaje.lastModified : undefined;

    const detalleActual: Record<string, unknown> = {
      hotel: nombreHotel,
      habitacion,
      ...(typeof room.guests === 'number' ? { huespedes: room.guests } : {}),
    };

    const estadoActual: EstadoReservaProveedor = {
      estado,
      inicio: checkIn,
      fin: checkOut,
      destino: ciudad,
      detalle: detalleActual,
      versionCambio: String(revision),
    };

    if (estado === 'cancelada') {
      return {
        ok: true,
        claveVersion: String(revision),
        evento: {
          proveedor: nombre,
          numeroReserva,
          estado: 'cancelada',
          cambios: {},
          origenCambio: 'proveedor',
        },
        estadoActual,
        ...(marcaTemporal ? { marcaTemporal } : {}),
      };
    }

    const cambios: CambiosReserva = {};
    if (!estadoPrevio) {
      // specs/externos/hotel.md: primera vez que ve la reserva -> manda inicio, fin y destino actuales.
      cambios.inicio = checkIn;
      cambios.fin = checkOut;
      cambios.destino = ciudad;
    } else {
      if (checkIn !== estadoPrevio.inicio) cambios.inicio = checkIn;
      if (checkOut !== estadoPrevio.fin) cambios.fin = checkOut;
      if (ciudad !== estadoPrevio.destino) cambios.destino = ciudad;
      const detalleCambios: Record<string, unknown> = {};
      if (nombreHotel !== estadoPrevio.detalle.hotel) detalleCambios.hotel = nombreHotel;
      if (habitacion !== estadoPrevio.detalle.habitacion) detalleCambios.habitacion = habitacion;
      if (
        typeof room.guests === 'number' &&
        room.guests !== estadoPrevio.detalle.huespedes &&
        Object.keys(cambios).length === 0 &&
        Object.keys(detalleCambios).length === 0
      ) {
        detalleCambios.huespedes = room.guests;
      }
      if (Object.keys(detalleCambios).length > 0) {
        cambios.detalle = detalleCambios;
      }
      // Garantiza cumplimiento del esquema (estado=modificada requiere al menos un campo en cambios).
      if (estado === 'modificada' && Object.keys(cambios).length === 0) {
        cambios.inicio = checkIn;
        cambios.fin = checkOut;
        cambios.destino = ciudad;
      }
    }

    return {
      ok: true,
      claveVersion: String(revision),
      evento: {
        proveedor: nombre,
        numeroReserva,
        estado,
        cambios,
        origenCambio: 'proveedor',
      },
      estadoActual,
      ...(marcaTemporal ? { marcaTemporal } : {}),
    };
  }

  async function pedirOpcionesReprogramacion(
    _numeroReserva: string,
  ): Promise<OpcionReprogramacion[]> {
    return [];
  }

  async function aplicarReprogramacion(
    _numeroReserva: string,
    _opcionId: string,
  ): Promise<ResultadoAplicarReprogramacion> {
    throw new ErrorModoNoSoportado(`El proveedor ${nombre} no soporta reprogramación por API.`);
  }

  return {
    nombre,
    tipo: 'hotel',
    modo: 'consulta',
    intervaloConsultaMs,
    recibirAviso,
    consultarCambios,
    traducir,
    pedirOpcionesReprogramacion,
    aplicarReprogramacion,
  };
}
