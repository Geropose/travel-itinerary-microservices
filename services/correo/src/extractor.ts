// Detección y extracción de reservas de viaje desde correos (specs/externos/correos-reserva.md):
// 1) Marcado schema.org JSON-LD (FlightReservation, LodgingReservation, RentalCarReservation)
// 2) Reglas de texto para plantillas sin marcado
// 3) Clasificación de errores de parseo (no_procesados) o correos que no son de viaje (ignorar).
import type { MensajeCorreo } from './adaptadores/tipos.ts';

export type TipoReserva = 'vuelo' | 'hotel' | 'auto';
export type EstadoReservaDetectada = 'confirmada' | 'modificada' | 'cancelada';
export type MotivoNoProcesado =
  'sin-regla' | 'marcado-invalido' | 'estado-no-confirmado' | 'proveedor-desconocido';

export interface ReservaDetectadaDatos {
  usuarioId: string;
  proveedor: string;
  tipoReserva: TipoReserva;
  numeroReserva: string;
  inicio: string;
  fin: string;
  origen?: string;
  destino: string;
  estado: EstadoReservaDetectada;
  detalle: Record<string, unknown>;
  correoId: string;
}

export type ResultadoExtraccion =
  | { tipo: 'reserva'; datos: ReservaDetectadaDatos }
  | { tipo: 'no-procesado'; motivo: MotivoNoProcesado; detalle: string }
  | { tipo: 'no-viaje' };

/** Tabla dominio remitente -> identificador de proveedor compartido con Integraciones y Viajes. */
export const TABLA_PROVEEDORES_DEFECTO: Readonly<Record<string, string>> = {
  'aerolinea-andina.example': 'aerolinea-andina',
  'hotel-cordillera.example': 'hotel-cordillera',
  'rentadora-sur.example': 'rentadora-sur',
};

const TIPOS_RESERVA_SCHEMA = new Set([
  'FlightReservation',
  'LodgingReservation',
  'RentalCarReservation',
]);

const REGEX_BLOQUE_JSONLD =
  /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

const REGEX_FECHA_TEXTO = /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+\(([+-]\d{2}:\d{2})\)/;

const REGEX_INTENCION_VIAJE =
  /\b(reserva|reservation|itinerario|itinerary|boarding|check-?in|check-?out|cambio de fechas|confirmaci[oó]n de (tu )?(reserva|viaje)|c[oó]digo de reserva|n[uú]mero de reserva)\b/i;

function obj(valor: unknown): Record<string, unknown> | undefined {
  return valor && typeof valor === 'object' && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : undefined;
}

function textoNoVacio(valor: unknown): string | undefined {
  if (typeof valor !== 'string') return undefined;
  const limpio = valor.trim();
  return limpio.length > 0 ? limpio : undefined;
}

function esFechaIsoValida(valor: string | undefined): valor is string {
  if (!valor) return false;
  // Exigimos formato date-time con zona o Z compatible con ajv-formats date-time.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(valor)) {
    return false;
  }
  return !Number.isNaN(Date.parse(valor));
}

export function dominioDeEmail(email: string): string {
  const limpio = email.trim().toLowerCase();
  const arroba = limpio.lastIndexOf('@');
  return arroba >= 0 ? limpio.slice(arroba + 1) : '';
}

function resolverProveedor(
  remitente: string,
  tabla: Readonly<Record<string, string>>,
): string | undefined {
  const dominio = dominioDeEmail(remitente);
  return dominio ? tabla[dominio] : undefined;
}

function quitarPrefijoSchema(valor: string): string {
  return valor.replace(/^https?:\/\/schema\.org\//i, '').trim();
}

function normalizarTipos(rawTipo: unknown): string[] {
  const lista = Array.isArray(rawTipo) ? rawTipo : [rawTipo];
  return lista
    .filter((v): v is string => typeof v === 'string')
    .map(quitarPrefijoSchema)
    .filter(Boolean);
}

function recolectarNodos(valor: unknown, salida: Record<string, unknown>[]): void {
  if (Array.isArray(valor)) {
    for (const item of valor) recolectarNodos(item, salida);
    return;
  }
  const nodo = obj(valor);
  if (!nodo) return;
  if (Array.isArray(nodo['@graph'])) recolectarNodos(nodo['@graph'], salida);
  const tipos = normalizarTipos(nodo['@type']);
  if (tipos.some((t) => TIPOS_RESERVA_SCHEMA.has(t))) {
    salida.push(nodo);
  }
}

function resolverEstadoMarcado(
  statusRaw: unknown,
  modifiedTimeRaw: unknown,
):
  | { ok: true; estado: EstadoReservaDetectada }
  | { ok: false; motivo: 'estado-no-confirmado' | 'marcado-invalido'; detalle: string } {
  const statusStr = textoNoVacio(statusRaw);
  if (!statusStr) {
    return { ok: false, motivo: 'marcado-invalido', detalle: 'Falta reservationStatus.' };
  }
  const sufijo = quitarPrefijoSchema(statusStr).toLowerCase();
  if (sufijo === 'reservationhold' || sufijo === 'reservationpending') {
    return {
      ok: false,
      motivo: 'estado-no-confirmado',
      detalle: `La reserva llegó en estado ${quitarPrefijoSchema(statusStr)}.`,
    };
  }
  if (sufijo === 'cancelled' || sufijo === 'reservationcancelled') {
    return { ok: true, estado: 'cancelada' };
  }
  if (sufijo === 'confirmed' || sufijo === 'reservationconfirmed') {
    return { ok: true, estado: textoNoVacio(modifiedTimeRaw) ? 'modificada' : 'confirmada' };
  }
  return {
    ok: false,
    motivo: 'marcado-invalido',
    detalle: `Estado desconocido en JSON-LD: ${statusStr}.`,
  };
}

function extraerDesdeNodoJsonLd(
  nodo: Record<string, unknown>,
  meta: {
    usuarioId: string;
    correoId: string;
    remitente: string;
    tablaProveedores: Readonly<Record<string, string>>;
  },
): ResultadoExtraccion {
  const tipos = normalizarTipos(nodo['@type']);
  const tipoSchema = tipos.find((t) => TIPOS_RESERVA_SCHEMA.has(t));
  if (!tipoSchema) {
    return { tipo: 'no-procesado', motivo: 'marcado-invalido', detalle: 'Falta @type de reserva.' };
  }

  const estadoRes = resolverEstadoMarcado(nodo.reservationStatus, nodo.modifiedTime);
  if (!estadoRes.ok) {
    return { tipo: 'no-procesado', motivo: estadoRes.motivo, detalle: estadoRes.detalle };
  }

  const numeroReserva = textoNoVacio(nodo.reservationNumber);
  const rf = obj(nodo.reservationFor);
  if (!numeroReserva || !rf) {
    return {
      tipo: 'no-procesado',
      motivo: 'marcado-invalido',
      detalle: 'Falta reservationNumber o reservationFor en el marcado.',
    };
  }

  const proveedor = resolverProveedor(meta.remitente, meta.tablaProveedores);
  if (!proveedor) {
    return {
      tipo: 'no-procesado',
      motivo: 'proveedor-desconocido',
      detalle: `Dominio no configurado para el remitente ${meta.remitente}.`,
    };
  }

  if (tipoSchema === 'FlightReservation') {
    const depAirport = obj(rf.departureAirport);
    const arrAirport = obj(rf.arrivalAirport);
    const airline = obj(rf.airline);
    const origen = textoNoVacio(depAirport?.iataCode);
    const destino = textoNoVacio(arrAirport?.iataCode);
    const inicio = textoNoVacio(rf.departureTime);
    const fin = textoNoVacio(rf.arrivalTime);
    const flightNumber = textoNoVacio(rf.flightNumber);
    const iataAirline = textoNoVacio(airline?.iataCode);
    const asiento = textoNoVacio(nodo.airplaneSeat);

    if (!origen || !destino || !esFechaIsoValida(inicio) || !esFechaIsoValida(fin)) {
      return {
        tipo: 'no-procesado',
        motivo: 'marcado-invalido',
        detalle: 'Faltan aeropuertos u horarios válidos en FlightReservation.',
      };
    }

    const detalle: Record<string, unknown> = {};
    if (iataAirline && flightNumber) detalle.numeroVuelo = `${iataAirline} ${flightNumber}`;
    else if (flightNumber) detalle.numeroVuelo = flightNumber;
    if (asiento) detalle.asiento = asiento;

    return {
      tipo: 'reserva',
      datos: {
        usuarioId: meta.usuarioId,
        proveedor,
        tipoReserva: 'vuelo',
        numeroReserva,
        inicio,
        fin,
        origen,
        destino,
        estado: estadoRes.estado,
        detalle,
        correoId: meta.correoId,
      },
    };
  }

  if (tipoSchema === 'LodgingReservation') {
    const inicio = textoNoVacio(nodo.checkinDate ?? nodo.checkinTime);
    const fin = textoNoVacio(nodo.checkoutDate ?? nodo.checkoutTime);
    const address = obj(rf.address);
    const destino = textoNoVacio(address?.addressLocality);
    const hotel = textoNoVacio(rf.name);
    const direccion = textoNoVacio(address?.streetAddress);
    const telefono = textoNoVacio(rf.telephone);

    if (!destino || !esFechaIsoValida(inicio) || !esFechaIsoValida(fin)) {
      return {
        tipo: 'no-procesado',
        motivo: 'marcado-invalido',
        detalle: 'Faltan ciudad o fechas de entrada/salida en LodgingReservation.',
      };
    }

    const detalle: Record<string, unknown> = {};
    if (hotel) detalle.hotel = hotel;
    if (direccion) detalle.direccion = direccion;
    if (telefono) detalle.telefono = telefono;

    return {
      tipo: 'reserva',
      datos: {
        usuarioId: meta.usuarioId,
        proveedor,
        tipoReserva: 'hotel',
        numeroReserva,
        inicio,
        fin,
        destino,
        estado: estadoRes.estado,
        detalle,
        correoId: meta.correoId,
      },
    };
  }

  // RentalCarReservation
  const pickupLoc = obj(nodo.pickupLocation);
  const dropoffLoc = obj(nodo.dropoffLocation);
  const pickupAddr = obj(pickupLoc?.address);
  const dropoffAddr = obj(dropoffLoc?.address);
  const origen = textoNoVacio(pickupLoc?.name) ?? textoNoVacio(pickupAddr?.addressLocality);
  const destino = textoNoVacio(dropoffLoc?.name) ?? textoNoVacio(dropoffAddr?.addressLocality);
  const inicio = textoNoVacio(nodo.pickupTime);
  const fin = textoNoVacio(nodo.dropoffTime);

  if (!destino || !esFechaIsoValida(inicio) || !esFechaIsoValida(fin)) {
    return {
      tipo: 'no-procesado',
      motivo: 'marcado-invalido',
      detalle: 'Faltan sucursal o fechas de retiro/devolución en RentalCarReservation.',
    };
  }

  const brand = obj(rf.brand);
  const marca = textoNoVacio(brand?.name);
  const modeloSolo = textoNoVacio(rf.model);
  const categoria = textoNoVacio(rf.name);
  const modelo = [marca, modeloSolo].filter(Boolean).join(' ');
  const detalle: Record<string, unknown> = {};
  if (modelo) detalle.modelo = modelo;
  if (categoria) detalle.categoria = categoria;

  return {
    tipo: 'reserva',
    datos: {
      usuarioId: meta.usuarioId,
      proveedor,
      tipoReserva: 'auto',
      numeroReserva,
      inicio,
      fin,
      ...(origen ? { origen } : {}),
      destino,
      estado: estadoRes.estado,
      detalle,
      correoId: meta.correoId,
    },
  };
}

/** Convierte cuerpo HTML (como el de Outlook cuando un correo solo tiene texto) en líneas planas. */
export function htmlATexto(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function momentoTextoAIso(texto: string): string | undefined {
  const m = REGEX_FECHA_TEXTO.exec(texto.trim());
  if (!m?.[1] || !m[2] || !m[3]) return undefined;
  const iso = `${m[1]}T${m[2]}:00${m[3]}`;
  return esFechaIsoValida(iso) ? iso : undefined;
}

function estadoPorAsunto(asunto: string): EstadoReservaDetectada {
  if (/cancel/i.test(asunto)) return 'cancelada';
  if (/cambio|modific/i.test(asunto)) return 'modificada';
  return 'confirmada';
}

function extraerDesdePlantillaTexto(
  texto: string,
  meta: {
    usuarioId: string;
    correoId: string;
    remitente: string;
    asunto: string;
    tablaProveedores: Readonly<Record<string, string>>;
  },
): ResultadoExtraccion | null {
  const lineas = texto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lineas.length === 0) return null;

  const cuerpo = lineas.join('\n');
  const estado = estadoPorAsunto(meta.asunto);

  let extraido:
    | {
        tipoReserva: TipoReserva;
        numeroReserva: string;
        inicio: string;
        fin: string;
        origen?: string;
        destino: string;
        detalle: Record<string, unknown>;
      }
    | undefined;

  // 1) Plantilla vuelo (correos-reserva.md sección 4)
  const codigoVuelo = /^C[oó]digo de reserva:\s*(\S+)/im.exec(cuerpo)?.[1];
  const lineaVuelo = /^Vuelo:\s*(.+)$/im.exec(cuerpo)?.[1]?.trim();
  const salidaVuelo = /^Salida:\s*([A-Z0-9]{3})\s+(.+)$/im.exec(cuerpo);
  const llegadaVuelo = /^Llegada:\s*([A-Z0-9]{3})\s+(.+)$/im.exec(cuerpo);
  if (
    codigoVuelo &&
    lineaVuelo &&
    salidaVuelo?.[1] &&
    salidaVuelo[2] &&
    llegadaVuelo?.[1] &&
    llegadaVuelo[2]
  ) {
    const inicio = momentoTextoAIso(salidaVuelo[2]);
    const fin = momentoTextoAIso(llegadaVuelo[2]);
    if (inicio && fin) {
      extraido = {
        tipoReserva: 'vuelo',
        numeroReserva: codigoVuelo.trim(),
        inicio,
        fin,
        origen: salidaVuelo[1].trim(),
        destino: llegadaVuelo[1].trim(),
        detalle: { numeroVuelo: lineaVuelo },
      };
    }
  }

  // 2) Plantilla hotel (correos-reserva.md sección 4)
  if (!extraido) {
    const numeroHotel = /^N[uú]mero de reserva:\s*(\S+)/im.exec(cuerpo)?.[1];
    const ciudadHotel = /^Ciudad:\s*(.+)$/im.exec(cuerpo)?.[1]?.trim();
    const entradaHotel = /^Entrada:\s*(.+)$/im.exec(cuerpo)?.[1];
    const salidaHotel = /^Salida:\s*(.+)$/im.exec(cuerpo)?.[1];
    if (numeroHotel && ciudadHotel && entradaHotel && salidaHotel) {
      const inicio = momentoTextoAIso(entradaHotel);
      const fin = momentoTextoAIso(salidaHotel);
      if (inicio && fin) {
        const tituloHotel = lineas[0]?.split(' - ')[0]?.trim();
        extraido = {
          tipoReserva: 'hotel',
          numeroReserva: numeroHotel.trim(),
          inicio,
          fin,
          destino: ciudadHotel,
          detalle: tituloHotel ? { hotel: tituloHotel } : {},
        };
      }
    }
  }

  // 3) Plantilla auto (correos-reserva.md sección 4)
  if (!extraido) {
    const numeroAuto = /^N[uú]mero de reserva:\s*(\S+)/im.exec(cuerpo)?.[1];
    const retiroAuto =
      /^Retiro:\s+(.+?)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\([+-]\d{2}:\d{2}\))$/im.exec(cuerpo);
    const devAuto =
      /^Devoluci[oó]n:\s+(.+?)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\([+-]\d{2}:\d{2}\))$/im.exec(
        cuerpo,
      );
    const vehiculoAuto = /^Veh[ií]culo:\s+(.+?)(?:\s+\(([^)]+)\))?$/im.exec(cuerpo);
    if (
      numeroAuto &&
      retiroAuto?.[1] &&
      retiroAuto[2] &&
      devAuto?.[1] &&
      devAuto[2] &&
      vehiculoAuto?.[1]
    ) {
      const inicio = momentoTextoAIso(retiroAuto[2]);
      const fin = momentoTextoAIso(devAuto[2]);
      if (inicio && fin) {
        const detalle: Record<string, unknown> = { modelo: vehiculoAuto[1].trim() };
        if (vehiculoAuto[2]) detalle.categoria = vehiculoAuto[2].trim();
        extraido = {
          tipoReserva: 'auto',
          numeroReserva: numeroAuto.trim(),
          inicio,
          fin,
          origen: retiroAuto[1].trim(),
          destino: devAuto[1].trim(),
          detalle,
        };
      }
    }
  }

  if (!extraido) return null;

  const proveedor = resolverProveedor(meta.remitente, meta.tablaProveedores);
  if (!proveedor) {
    return {
      tipo: 'no-procesado',
      motivo: 'proveedor-desconocido',
      detalle: `Dominio no configurado para el remitente ${meta.remitente}.`,
    };
  }
  return {
    tipo: 'reserva',
    datos: {
      usuarioId: meta.usuarioId,
      proveedor,
      ...extraido,
      estado,
      correoId: meta.correoId,
    },
  };
}

/**
 * Extrae una reserva desde un mensaje usando primero JSON-LD schema.org y luego reglas de texto.
 * Distingue correos que no son de viaje (ignorar) de correos de viaje no interpretables (no_procesados).
 */
export function extraerReservaDeCorreo(
  correo: MensajeCorreo,
  usuarioId: string,
  tablaProveedores: Readonly<Record<string, string>> = TABLA_PROVEEDORES_DEFECTO,
): ResultadoExtraccion {
  const html = correo.cuerpoHtml ?? '';
  const meta = {
    usuarioId,
    correoId: correo.id,
    remitente: correo.remitente,
    asunto: correo.asunto,
    tablaProveedores,
  };

  if (html) {
    const nodos: Record<string, unknown>[] = [];
    let falloParseoJsonLd = false;

    REGEX_BLOQUE_JSONLD.lastIndex = 0;
    let coincidencia: RegExpExecArray | null;
    while ((coincidencia = REGEX_BLOQUE_JSONLD.exec(html)) !== null) {
      const bloque = coincidencia[1]?.trim() ?? '';
      if (!bloque) continue;
      try {
        const parsed = JSON.parse(bloque) as unknown;
        recolectarNodos(parsed, nodos);
      } catch {
        if (/FlightReservation|LodgingReservation|RentalCarReservation|@type/i.test(bloque)) {
          falloParseoJsonLd = true;
        }
      }
    }

    if (nodos.length > 0) {
      return extraerDesdeNodoJsonLd(nodos[0] as Record<string, unknown>, meta);
    }
    if (falloParseoJsonLd) {
      return {
        tipo: 'no-procesado',
        motivo: 'marcado-invalido',
        detalle: 'El bloque JSON-LD de reserva tiene JSON inválido.',
      };
    }
  }

  const texto = correo.cuerpoTexto?.trim() ? correo.cuerpoTexto : html ? htmlATexto(html) : '';

  if (texto) {
    const plantilla = extraerDesdePlantillaTexto(texto, meta);
    if (plantilla) return plantilla;
  }

  const contenidoCombinado = `${correo.asunto}\n${texto}`;
  if (REGEX_INTENCION_VIAJE.test(contenidoCombinado)) {
    return {
      tipo: 'no-procesado',
      motivo: 'sin-regla',
      detalle: 'No hay marcado JSON-LD y el texto no coincide con ninguna plantilla.',
    };
  }

  return { tipo: 'no-viaje' };
}
