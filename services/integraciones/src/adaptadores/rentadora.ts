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

export interface OpcionesAdaptadorRentadora {
  nombre: string;
  url: string;
  claveApi: string;
  intervaloConsultaMs: number;
  tamanoPagina?: number;
  maxPaginas?: number;
  tiempoMaximoMs?: number;
  fetch?: typeof fetch;
}

const ESTADOS_RENTADORA: Record<string, EstadoReservaTraducido> = {
  CONFIRMED: 'confirmada',
  MODIFIED: 'modificada',
  CANCELLED: 'cancelada',
};

/**
 * Adaptador de rentadora de autos (inspirado en OTA / ACRISS, specs/externos/rentadora.md).
 * Trabaja en modo `consulta` con paginación por número de página (`page`/`pageSize`/`totalCount`)
 * y emite solo los campos modificados respecto a la última versión vista.
 */
export function crearAdaptadorRentadora(
  opciones: OpcionesAdaptadorRentadora,
): AdaptadorProveedorViaje {
  const {
    nombre,
    url,
    claveApi,
    intervaloConsultaMs,
    tamanoPagina = 50,
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

    for (let page = 1; page <= maxPaginas; page++) {
      const parametros = new URLSearchParams({
        updatedSince: desde,
        page: String(page),
        pageSize: String(tamanoPagina),
      });

      const respuesta = await llamarProveedorHttp(
        hacerFetch,
        `${baseUrl}/api/v1/bookings?${parametros.toString()}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${claveApi}`,
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
          `${nombre} respondió ${respuesta.status} al consultar reservas actualizadas.`,
        );
      }

      const cuerpo: unknown = await respuesta.json();
      if (!esObjeto(cuerpo) || !Array.isArray(cuerpo.bookings)) {
        throw new ErrorProveedorExterno(
          502,
          'error-proveedor',
          `${nombre} devolvió un cuerpo inesperado al consultar reservas.`,
        );
      }

      for (const item of cuerpo.bookings) {
        mensajes.push(item);
        if (esObjeto(item)) {
          marcaMasAlta = fechaMasReciente(marcaMasAlta, item.updatedAt);
        }
      }

      const totalCount =
        typeof cuerpo.totalCount === 'number' ? cuerpo.totalCount : mensajes.length;
      if (cuerpo.bookings.length === 0 || page * tamanoPagina >= totalCount) {
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

    if (!esObjeto(mensaje)) return fallar('La reserva de la rentadora no es un objeto JSON.');

    const confirmationNumber = mensaje.confirmationNumber;
    if (!esCadenaNoVacia(confirmationNumber)) return fallar('Falta confirmationNumber.');

    const statusCrudo = mensaje.status;
    const estado = typeof statusCrudo === 'string' ? ESTADOS_RENTADORA[statusCrudo] : undefined;
    if (!estado) {
      return fallar(`status desconocido: ${String(statusCrudo)}.`);
    }

    const version = mensaje.version;
    if (!esEnteroPositivo(version)) return fallar('Falta version válida.');

    const pickUp = mensaje.pickUp;
    const dropOff = mensaje.dropOff;
    if (
      !esObjeto(pickUp) ||
      !esObjeto(dropOff) ||
      !esFechaIsoValida(pickUp.dateTime) ||
      !esFechaIsoValida(dropOff.dateTime) ||
      !esCadenaNoVacia(pickUp.locationName) ||
      !esCadenaNoVacia(dropOff.locationName)
    ) {
      return fallar('Faltan datos válidos de pickUp o dropOff.');
    }

    const vehicle = mensaje.vehicle;
    if (
      !esObjeto(vehicle) ||
      !esCadenaNoVacia(vehicle.make) ||
      !esCadenaNoVacia(vehicle.model) ||
      !esCadenaNoVacia(vehicle.categoryName)
    ) {
      return fallar('Faltan datos del vehículo (make, model o categoryName).');
    }

    const numeroReserva = confirmationNumber.trim();
    const inicio = pickUp.dateTime;
    const fin = dropOff.dateTime;
    const origen = pickUp.locationName.trim();
    const destino = dropOff.locationName.trim();
    const modelo = `${vehicle.make.trim()} ${vehicle.model.trim()}`;
    const categoria = vehicle.categoryName.trim();
    const acriss = esCadenaNoVacia(vehicle.acrissCode) ? vehicle.acrissCode.trim() : undefined;
    const marcaTemporal = esFechaIsoValida(mensaje.updatedAt) ? mensaje.updatedAt : undefined;

    const detalleActual: Record<string, unknown> = {
      modelo,
      categoria,
      ...(acriss ? { acriss } : {}),
    };

    const estadoActual: EstadoReservaProveedor = {
      estado,
      inicio,
      fin,
      origen,
      destino,
      detalle: detalleActual,
      versionCambio: String(version),
    };

    if (estado === 'cancelada') {
      return {
        ok: true,
        claveVersion: String(version),
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
      // specs/externos/rentadora.md: primera vez que ve la reserva -> manda inicio, fin, origen y destino.
      cambios.inicio = inicio;
      cambios.fin = fin;
      cambios.origen = origen;
      cambios.destino = destino;
    } else {
      if (inicio !== estadoPrevio.inicio) cambios.inicio = inicio;
      if (fin !== estadoPrevio.fin) cambios.fin = fin;
      if (origen !== estadoPrevio.origen) cambios.origen = origen;
      if (destino !== estadoPrevio.destino) cambios.destino = destino;
      const detalleCambios: Record<string, unknown> = {};
      if (modelo !== estadoPrevio.detalle.modelo) detalleCambios.modelo = modelo;
      if (categoria !== estadoPrevio.detalle.categoria) detalleCambios.categoria = categoria;
      if (
        acriss &&
        acriss !== estadoPrevio.detalle.acriss &&
        Object.keys(cambios).length === 0 &&
        Object.keys(detalleCambios).length === 0
      ) {
        detalleCambios.acriss = acriss;
      }
      if (Object.keys(detalleCambios).length > 0) {
        cambios.detalle = detalleCambios;
      }
      if (estado === 'modificada' && Object.keys(cambios).length === 0) {
        cambios.inicio = inicio;
        cambios.fin = fin;
        cambios.origen = origen;
        cambios.destino = destino;
      }
    }

    return {
      ok: true,
      claveVersion: String(version),
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
    tipo: 'rentadora',
    modo: 'consulta',
    intervaloConsultaMs,
    recibirAviso,
    consultarCambios,
    traducir,
    pedirOpcionesReprogramacion,
    aplicarReprogramacion,
  };
}
