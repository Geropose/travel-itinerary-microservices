// Semillas coherentes entre los mocks de correo (Gmail y Outlook) y los mocks de proveedores
// (Aerolínea, Hotel y Rentadora): deriva las reservas directamente desde `cargarSemillas` para que
// los mismos números de reserva, pasajeros, fechas y destinos existan en ambos lados, más las 3
// reservas canónicas documentadas en specs/externos/{aerolinea,hotel,rentadora}.md.
import type { Correo, Etiqueta } from './correo.ts';
import { cargarSemillas } from './semillas.ts';

export interface SemillaVuelo {
  bookingReference: string;
  estado: 'confirmada' | 'modificada' | 'cancelada';
  pasajeroNombre: string;
  pasajeroApellido: string;
  codigoAerolinea: string;
  numeroVuelo: string;
  origenIata: string;
  origenCiudad: string;
  destinoIata: string;
  destinoCiudad: string;
  salida: string;
  llegada: string;
  asiento?: string;
  creadaEn: string;
}

export interface SemillaHotel {
  reservationId: string;
  estado: 'confirmada' | 'modificada' | 'cancelada';
  huespedNombre: string;
  huespedApellido: string;
  codigoHotel: string;
  nombreHotel: string;
  direccion: string;
  ciudad: string;
  pais: string;
  checkIn: string;
  checkOut: string;
  tipoHabitacion: string;
  descripcionHabitacion: string;
  huespedes: number;
  creadaEn: string;
}

export interface SemillaAuto {
  confirmationNumber: string;
  estado: 'confirmada' | 'modificada' | 'cancelada';
  conductorNombre: string;
  conductorApellido: string;
  acrissCode: string;
  categoria: string;
  marca: string;
  modelo: string;
  retiroCodigo: string;
  retiroNombre: string;
  retiroCiudad: string;
  retiroFecha: string;
  devolucionCodigo: string;
  devolucionNombre: string;
  devolucionCiudad: string;
  devolucionFecha: string;
  creadaEn: string;
}

export interface SemillasProveedores {
  vuelos: SemillaVuelo[];
  hoteles: SemillaHotel[];
  autos: SemillaAuto[];
}

const CIUDAD_POR_IATA: Record<string, string> = {
  EZE: 'Buenos Aires',
  AEP: 'Buenos Aires',
  COR: 'Córdoba',
  MDZ: 'Mendoza',
  BRC: 'San Carlos de Bariloche',
  SCL: 'Santiago',
  GRU: 'São Paulo',
  MVD: 'Montevideo',
  LIM: 'Lima',
  BOG: 'Bogotá',
  MAD: 'Madrid',
};

const SEDES_HOTEL: Record<string, { codigo: string; direccion: string; pais: string }> = {
  Santiago: { codigo: 'HC-SCL-01', direccion: 'Av. Providencia 1234', pais: 'CL' },
  Mendoza: { codigo: 'HC-MDZ-01', direccion: 'Av. San Martín 1520', pais: 'AR' },
  'San Carlos de Bariloche': {
    codigo: 'HC-BRC-01',
    direccion: 'Av. Exequiel Bustillo 9500',
    pais: 'AR',
  },
  Lima: { codigo: 'HC-LIM-01', direccion: 'Av. José Larco 812', pais: 'PE' },
};

const SUCURSALES_AUTO: Record<string, { codigo: string; ciudad: string }> = {
  'Rentadora Sur Aeropuerto SCL': { codigo: 'SCLA01', ciudad: 'Santiago' },
  'Rentadora Sur Centro Mendoza': { codigo: 'MDZC01', ciudad: 'Mendoza' },
  'Rentadora Sur Aeropuerto BRC': { codigo: 'BRCA01', ciudad: 'San Carlos de Bariloche' },
};

const ACRISS_POR_CATEGORIA: Record<string, string> = {
  Económico: 'ECMR',
  Compacto: 'CDMR',
  Intermedio: 'IDAR',
  SUV: 'IFAR',
};

function normalizarEstado(valor: string): 'confirmada' | 'modificada' | 'cancelada' {
  if (valor === 'cancelada' || valor === 'modificada') return valor;
  return 'confirmada';
}

function dividirNombre(completo: string): { nombre: string; apellido: string } {
  const partes = completo.trim().split(/\s+/);
  const nombre = partes[0] ?? 'Viajero';
  const apellido = partes.slice(1).join(' ') || 'Trotamundos';
  return { nombre, apellido };
}

function leerJsonLd(html: string | undefined): Record<string, unknown> | undefined {
  if (!html) return undefined;
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i.exec(html);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Convierte "2026-12-10 08:30 (-03:00)" a "2026-12-10T08:30:00-03:00". */
function textoPlantillaAIso(texto: string): string | undefined {
  const m = /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+\(([+-]\d{2}:\d{2})\)/.exec(texto);
  if (!m) return undefined;
  return `${m[1]}T${m[2]}:00${m[3]}`;
}

function extraerVuelo(correo: Correo, etiqueta: Etiqueta): SemillaVuelo | undefined {
  if (etiqueta.reserva?.tipoReserva !== 'vuelo') return undefined;
  const ld = leerJsonLd(correo.html);
  if (ld) {
    const underName = ld.underName as { name?: string } | undefined;
    const vuelo = ld.reservationFor as
      | {
          flightNumber?: string;
          airline?: { iataCode?: string };
          departureAirport?: { iataCode?: string };
          arrivalAirport?: { iataCode?: string };
          departureTime?: string;
          arrivalTime?: string;
        }
      | undefined;
    const { nombre, apellido } = dividirNombre(underName?.name ?? 'Ana García');
    const origenIata = vuelo?.departureAirport?.iataCode ?? 'EZE';
    const destinoIata = vuelo?.arrivalAirport?.iataCode ?? 'SCL';
    const asiento = typeof ld.airplaneSeat === 'string' ? ld.airplaneSeat : undefined;
    return {
      bookingReference: etiqueta.reserva.numeroReserva,
      estado: normalizarEstado(etiqueta.reserva.estado),
      pasajeroNombre: nombre,
      pasajeroApellido: apellido,
      codigoAerolinea: vuelo?.airline?.iataCode ?? 'AN',
      numeroVuelo: vuelo?.flightNumber ?? '1234',
      origenIata,
      origenCiudad: CIUDAD_POR_IATA[origenIata] ?? origenIata,
      destinoIata,
      destinoCiudad: CIUDAD_POR_IATA[destinoIata] ?? destinoIata,
      salida: vuelo?.departureTime ?? correo.fecha.toISOString(),
      llegada: vuelo?.arrivalTime ?? correo.fecha.toISOString(),
      ...(asiento ? { asiento } : {}),
      creadaEn: correo.fecha.toISOString(),
    };
  }

  const mVuelo = /Vuelo:\s+([A-Z0-9]{2})\s+(\d+)/.exec(correo.texto);
  const mSalida = /Salida:\s+([A-Z]{3})\s+(.+)/.exec(correo.texto);
  const mLlegada = /Llegada:\s+([A-Z]{3})\s+(.+)/.exec(correo.texto);
  if (!mVuelo || !mSalida || !mLlegada) return undefined;
  const origenIata = mSalida[1] ?? 'EZE';
  const destinoIata = mLlegada[1] ?? 'SCL';
  return {
    bookingReference: etiqueta.reserva.numeroReserva,
    estado: normalizarEstado(etiqueta.reserva.estado),
    pasajeroNombre: 'Viajero',
    pasajeroApellido: 'Trotamundos',
    codigoAerolinea: mVuelo[1] ?? 'AN',
    numeroVuelo: mVuelo[2] ?? '1234',
    origenIata,
    origenCiudad: CIUDAD_POR_IATA[origenIata] ?? origenIata,
    destinoIata,
    destinoCiudad: CIUDAD_POR_IATA[destinoIata] ?? destinoIata,
    salida: textoPlantillaAIso(mSalida[2] ?? '') ?? correo.fecha.toISOString(),
    llegada: textoPlantillaAIso(mLlegada[2] ?? '') ?? correo.fecha.toISOString(),
    creadaEn: correo.fecha.toISOString(),
  };
}

function extraerHotel(correo: Correo, etiqueta: Etiqueta): SemillaHotel | undefined {
  if (etiqueta.reserva?.tipoReserva !== 'hotel') return undefined;
  const ld = leerJsonLd(correo.html);
  if (ld) {
    const underName = ld.underName as { name?: string } | undefined;
    const lugar = ld.reservationFor as
      | {
          name?: string;
          address?: {
            streetAddress?: string;
            addressLocality?: string;
            addressCountry?: string;
          };
        }
      | undefined;
    const { nombre, apellido } = dividirNombre(underName?.name ?? 'Ana García');
    const ciudad = lugar?.address?.addressLocality ?? 'Santiago';
    const sede = SEDES_HOTEL[ciudad] ?? {
      codigo: 'HC-SCL-01',
      direccion: lugar?.address?.streetAddress ?? 'Av. Providencia 1234',
      pais: lugar?.address?.addressCountry ?? 'CL',
    };
    return {
      reservationId: etiqueta.reserva.numeroReserva,
      estado: normalizarEstado(etiqueta.reserva.estado),
      huespedNombre: nombre,
      huespedApellido: apellido,
      codigoHotel: sede.codigo,
      nombreHotel: lugar?.name ?? 'Hotel Cordillera',
      direccion: lugar?.address?.streetAddress ?? sede.direccion,
      ciudad,
      pais: lugar?.address?.addressCountry ?? sede.pais,
      checkIn: String(ld.checkinDate ?? correo.fecha.toISOString()),
      checkOut: String(ld.checkoutDate ?? correo.fecha.toISOString()),
      tipoHabitacion: 'DBL',
      descripcionHabitacion: 'Doble superior',
      huespedes: 2,
      creadaEn: correo.fecha.toISOString(),
    };
  }

  const mCiudad = /Ciudad:\s+(.+)/.exec(correo.texto);
  const mEntrada = /Entrada:\s+(.+)/.exec(correo.texto);
  const mSalida = /Salida:\s+(.+)/.exec(correo.texto);
  if (!mCiudad || !mEntrada || !mSalida) return undefined;
  const ciudad = (mCiudad[1] ?? 'Santiago').trim();
  const sede = SEDES_HOTEL[ciudad] ?? {
    codigo: 'HC-SCL-01',
    direccion: 'Av. Providencia 1234',
    pais: 'CL',
  };
  return {
    reservationId: etiqueta.reserva.numeroReserva,
    estado: normalizarEstado(etiqueta.reserva.estado),
    huespedNombre: 'Viajero',
    huespedApellido: 'Trotamundos',
    codigoHotel: sede.codigo,
    nombreHotel: 'Hotel Cordillera',
    direccion: sede.direccion,
    ciudad,
    pais: sede.pais,
    checkIn: textoPlantillaAIso(mEntrada[1] ?? '') ?? correo.fecha.toISOString(),
    checkOut: textoPlantillaAIso(mSalida[1] ?? '') ?? correo.fecha.toISOString(),
    tipoHabitacion: 'DBL',
    descripcionHabitacion: 'Doble superior',
    huespedes: 2,
    creadaEn: correo.fecha.toISOString(),
  };
}

function extraerAuto(correo: Correo, etiqueta: Etiqueta): SemillaAuto | undefined {
  if (etiqueta.reserva?.tipoReserva !== 'auto') return undefined;
  const ld = leerJsonLd(correo.html);
  if (ld) {
    const underName = ld.underName as { name?: string } | undefined;
    const auto = ld.reservationFor as
      { name?: string; model?: string; brand?: { name?: string } } | undefined;
    const retiro = ld.pickupLocation as { name?: string } | undefined;
    const devolucion = ld.dropoffLocation as { name?: string } | undefined;
    const { nombre, apellido } = dividirNombre(underName?.name ?? 'Ana García');
    const retiroNombre = retiro?.name ?? 'Rentadora Sur Aeropuerto SCL';
    const devolucionNombre = devolucion?.name ?? retiroNombre;
    const sucRetiro = SUCURSALES_AUTO[retiroNombre] ?? { codigo: 'SCLA01', ciudad: 'Santiago' };
    const sucDevolucion = SUCURSALES_AUTO[devolucionNombre] ?? sucRetiro;
    const categoria = auto?.name ?? 'Económico';
    return {
      confirmationNumber: etiqueta.reserva.numeroReserva,
      estado: normalizarEstado(etiqueta.reserva.estado),
      conductorNombre: nombre,
      conductorApellido: apellido,
      acrissCode: ACRISS_POR_CATEGORIA[categoria] ?? 'ECMR',
      categoria,
      marca: auto?.brand?.name ?? 'Toyota',
      modelo: auto?.model ?? 'Yaris',
      retiroCodigo: sucRetiro.codigo,
      retiroNombre,
      retiroCiudad: sucRetiro.ciudad,
      retiroFecha: String(ld.pickupTime ?? correo.fecha.toISOString()),
      devolucionCodigo: sucDevolucion.codigo,
      devolucionNombre,
      devolucionCiudad: sucDevolucion.ciudad,
      devolucionFecha: String(ld.dropoffTime ?? correo.fecha.toISOString()),
      creadaEn: correo.fecha.toISOString(),
    };
  }

  const mRetiro = /Retiro:\s+(.+?)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\([+-]\d{2}:\d{2}\))/.exec(
    correo.texto,
  );
  const mDev = /Devolución:\s+(.+?)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\([+-]\d{2}:\d{2}\))/.exec(
    correo.texto,
  );
  const mVeh = /Vehículo:\s+(\S+)\s+(.+?)\s+\((.+?)\)/.exec(correo.texto);
  if (!mRetiro || !mDev) return undefined;
  const retiroNombre = (mRetiro[1] ?? 'Rentadora Sur Aeropuerto SCL').trim();
  const devolucionNombre = (mDev[1] ?? retiroNombre).trim();
  const sucRetiro = SUCURSALES_AUTO[retiroNombre] ?? { codigo: 'SCLA01', ciudad: 'Santiago' };
  const sucDevolucion = SUCURSALES_AUTO[devolucionNombre] ?? sucRetiro;
  const categoria = mVeh?.[3]?.trim() ?? 'Económico';
  return {
    confirmationNumber: etiqueta.reserva.numeroReserva,
    estado: normalizarEstado(etiqueta.reserva.estado),
    conductorNombre: 'Viajero',
    conductorApellido: 'Trotamundos',
    acrissCode: ACRISS_POR_CATEGORIA[categoria] ?? 'ECMR',
    categoria,
    marca: mVeh?.[1]?.trim() ?? 'Toyota',
    modelo: mVeh?.[2]?.trim() ?? 'Yaris',
    retiroCodigo: sucRetiro.codigo,
    retiroNombre,
    retiroCiudad: sucRetiro.ciudad,
    retiroFecha: textoPlantillaAIso(mRetiro[2] ?? '') ?? correo.fecha.toISOString(),
    devolucionCodigo: sucDevolucion.codigo,
    devolucionNombre,
    devolucionCiudad: sucDevolucion.ciudad,
    devolucionFecha: textoPlantillaAIso(mDev[2] ?? '') ?? correo.fecha.toISOString(),
    creadaEn: correo.fecha.toISOString(),
  };
}

/** Reservas de ejemplo documentadas en specs/externos/{aerolinea,hotel,rentadora}.md. */
export const RESERVA_EJEMPLO_VUELO: SemillaVuelo = {
  bookingReference: 'XKQ7PL',
  estado: 'confirmada',
  pasajeroNombre: 'Ana',
  pasajeroApellido: 'García',
  codigoAerolinea: 'AN',
  numeroVuelo: '1234',
  origenIata: 'EZE',
  origenCiudad: 'Buenos Aires',
  destinoIata: 'SCL',
  destinoCiudad: 'Santiago',
  salida: '2026-12-10T08:30:00-03:00',
  llegada: '2026-12-10T10:40:00-03:00',
  asiento: '14C',
  creadaEn: '2026-11-20T13:40:00Z',
};

export const RESERVA_EJEMPLO_HOTEL: SemillaHotel = {
  reservationId: 'HC-48213',
  estado: 'confirmada',
  huespedNombre: 'Ana',
  huespedApellido: 'García',
  codigoHotel: 'HC-SCL-01',
  nombreHotel: 'Hotel Cordillera',
  direccion: 'Av. Providencia 1234',
  ciudad: 'Santiago',
  pais: 'CL',
  checkIn: '2026-12-10T15:00:00-03:00',
  checkOut: '2026-12-14T11:00:00-03:00',
  tipoHabitacion: 'DBL',
  descripcionHabitacion: 'Doble superior',
  huespedes: 2,
  creadaEn: '2026-11-20T14:02:00Z',
};

export const RESERVA_EJEMPLO_AUTO: SemillaAuto = {
  confirmationNumber: 'RS-77120',
  estado: 'confirmada',
  conductorNombre: 'Ana',
  conductorApellido: 'García',
  acrissCode: 'ECMR',
  categoria: 'Económico',
  marca: 'Toyota',
  modelo: 'Yaris',
  retiroCodigo: 'SCLA01',
  retiroNombre: 'Rentadora Sur Aeropuerto SCL',
  retiroCiudad: 'Santiago',
  retiroFecha: '2026-12-10T11:30:00-03:00',
  devolucionCodigo: 'SCLA01',
  devolucionNombre: 'Rentadora Sur Aeropuerto SCL',
  devolucionCiudad: 'Santiago',
  devolucionFecha: '2026-12-14T09:00:00-03:00',
  creadaEn: '2026-11-21T10:15:00Z',
};

/**
 * Devuelve todas las semillas de vuelos, hoteles y autos coherentes con los 20 buzones de
 * `cargarSemillas` (Gmail y Outlook) más las 3 reservas de ejemplo de los contratos externos.
 */
export function cargarSemillasProveedores(ahora = new Date()): SemillasProveedores {
  const vuelos = new Map<string, SemillaVuelo>([
    [RESERVA_EJEMPLO_VUELO.bookingReference, RESERVA_EJEMPLO_VUELO],
  ]);
  const hoteles = new Map<string, SemillaHotel>([
    [RESERVA_EJEMPLO_HOTEL.reservationId, RESERVA_EJEMPLO_HOTEL],
  ]);
  const autos = new Map<string, SemillaAuto>([
    [RESERVA_EJEMPLO_AUTO.confirmationNumber, RESERVA_EJEMPLO_AUTO],
  ]);

  cargarSemillas(
    'gmail.example',
    (_email, correo, etiqueta) => {
      const v = extraerVuelo(correo, etiqueta);
      if (v && !vuelos.has(v.bookingReference)) vuelos.set(v.bookingReference, v);
      const h = extraerHotel(correo, etiqueta);
      if (h && !hoteles.has(h.reservationId)) hoteles.set(h.reservationId, h);
      const a = extraerAuto(correo, etiqueta);
      if (a && !autos.has(a.confirmationNumber)) autos.set(a.confirmationNumber, a);
    },
    ahora,
  );

  return {
    vuelos: [...vuelos.values()],
    hoteles: [...hoteles.values()],
    autos: [...autos.values()],
  };
}
