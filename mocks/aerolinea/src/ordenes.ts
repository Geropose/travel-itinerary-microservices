// Modelo en memoria de órdenes, ofertas de reprogramación y generación de eventos webhook de
// Aerolínea Andina (specs/externos/aerolinea.md).
import { createHmac } from 'node:crypto';
import { cargarSemillasProveedores, type SemillaVuelo } from '@trotamundos/mocks-comun';

export type EstadoOrden = 'confirmed' | 'changed' | 'cancelled';

export interface SegmentoVuelo {
  id: string;
  marketing_carrier: { iata_code: string };
  marketing_carrier_flight_number: string;
  origin: { iata_code: string; city_name: string };
  destination: { iata_code: string; city_name: string };
  departing_at: string;
  arriving_at: string;
  seat?: string;
}

export interface OrdenVuelo {
  id: string;
  booking_reference: string;
  status: EstadoOrden;
  version: number;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  owner: { iata_code: string; name: string };
  passengers: { id: string; given_name: string; family_name: string }[];
  segments: SegmentoVuelo[];
}

export interface OfertaCambio {
  id: string;
  expires_at: string;
  change_total_amount: string;
  change_total_currency: string;
  new_segments: Omit<SegmentoVuelo, 'id' | 'seat'>[];
}

export interface PedidoCambioOrden {
  id: string;
  order_id: string;
  created_at: string;
  order_change_offers: OfertaCambio[];
}

export interface CambioConfirmado {
  id: string;
  order_id: string;
  selected_order_change_offer: string;
  confirmed_at: string;
}

export interface EventoWebhookAerolinea {
  id: string;
  type: 'order.airline_initiated_change_detected' | 'order.updated';
  created_at: string;
  idempotency_key: string;
  data: {
    object: {
      order: OrdenVuelo;
      removed: SegmentoVuelo[];
      added: SegmentoVuelo[];
    };
  };
}

export interface ConfigOpcionesOrden {
  cantidad?: number;
  ttlSeg?: number;
}

export interface CambioManualOrden {
  departing_at?: string;
  arriving_at?: string;
  desplazarMinutos?: number;
  flight_number?: string;
  origin_iata?: string;
  origin_city?: string;
  destination_iata?: string;
  destination_city?: string;
  seat?: string;
}

/** Firma X-Webhook-Signature: t=<epoch_s>,v1=<HMAC-SHA256 hex minúsculas sobre t + "." + cuerpo>. */
export function firmarWebhook(cuerpoTexto: string, secreto: string, instanteMs: number): string {
  const t = Math.floor(instanteMs / 1000);
  const v1 = createHmac('sha256', secreto).update(`${t}.${cuerpoTexto}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** Desplaza una fecha ISO 8601 conservando su sufijo de huso horario (Z o ±HH:MM). */
export function desplazarFechaIso(iso: string, minutos: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const nuevoMs = ms + minutos * 60_000;
  const zona = /(Z|[+-]\d{2}:\d{2})$/.exec(iso)?.[1] ?? 'Z';
  if (zona === 'Z') return new Date(nuevoMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const signo = zona.startsWith('-') ? -1 : 1;
  const [h = 0, m = 0] = zona.slice(1).split(':').map(Number);
  const offsetMs = signo * (h * 60 + m) * 60_000;
  const local = new Date(nuevoMs + offsetMs).toISOString().slice(0, 19);
  return `${local}${zona}`;
}

function clonarOrden(o: OrdenVuelo): OrdenVuelo {
  return {
    ...o,
    owner: { ...o.owner },
    passengers: o.passengers.map((p) => ({ ...p })),
    segments: o.segments.map((s) => ({
      ...s,
      marketing_carrier: { ...s.marketing_carrier },
      origin: { ...s.origin },
      destination: { ...s.destination },
    })),
  };
}

function estadoDesdeSemilla(estado: SemillaVuelo['estado']): EstadoOrden {
  if (estado === 'cancelada') return 'cancelled';
  if (estado === 'modificada') return 'changed';
  return 'confirmed';
}

interface OfertaGuardada {
  oferta: OfertaCambio;
  orderId: string;
  requestId: string;
  usada: boolean;
}

export interface AlmacenOrdenes {
  cargarSemillas(ahora?: Date): void;
  limpiar(): void;
  listar(filtro?: { bookingReference?: string; limit?: number }): OrdenVuelo[];
  buscarPorId(id: string): OrdenVuelo | undefined;
  buscarPorReferencia(ref: string): OrdenVuelo | undefined;
  buscar(idORef: string): OrdenVuelo | undefined;
  guardar(
    entrada: Omit<OrdenVuelo, 'id' | 'version' | 'created_at' | 'updated_at'> & {
      id?: string;
      version?: number;
      created_at?: string;
      updated_at?: string;
    },
  ): OrdenVuelo;
  configurarOpciones(idORef: string, cfg: ConfigOpcionesOrden): OrdenVuelo | undefined;
  cambiarOrden(
    idORef: string,
    cambios: CambioManualOrden,
  ): { orden: OrdenVuelo; evento: EventoWebhookAerolinea } | undefined;
  cancelarOrden(idORef: string): { orden: OrdenVuelo; evento: EventoWebhookAerolinea } | undefined;
  tormenta(
    cantidad: number,
    prefijo?: string,
  ): { ordenes: OrdenVuelo[]; eventos: EventoWebhookAerolinea[] };
  crearPedidoCambio(orderId: string): PedidoCambioOrden | undefined;
  aplicarOferta(ofertaId: string):
    | {
        ok: true;
        confirmacion: CambioConfirmado;
        orden: OrdenVuelo;
        evento: EventoWebhookAerolinea;
      }
    | { ok: false; motivo: 'not_found' | 'offer_no_longer_available'; mensaje: string };
}

export function crearAlmacenOrdenes(reloj: () => number = Date.now): AlmacenOrdenes {
  const porId = new Map<string, OrdenVuelo>();
  const idPorRef = new Map<string, string>();
  const ofertas = new Map<string, OfertaGuardada>();
  const configOpciones = new Map<string, ConfigOpcionesOrden>();

  let seqSeg = 1;
  let seqEvento = 1;
  let seqPedido = 1;
  let seqOferta = 100;
  let seqCambio = 1;
  let seqTormenta = 1;

  const nuevoSegId = () => `seg_${String(seqSeg++).padStart(4, '0')}`;
  const nuevoEventoId = () => `wev_0000AN${String(seqEvento++).padStart(10, '0')}`;
  const nuevoPedidoId = () => `ocr_0000AN${String(seqPedido++).padStart(10, '0')}`;
  const nuevaOfertaId = () => `oco_0000AN${String(seqOferta++).padStart(10, '0')}`;
  const nuevoCambioId = () => `oce_0000AN${String(seqCambio++).padStart(10, '0')}`;

  function insertarOrden(orden: OrdenVuelo): OrdenVuelo {
    const copia = clonarOrden(orden);
    porId.set(copia.id, copia);
    idPorRef.set(copia.booking_reference.toUpperCase(), copia.id);
    return clonarOrden(copia);
  }

  function desdeSemilla(s: SemillaVuelo): OrdenVuelo {
    const estado = estadoDesdeSemilla(s.estado);
    return {
      id: `ord_0000AN000${s.bookingReference}`,
      booking_reference: s.bookingReference,
      status: estado,
      version: 1,
      created_at: s.creadaEn,
      updated_at: s.creadaEn,
      cancelled_at: estado === 'cancelled' ? s.creadaEn : null,
      owner: { iata_code: s.codigoAerolinea, name: 'Aerolínea Andina' },
      passengers: [
        { id: 'pas_0001', given_name: s.pasajeroNombre, family_name: s.pasajeroApellido },
      ],
      segments: [
        {
          id: nuevoSegId(),
          marketing_carrier: { iata_code: s.codigoAerolinea },
          marketing_carrier_flight_number: s.numeroVuelo,
          origin: { iata_code: s.origenIata, city_name: s.origenCiudad },
          destination: { iata_code: s.destinoIata, city_name: s.destinoCiudad },
          departing_at: s.salida,
          arriving_at: s.llegada,
          ...(s.asiento ? { seat: s.asiento } : {}),
        },
      ],
    };
  }

  function buscarInterna(idORef: string): OrdenVuelo | undefined {
    const directa = porId.get(idORef);
    if (directa) return directa;
    const id = idPorRef.get(idORef.toUpperCase());
    return id ? porId.get(id) : undefined;
  }

  function armarEvento(
    tipo: EventoWebhookAerolinea['type'],
    orden: OrdenVuelo,
    removed: SegmentoVuelo[],
    added: SegmentoVuelo[],
    creadoEn: string,
  ): EventoWebhookAerolinea {
    return {
      id: nuevoEventoId(),
      type: tipo,
      created_at: creadoEn,
      idempotency_key: `${orden.booking_reference}-v${orden.version}`,
      data: {
        object: {
          order: clonarOrden(orden),
          removed: removed.map((s) => ({ ...s })),
          added: added.map((s) => ({ ...s })),
        },
      },
    };
  }

  return {
    cargarSemillas(ahora = new Date(reloj())) {
      const { vuelos } = cargarSemillasProveedores(ahora);
      for (const s of vuelos) insertarOrden(desdeSemilla(s));
    },

    limpiar() {
      porId.clear();
      idPorRef.clear();
      ofertas.clear();
      configOpciones.clear();
    },

    listar(filtro) {
      const limite = filtro?.limit ?? 50;
      if (filtro?.bookingReference) {
        const id = idPorRef.get(filtro.bookingReference.toUpperCase());
        const orden = id ? porId.get(id) : undefined;
        return orden ? [clonarOrden(orden)] : [];
      }
      return [...porId.values()].slice(0, limite).map(clonarOrden);
    },

    buscarPorId(id) {
      const o = porId.get(id);
      return o ? clonarOrden(o) : undefined;
    },

    buscarPorReferencia(ref) {
      const id = idPorRef.get(ref.toUpperCase());
      const o = id ? porId.get(id) : undefined;
      return o ? clonarOrden(o) : undefined;
    },

    buscar(idORef) {
      const o = buscarInterna(idORef);
      return o ? clonarOrden(o) : undefined;
    },

    guardar(entrada) {
      const ahora = new Date(reloj()).toISOString();
      const id = entrada.id ?? `ord_0000AN000${entrada.booking_reference}`;
      const orden: OrdenVuelo = {
        ...entrada,
        id,
        version: entrada.version ?? 1,
        created_at: entrada.created_at ?? ahora,
        updated_at: entrada.updated_at ?? ahora,
      };
      return insertarOrden(orden);
    },

    configurarOpciones(idORef, cfg) {
      const o = buscarInterna(idORef);
      if (!o) return undefined;
      configOpciones.set(o.id, cfg);
      return clonarOrden(o);
    },

    cambiarOrden(idORef, cambios) {
      const o = buscarInterna(idORef);
      if (!o) return undefined;
      const ahora = new Date(reloj()).toISOString();
      const anteriores = o.segments.map((s) => ({ ...s }));
      const primero = o.segments[0];
      if (!primero) return undefined;

      const delta =
        cambios.desplazarMinutos ?? (cambios.departing_at || cambios.arriving_at ? 0 : 120);
      const nuevoSeg: SegmentoVuelo = {
        ...primero,
        id: nuevoSegId(),
        marketing_carrier: { ...primero.marketing_carrier },
        marketing_carrier_flight_number:
          cambios.flight_number ?? primero.marketing_carrier_flight_number,
        origin: {
          iata_code: cambios.origin_iata ?? primero.origin.iata_code,
          city_name: cambios.origin_city ?? primero.origin.city_name,
        },
        destination: {
          iata_code: cambios.destination_iata ?? primero.destination.iata_code,
          city_name: cambios.destination_city ?? primero.destination.city_name,
        },
        departing_at: cambios.departing_at ?? desplazarFechaIso(primero.departing_at, delta),
        arriving_at: cambios.arriving_at ?? desplazarFechaIso(primero.arriving_at, delta),
        ...(cambios.seat !== undefined
          ? { seat: cambios.seat }
          : primero.seat
            ? { seat: primero.seat }
            : {}),
      };

      const nuevosSegmentos = [nuevoSeg, ...o.segments.slice(1)];
      o.segments = nuevosSegmentos;
      o.status = 'changed';
      o.cancelled_at = null;
      o.version += 1;
      o.updated_at = ahora;

      const evento = armarEvento(
        'order.airline_initiated_change_detected',
        o,
        anteriores,
        [nuevoSeg],
        ahora,
      );
      return { orden: clonarOrden(o), evento };
    },

    cancelarOrden(idORef) {
      const o = buscarInterna(idORef);
      if (!o) return undefined;
      const ahora = new Date(reloj()).toISOString();
      const anteriores = o.segments.map((s) => ({ ...s }));
      o.status = 'cancelled';
      o.cancelled_at = ahora;
      o.version += 1;
      o.updated_at = ahora;

      const evento = armarEvento(
        'order.airline_initiated_change_detected',
        o,
        anteriores,
        [],
        ahora,
      );
      return { orden: clonarOrden(o), evento };
    },

    tormenta(cantidad, prefijo = 'STM') {
      const ahora = new Date(reloj()).toISOString();
      const salidaBase = desplazarFechaIso(ahora, 24 * 60);
      const llegadaBase = desplazarFechaIso(ahora, 26 * 60);
      const ordenes: OrdenVuelo[] = [];
      const eventos: EventoWebhookAerolinea[] = [];

      // Primero cancelamos órdenes activas ya cargadas (para que las pruebas con semillas reaccionen).
      for (const existente of porId.values()) {
        if (ordenes.length >= cantidad) break;
        if (existente.status === 'cancelled') continue;
        const anteriores = existente.segments.map((s) => ({ ...s }));
        existente.status = 'cancelled';
        existente.cancelled_at = ahora;
        existente.version += 1;
        existente.updated_at = ahora;
        ordenes.push(clonarOrden(existente));
        eventos.push(
          armarEvento('order.airline_initiated_change_detected', existente, anteriores, [], ahora),
        );
      }

      // Si se piden más (p. ej. tormenta a escala de 1.000 o 50.000 vuelos), creamos y cancelamos sintéticas.
      while (ordenes.length < cantidad) {
        const ref = `${prefijo}${String(seqTormenta++).padStart(5, '0')}`;
        const seg: SegmentoVuelo = {
          id: nuevoSegId(),
          marketing_carrier: { iata_code: 'AN' },
          marketing_carrier_flight_number: String(2000 + (seqTormenta % 800)),
          origin: { iata_code: 'EZE', city_name: 'Buenos Aires' },
          destination: { iata_code: 'SCL', city_name: 'Santiago' },
          departing_at: salidaBase,
          arriving_at: llegadaBase,
        };
        const orden: OrdenVuelo = {
          id: `ord_0000AN000${ref}`,
          booking_reference: ref,
          status: 'cancelled',
          version: 2,
          created_at: ahora,
          updated_at: ahora,
          cancelled_at: ahora,
          owner: { iata_code: 'AN', name: 'Aerolínea Andina' },
          passengers: [{ id: 'pas_0001', given_name: 'Pasajero', family_name: ref }],
          segments: [seg],
        };
        porId.set(orden.id, orden);
        idPorRef.set(ref.toUpperCase(), orden.id);
        ordenes.push(clonarOrden(orden));
        eventos.push(
          armarEvento('order.airline_initiated_change_detected', orden, [seg], [], ahora),
        );
      }

      return { ordenes, eventos };
    },

    crearPedidoCambio(orderId) {
      const o = porId.get(orderId);
      if (!o) return undefined;
      const base = o.segments[0];
      if (!base) return undefined;

      const ahoraMs = reloj();
      const creadoEn = new Date(ahoraMs).toISOString();
      const cfg = configOpciones.get(o.id);
      const cantidad = Math.max(0, Math.min(3, cfg?.cantidad ?? 2));
      const ttlSeg = cfg?.ttlSeg ?? 1800;
      const expiraEn = new Date(ahoraMs + ttlSeg * 1000).toISOString();
      const requestId = nuevoPedidoId();

      const saltosHoras = [3, 6, 24];
      const precios = ['0.00', '45.00', '90.00'];
      const numBase = Number.parseInt(base.marketing_carrier_flight_number, 10) || 1200;

      const listaOfertas: OfertaCambio[] = Array.from({ length: cantidad }, (_, i) => {
        const horas = saltosHoras[i] ?? (i + 1) * 4;
        const oferta: OfertaCambio = {
          id: nuevaOfertaId(),
          expires_at: expiraEn,
          change_total_amount:
            o.status === 'cancelled' && i === 0 ? '0.00' : (precios[i] ?? '0.00'),
          change_total_currency: 'USD',
          new_segments: [
            {
              marketing_carrier: { iata_code: base.marketing_carrier.iata_code },
              marketing_carrier_flight_number: String(numBase + (i + 1) * 6),
              origin: { ...base.origin },
              destination: { ...base.destination },
              departing_at: desplazarFechaIso(base.departing_at, horas * 60),
              arriving_at: desplazarFechaIso(base.arriving_at, horas * 60),
            },
          ],
        };
        ofertas.set(oferta.id, { oferta, orderId: o.id, requestId, usada: false });
        return oferta;
      });

      return {
        id: requestId,
        order_id: o.id,
        created_at: creadoEn,
        order_change_offers: listaOfertas,
      };
    },

    aplicarOferta(ofertaId) {
      const guardada = ofertas.get(ofertaId);
      if (!guardada) {
        return { ok: false, motivo: 'not_found', mensaje: `Offer ${ofertaId} not found` };
      }
      const ahoraMs = reloj();
      if (guardada.usada || Date.parse(guardada.oferta.expires_at) <= ahoraMs) {
        return {
          ok: false,
          motivo: 'offer_no_longer_available',
          mensaje: `Offer ${ofertaId} is expired or already used`,
        };
      }
      const o = porId.get(guardada.orderId);
      if (!o) {
        return { ok: false, motivo: 'not_found', mensaje: `Order ${guardada.orderId} not found` };
      }

      // Marca todas las ofertas de ese pedido como usadas para impedir doble aplicación.
      for (const item of ofertas.values()) {
        if (item.requestId === guardada.requestId) item.usada = true;
      }

      const ahora = new Date(ahoraMs).toISOString();
      const anteriores = o.segments.map((s) => ({ ...s }));
      const asientoAnterior = o.segments[0]?.seat;
      const nuevos: SegmentoVuelo[] = guardada.oferta.new_segments.map((seg, idx) => ({
        id: nuevoSegId(),
        ...seg,
        ...(idx === 0 && asientoAnterior ? { seat: asientoAnterior } : {}),
      }));

      o.segments = nuevos;
      o.status = 'changed';
      o.cancelled_at = null;
      o.version += 1;
      o.updated_at = ahora;

      const evento = armarEvento('order.updated', o, anteriores, nuevos, ahora);
      const confirmacion: CambioConfirmado = {
        id: nuevoCambioId(),
        order_id: o.id,
        selected_order_change_offer: ofertaId,
        confirmed_at: ahora,
      };
      return { ok: true, confirmacion, orden: clonarOrden(o), evento };
    },
  };
}
