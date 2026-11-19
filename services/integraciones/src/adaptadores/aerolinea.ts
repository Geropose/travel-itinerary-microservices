import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ErrorCuerpoNoJson,
  ErrorFirmaInvalida,
  ErrorProveedorExterno,
  esCadenaNoVacia,
  esEnteroPositivo,
  esFechaIsoValida,
  esObjeto,
  leerEncabezado,
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

export interface OpcionesAdaptadorAerolinea {
  nombre: string;
  url: string;
  claveApi: string;
  secretoWebhook: string;
  tiempoMaximoMs?: number;
  toleranciaFirmaSeg?: number;
  ahora?: () => number;
  fetch?: typeof fetch;
}

const PATRON_FIRMA = /^t=(\d+),v1=([0-9a-f]{64})$/;
const TOLERANCIA_FIRMA_DEFECTO_SEG = 5 * 60;
const ESTADOS_AEROLINEA: Record<string, EstadoReservaTraducido> = {
  confirmed: 'confirmada',
  changed: 'modificada',
  cancelled: 'cancelada',
};

interface SegmentoValidado {
  carrierIata: string;
  flightNumber: string;
  originIata: string;
  destinationIata: string;
  departingAt: string;
  arrivingAt: string;
  seat?: string;
}

function parsearSegmento(valor: unknown): SegmentoValidado | undefined {
  if (!esObjeto(valor)) return undefined;
  const carrier = valor.marketing_carrier;
  const origin = valor.origin;
  const destination = valor.destination;
  if (!esObjeto(carrier) || !esObjeto(origin) || !esObjeto(destination)) return undefined;
  const carrierIata = carrier.iata_code;
  const flightNumber = valor.marketing_carrier_flight_number;
  const originIata = origin.iata_code;
  const destinationIata = destination.iata_code;
  const departingAt = valor.departing_at;
  const arrivingAt = valor.arriving_at;
  if (
    !esCadenaNoVacia(carrierIata) ||
    !esCadenaNoVacia(flightNumber) ||
    !esCadenaNoVacia(originIata) ||
    !esCadenaNoVacia(destinationIata) ||
    !esFechaIsoValida(departingAt) ||
    !esFechaIsoValida(arrivingAt)
  ) {
    return undefined;
  }
  const seat = esCadenaNoVacia(valor.seat) ? valor.seat.trim() : undefined;
  return {
    carrierIata: carrierIata.trim(),
    flightNumber: flightNumber.trim(),
    originIata: originIata.trim(),
    destinationIata: destinationIata.trim(),
    departingAt,
    arrivingAt,
    ...(seat ? { seat } : {}),
  };
}

function numeroVueloDe(seg: SegmentoValidado): string {
  return `${seg.carrierIata} ${seg.flightNumber}`;
}

/**
 * Verifica el encabezado `X-Webhook-Signature: t=<epoch>,v1=<hex>` de la aerolínea
 * (specs/externos/aerolinea.md): HMAC-SHA256 sobre `t + "." + cuerpoCrudo`, comparación en tiempo
 * constante y ventana de 5 minutos.
 */
export function verificarFirmaAerolinea(
  cuerpoCrudo: Buffer,
  encabezadoFirma: string | undefined,
  secreto: string,
  ahoraMs: number = Date.now(),
  toleranciaSeg: number = TOLERANCIA_FIRMA_DEFECTO_SEG,
): void {
  if (!encabezadoFirma) {
    throw new ErrorFirmaInvalida('Falta el encabezado X-Webhook-Signature.');
  }
  const coincidencia = PATRON_FIRMA.exec(encabezadoFirma.trim());
  if (!coincidencia?.[1] || !coincidencia[2]) {
    throw new ErrorFirmaInvalida(
      'El encabezado X-Webhook-Signature no tiene formato t=...,v1=....',
    );
  }
  const timestamp = Number(coincidencia[1]);
  const ahoraSeg = Math.floor(ahoraMs / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(ahoraSeg - timestamp) > toleranciaSeg) {
    throw new ErrorFirmaInvalida('La marca temporal de la firma excede la ventana de 5 minutos.');
  }
  const esperada = createHmac('sha256', secreto)
    .update(`${coincidencia[1]}.`)
    .update(cuerpoCrudo)
    .digest('hex');
  const bufEsperada = Buffer.from(esperada, 'utf8');
  const bufRecibida = Buffer.from(coincidencia[2], 'utf8');
  if (bufEsperada.length !== bufRecibida.length || !timingSafeEqual(bufEsperada, bufRecibida)) {
    throw new ErrorFirmaInvalida('La firma HMAC del aviso no coincide.');
  }
}

/**
 * Adaptador de aerolínea (inspirado en Duffel, specs/externos/aerolinea.md).
 * Trabaja en modo `aviso` (webhook firmado con HMAC) y soporta reprogramaciones.
 */
export function crearAdaptadorAerolinea(
  opciones: OpcionesAdaptadorAerolinea,
): AdaptadorProveedorViaje {
  const {
    nombre,
    url,
    claveApi,
    secretoWebhook,
    tiempoMaximoMs = 5000,
    toleranciaFirmaSeg = TOLERANCIA_FIRMA_DEFECTO_SEG,
    ahora = Date.now,
    fetch: hacerFetch = fetch,
  } = opciones;

  const baseUrl = url.replace(/\/+$/, '');

  function encabezadosAuth(): Record<string, string> {
    return {
      Authorization: `Bearer ${claveApi}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  function recibirAviso(cuerpo: Buffer | string, headers: EncabezadosAviso): ResultadoAvisoCrudo {
    const cuerpoBuffer = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo, 'utf8');
    const firma = leerEncabezado(headers, 'x-webhook-signature');
    verificarFirmaAerolinea(cuerpoBuffer, firma, secretoWebhook, ahora(), toleranciaFirmaSeg);

    try {
      const mensaje: unknown = JSON.parse(cuerpoBuffer.toString('utf8'));
      return { mensaje };
    } catch {
      throw new ErrorCuerpoNoJson(cuerpoBuffer.length);
    }
  }

  async function consultarCambios(_desde: string): Promise<ResultadoConsultaCruda> {
    return { mensajes: [] };
  }

  function traducir(mensaje: unknown, estadoPrevio?: EstadoReservaProveedor): ResultadoTraduccion {
    const fallar = (motivo: string): ResultadoTraduccion => ({
      ok: false,
      motivo,
      cuerpoSinDatosPersonales: serializarSinDatosPersonales(mensaje),
    });

    if (!esObjeto(mensaje)) return fallar('El aviso no es un objeto JSON.');
    const data = mensaje.data;
    const objeto = esObjeto(data) ? data.object : undefined;
    if (!esObjeto(objeto)) return fallar('Falta data.object.order.');
    const order = objeto.order;
    if (!esObjeto(order)) return fallar('Falta data.object.order.');

    const bookingReference = order.booking_reference;
    if (!esCadenaNoVacia(bookingReference)) return fallar('Falta booking_reference.');

    const statusCrudo = order.status;
    const estado = typeof statusCrudo === 'string' ? ESTADOS_AEROLINEA[statusCrudo] : undefined;
    if (!estado) {
      return fallar(`status desconocido: ${String(statusCrudo)}.`);
    }

    const version = order.version;
    if (!esEnteroPositivo(version)) return fallar('Falta version válida en la orden.');

    const segmentsCrudos = order.segments;
    if (!Array.isArray(segmentsCrudos)) return fallar('Falta segments en la orden.');

    const marcaTemporal = esFechaIsoValida(order.updated_at) ? order.updated_at : undefined;
    const numeroReserva = bookingReference.trim();

    if (estado === 'cancelada') {
      const estadoActual: EstadoReservaProveedor = {
        estado: 'cancelada',
        ...(estadoPrevio?.inicio ? { inicio: estadoPrevio.inicio } : {}),
        ...(estadoPrevio?.fin ? { fin: estadoPrevio.fin } : {}),
        ...(estadoPrevio?.origen ? { origen: estadoPrevio.origen } : {}),
        ...(estadoPrevio?.destino ? { destino: estadoPrevio.destino } : {}),
        detalle: estadoPrevio?.detalle ?? {},
        versionCambio: String(version),
      };
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

    if (segmentsCrudos.length === 0) {
      return fallar('La orden no tiene segmentos y no está cancelada.');
    }

    const segmentos: SegmentoValidado[] = [];
    for (const seg of segmentsCrudos) {
      const parsed = parsearSegmento(seg);
      if (!parsed)
        return fallar('Un segmento de la orden tiene datos faltantes o fechas inválidas.');
      segmentos.push(parsed);
    }

    const primer = segmentos[0];
    const ultimo = segmentos.at(-1);
    if (!primer || !ultimo) {
      return fallar('La orden no tiene segmentos y no está cancelada.');
    }
    const vueloActual = numeroVueloDe(primer);

    const removedCrudos = Array.isArray(objeto.removed) ? objeto.removed : [];
    const removed = removedCrudos
      .map(parsearSegmento)
      .filter((s): s is SegmentoValidado => s !== undefined);

    const cambios: CambiosReserva = {};
    const detalleCambios: Record<string, unknown> = {};

    const primerPrev = removed[0];
    const ultimoPrev = removed.at(-1);
    if (primerPrev && ultimoPrev) {
      if (primer.departingAt !== primerPrev.departingAt) cambios.inicio = primer.departingAt;
      if (ultimo.arrivingAt !== ultimoPrev.arrivingAt) cambios.fin = ultimo.arrivingAt;
      if (primer.originIata !== primerPrev.originIata) cambios.origen = primer.originIata;
      if (ultimo.destinationIata !== ultimoPrev.destinationIata) {
        cambios.destino = ultimo.destinationIata;
      }
      if (vueloActual !== numeroVueloDe(primerPrev)) detalleCambios.numeroVuelo = vueloActual;
      if (primer.seat && primer.seat !== primerPrev.seat) detalleCambios.asiento = primer.seat;
    } else if (estadoPrevio) {
      if (primer.departingAt !== estadoPrevio.inicio) cambios.inicio = primer.departingAt;
      if (ultimo.arrivingAt !== estadoPrevio.fin) cambios.fin = ultimo.arrivingAt;
      if (primer.originIata !== estadoPrevio.origen) cambios.origen = primer.originIata;
      if (ultimo.destinationIata !== estadoPrevio.destino) cambios.destino = ultimo.destinationIata;
      if (vueloActual !== estadoPrevio.detalle.numeroVuelo) {
        detalleCambios.numeroVuelo = vueloActual;
      }
      if (primer.seat && primer.seat !== estadoPrevio.detalle.asiento) {
        detalleCambios.asiento = primer.seat;
      }
    }

    if (Object.keys(detalleCambios).length > 0) {
      cambios.detalle = detalleCambios;
    }

    // specs/schemas/ReservaActualizada.json exige al menos un campo en `cambios` cuando es modificada.
    if (estado === 'modificada' && Object.keys(cambios).length === 0) {
      cambios.inicio = primer.departingAt;
      cambios.fin = ultimo.arrivingAt;
      cambios.origen = primer.originIata;
      cambios.destino = ultimo.destinationIata;
      cambios.detalle = {
        numeroVuelo: vueloActual,
        ...(primer.seat ? { asiento: primer.seat } : {}),
      };
    }

    const estadoActual: EstadoReservaProveedor = {
      estado,
      inicio: primer.departingAt,
      fin: ultimo.arrivingAt,
      origen: primer.originIata,
      destino: ultimo.destinationIata,
      detalle: {
        numeroVuelo: vueloActual,
        ...(primer.seat ? { asiento: primer.seat } : {}),
      },
      versionCambio: String(version),
    };

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
    numeroReserva: string,
  ): Promise<OpcionReprogramacion[]> {
    const respOrden = await llamarProveedorHttp(
      hacerFetch,
      `${baseUrl}/air/orders?booking_reference=${encodeURIComponent(numeroReserva)}`,
      { method: 'GET', headers: encabezadosAuth() },
      tiempoMaximoMs,
      nombre,
    );
    if (respOrden.status === 503) {
      throw new ErrorProveedorExterno(503, 'proveedor-no-disponible', `${nombre} no disponible.`);
    }
    if (!respOrden.ok) {
      throw new ErrorProveedorExterno(
        502,
        'error-proveedor',
        `${nombre} respondió ${respOrden.status} al buscar la reserva ${numeroReserva}.`,
      );
    }
    const cuerpoOrden = (await respOrden.json()) as { data?: Array<{ id?: string }> };
    const orderId = cuerpoOrden.data?.[0]?.id;
    if (!esCadenaNoVacia(orderId)) {
      throw new ErrorProveedorExterno(
        404,
        'no-encontrado',
        `No existe la reserva ${numeroReserva} en ${nombre}.`,
      );
    }

    const respOpciones = await llamarProveedorHttp(
      hacerFetch,
      `${baseUrl}/air/order_change_requests`,
      {
        method: 'POST',
        headers: encabezadosAuth(),
        body: JSON.stringify({ data: { order_id: orderId } }),
      },
      tiempoMaximoMs,
      nombre,
    );
    if (respOpciones.status === 404) {
      throw new ErrorProveedorExterno(
        404,
        'no-encontrado',
        `No existe la reserva ${numeroReserva} en ${nombre}.`,
      );
    }
    if (respOpciones.status === 503) {
      throw new ErrorProveedorExterno(503, 'proveedor-no-disponible', `${nombre} no disponible.`);
    }
    if (!respOpciones.ok) {
      throw new ErrorProveedorExterno(
        502,
        'error-proveedor',
        `${nombre} respondió ${respOpciones.status} al pedir opciones de reprogramación.`,
      );
    }

    const cuerpoOpciones = (await respOpciones.json()) as {
      data?: { order_change_offers?: unknown[] };
    };
    const ofertas = cuerpoOpciones.data?.order_change_offers ?? [];
    const opcionesTraducidas: OpcionReprogramacion[] = [];
    for (const oferta of ofertas) {
      if (!esObjeto(oferta)) continue;
      const opcionId = oferta.id;
      const venceEn = oferta.expires_at;
      const monto = oferta.change_total_amount;
      const moneda = oferta.change_total_currency;
      const nuevos = Array.isArray(oferta.new_segments)
        ? oferta.new_segments
            .map(parsearSegmento)
            .filter((s): s is SegmentoValidado => s !== undefined)
        : [];
      const primero = nuevos[0];
      const ultimo = nuevos[nuevos.length - 1];
      if (
        !esCadenaNoVacia(opcionId) ||
        !esFechaIsoValida(venceEn) ||
        !esCadenaNoVacia(monto) ||
        !esCadenaNoVacia(moneda) ||
        !primero ||
        !ultimo
      ) {
        continue;
      }
      opcionesTraducidas.push({
        opcionId,
        venceEn,
        costo: { monto, moneda },
        inicio: primero.departingAt,
        fin: ultimo.arrivingAt,
        origen: primero.originIata,
        destino: ultimo.destinationIata,
        detalle: { numeroVuelo: numeroVueloDe(primero) },
      });
    }
    return opcionesTraducidas;
  }

  async function aplicarReprogramacion(
    _numeroReserva: string,
    opcionId: string,
  ): Promise<ResultadoAplicarReprogramacion> {
    const resp = await llamarProveedorHttp(
      hacerFetch,
      `${baseUrl}/air/order_changes`,
      {
        method: 'POST',
        headers: encabezadosAuth(),
        body: JSON.stringify({ data: { selected_order_change_offer: opcionId } }),
      },
      tiempoMaximoMs,
      nombre,
    );
    if (resp.status === 404) {
      throw new ErrorProveedorExterno(
        404,
        'no-encontrado',
        `La opción ${opcionId} no existe en ${nombre}.`,
      );
    }
    if (resp.status === 422) {
      throw new ErrorProveedorExterno(
        422,
        'opcion-no-disponible',
        `La opción ${opcionId} venció o ya fue utilizada.`,
      );
    }
    if (resp.status === 503) {
      throw new ErrorProveedorExterno(503, 'proveedor-no-disponible', `${nombre} no disponible.`);
    }
    if (!resp.ok) {
      throw new ErrorProveedorExterno(
        502,
        'error-proveedor',
        `${nombre} respondió ${resp.status} al aplicar la reprogramación.`,
      );
    }
    const cuerpo = (await resp.json()) as { data?: { confirmed_at?: string } };
    const aplicadaEn = esFechaIsoValida(cuerpo.data?.confirmed_at)
      ? cuerpo.data.confirmed_at
      : new Date(ahora()).toISOString();
    return { opcionId, aplicadaEn };
  }

  return {
    nombre,
    tipo: 'aerolinea',
    modo: 'aviso',
    intervaloConsultaMs: 0,
    recibirAviso,
    consultarCambios,
    traducir,
    pedirOpcionesReprogramacion,
    aplicarReprogramacion,
  };
}
