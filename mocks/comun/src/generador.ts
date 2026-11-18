// Generador de correos de prueba (specs/externos/correos-reserva.md): reservas de vuelo, hotel y
// auto con JSON-LD de schema.org, las mismas reservas sin marcado (solo texto), correos que no son
// de viaje y correos de viaje de remitentes que no son los proveedores de prueba.
//
// Con la misma semilla genera siempre los mismos correos, así las pruebas son repetibles.
import type { Correo, Etiqueta } from './correo.ts';

export const TIPOS = [
  'vuelo',
  'hotel',
  'auto',
  'vuelo-sin-marcado',
  'hotel-sin-marcado',
  'auto-sin-marcado',
  'no-viaje',
  'remitente-no-permitido',
] as const;

export type TipoCorreo = (typeof TIPOS)[number];
export type Estado = 'confirmada' | 'modificada' | 'cancelada';

export interface CorreoGenerado {
  correo: Correo;
  etiqueta: Etiqueta;
}

export interface OpcionesCorreo {
  tipo: TipoCorreo;
  /** Dirección del buzón (header To). */
  para: string;
  /** Nombre del dueño del buzón (underName). */
  nombre: string;
  estado?: Estado;
  /** Fecha del correo (por defecto, ahora). */
  fecha?: Date;
  /** Las reservas son para los próximos días a partir de esta fecha (por defecto, la del correo). */
  desde?: Date;
}

/** Proveedores de prueba (correos-reserva.md, "Proveedores de prueba"). */
export const PROVEEDORES = {
  vuelo: {
    proveedor: 'aerolinea-andina',
    nombre: 'Aerolínea Andina',
    remitente: 'reservas@aerolinea-andina.example',
  },
  hotel: {
    proveedor: 'hotel-cordillera',
    nombre: 'Hotel Cordillera',
    remitente: 'reservas@hotel-cordillera.example',
  },
  auto: {
    proveedor: 'rentadora-sur',
    nombre: 'Rentadora Sur',
    remitente: 'reservas@rentadora-sur.example',
  },
} as const;

/** Remitente de viajes que no es un proveedor de prueba (nunca está en una whitelist). */
export const REMITENTE_NO_PERMITIDO = 'Viajes Baratos <reservas@viajes-baratos.example>';

// --- Azar repetible -------------------------------------------------------------------------------

export type Azar = () => number;

/** Números al azar entre 0 y 1 a partir de una semilla (mulberry32). */
export function crearAzar(semilla: number): Azar {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const entero = (azar: Azar, min: number, max: number) => min + Math.floor(azar() * (max - min + 1));
function elegir<T>(azar: Azar, lista: readonly T[]): T {
  const elegido = lista[entero(azar, 0, lista.length - 1)];
  if (elegido === undefined) throw new Error('Lista vacía');
  return elegido;
}
const codigo = (azar: Azar, largo: number, letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') =>
  Array.from({ length: largo }, () => elegir(azar, [...letras])).join('');

// --- Fechas con zona horaria ----------------------------------------------------------------------

interface Momento {
  /** ISO 8601 con la zona del lugar, como en el marcado: 2026-12-10T08:30:00-03:00. */
  iso: string;
  /** Como en las plantillas de texto: 2026-12-10 08:30 (-03:00). */
  texto: string;
  ms: number;
}

function minutosDeZona(zona: string): number {
  const signo = zona.startsWith('-') ? -1 : 1;
  const [h = 0, m = 0] = zona.slice(1).split(':').map(Number);
  return signo * (h * 60 + m);
}

/** Momento en `ms` expresado en la zona horaria `zona` (por ejemplo "-03:00"). */
function momento(ms: number, zona: string): Momento {
  const local = new Date(ms + minutosDeZona(zona) * 60_000).toISOString();
  const dia = local.slice(0, 10);
  const hora = local.slice(11, 16);
  return { iso: `${dia}T${hora}:00${zona}`, texto: `${dia} ${hora} (${zona})`, ms };
}

/** Día `dias` después de `desde`, a la hora local `hora:minuto` del lugar. */
function diaYHora(desde: Date, dias: number, hora: number, minuto: number, zona: string): Momento {
  const base = new Date(desde.getTime() + dias * 86_400_000);
  const medianoche = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
  return momento(medianoche + (hora * 60 + minuto - minutosDeZona(zona)) * 60_000, zona);
}

// --- Datos de prueba ------------------------------------------------------------------------------

const AEROPUERTOS = [
  { iata: 'EZE', nombre: 'Aeropuerto Internacional Ministro Pistarini', zona: '-03:00' },
  { iata: 'AEP', nombre: 'Aeroparque Jorge Newbery', zona: '-03:00' },
  { iata: 'COR', nombre: 'Aeropuerto Internacional Ingeniero Ambrosio Taravella', zona: '-03:00' },
  { iata: 'MDZ', nombre: 'Aeropuerto Internacional El Plumerillo', zona: '-03:00' },
  { iata: 'BRC', nombre: 'Aeropuerto Internacional Teniente Luis Candelaria', zona: '-03:00' },
  { iata: 'SCL', nombre: 'Aeropuerto Internacional Arturo Merino Benítez', zona: '-03:00' },
  { iata: 'GRU', nombre: 'Aeropuerto Internacional de Guarulhos', zona: '-03:00' },
  { iata: 'MVD', nombre: 'Aeropuerto Internacional de Carrasco', zona: '-03:00' },
  { iata: 'LIM', nombre: 'Aeropuerto Internacional Jorge Chávez', zona: '-05:00' },
  { iata: 'BOG', nombre: 'Aeropuerto Internacional El Dorado', zona: '-05:00' },
  { iata: 'MAD', nombre: 'Aeropuerto Adolfo Suárez Madrid-Barajas', zona: '+01:00' },
] as const;

const HOTELES = [
  {
    calle: 'Av. Providencia 1234',
    ciudad: 'Santiago',
    region: 'Región Metropolitana',
    postal: '7500000',
    pais: 'CL',
    telefono: '+56 2 2345 6789',
    zona: '-03:00',
  },
  {
    calle: 'Av. San Martín 1520',
    ciudad: 'Mendoza',
    region: 'Mendoza',
    postal: '5500',
    pais: 'AR',
    telefono: '+54 261 425 1100',
    zona: '-03:00',
  },
  {
    calle: 'Av. Exequiel Bustillo 9500',
    ciudad: 'San Carlos de Bariloche',
    region: 'Río Negro',
    postal: '8400',
    pais: 'AR',
    telefono: '+54 294 452 3300',
    zona: '-03:00',
  },
  {
    calle: 'Av. José Larco 812',
    ciudad: 'Lima',
    region: 'Lima',
    postal: '15074',
    pais: 'PE',
    telefono: '+51 1 610 4000',
    zona: '-05:00',
  },
] as const;

const SUCURSALES = [
  {
    nombre: 'Rentadora Sur Aeropuerto SCL',
    calle: 'Armando Cortínez Oriente 1704',
    ciudad: 'Pudahuel',
    region: 'Región Metropolitana',
    postal: '9020000',
    pais: 'CL',
    zona: '-03:00',
  },
  {
    nombre: 'Rentadora Sur Centro Mendoza',
    calle: 'Av. Las Heras 350',
    ciudad: 'Mendoza',
    region: 'Mendoza',
    postal: '5500',
    pais: 'AR',
    zona: '-03:00',
  },
  {
    nombre: 'Rentadora Sur Aeropuerto BRC',
    calle: 'Ruta Nacional 40 km 2020',
    ciudad: 'San Carlos de Bariloche',
    region: 'Río Negro',
    postal: '8400',
    pais: 'AR',
    zona: '-03:00',
  },
] as const;

const VEHICULOS = [
  { categoria: 'Económico', marca: 'Toyota', modelo: 'Yaris' },
  { categoria: 'Compacto', marca: 'Volkswagen', modelo: 'Gol' },
  { categoria: 'Intermedio', marca: 'Chevrolet', modelo: 'Onix' },
  { categoria: 'SUV', marca: 'Jeep', modelo: 'Renegade' },
] as const;

/** Correos que no son de viaje. Uno es de la aerolínea (una promoción, no una reserva). */
const NO_VIAJE = [
  {
    de: 'Aerolínea Andina <novedades@aerolinea-andina.example>',
    asunto: 'Ofertas de la semana: volá a Mendoza',
    texto: 'Esta semana, pasajes a Mendoza desde $45.000. Comprá antes del domingo.',
    html: true,
  },
  {
    de: 'Diario del Sur <noticias@diario-del-sur.example>',
    asunto: 'Las noticias de hoy',
    texto: 'Lo más leído del día: el clima del fin de semana y los resultados del torneo.',
    html: true,
  },
  {
    de: 'Telefonía Austral <facturacion@telefonia-austral.example>',
    asunto: 'Tu factura de noviembre',
    texto: 'Tu factura de noviembre ya está disponible. Total a pagar: $18.250. Vence el 10/12.',
    html: false,
  },
  {
    de: 'Tienda Online <avisos@tienda-online.example>',
    asunto: 'Tu pedido 48213 fue enviado',
    texto: 'Tu pedido 48213 está en camino. Llega entre el martes y el jueves.',
    html: true,
  },
  {
    de: 'Pablo Ríos <pablo.rios@correo.example>',
    asunto: '¿Nos vemos el sábado?',
    texto: 'Hola, ¿te parece si nos juntamos el sábado a la tarde? Avisame.',
    html: false,
  },
] as const;

// --- Marcado y textos ----------------------------------------------------------------------------

/**
 * Estado en el marcado. Alterna los nombres de los ejemplos de Google y los de schema.org, que el
 * procesador tiene que aceptar (correos-reserva.md, "Diferencias entre Google y schema.org").
 */
function marcadoEstado(azar: Azar, estado: Estado) {
  const google = azar() < 0.5;
  const contexto = google ? 'http://schema.org' : 'https://schema.org';
  if (estado === 'cancelada') {
    return {
      contexto,
      status: google ? 'http://schema.org/Cancelled' : 'https://schema.org/ReservationCancelled',
    };
  }
  return {
    contexto,
    status: google ? 'http://schema.org/Confirmed' : 'https://schema.org/ReservationConfirmed',
  };
}

const ASUNTO: Record<Estado, string> = {
  confirmada: 'Confirmación de tu reserva',
  modificada: 'Cambios en tu reserva',
  cancelada: 'Cancelación de tu reserva',
};

const PALABRA: Record<Estado, string> = {
  confirmada: 'está confirmada',
  modificada: 'fue modificada',
  cancelada: 'fue cancelada',
};

const escapar = (texto: string) =>
  texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function html(marcado: object | undefined, parrafos: string[]): string {
  const script = marcado
    ? `<head><script type="application/ld+json">${JSON.stringify(marcado, null, 2)}</script></head>`
    : '<head></head>';
  const cuerpo = parrafos.map((p) => `<p>${escapar(p)}</p>`).join('');
  return `<html>${script}<body>${cuerpo}</body></html>`;
}

interface Reserva {
  marcado: Record<string, unknown>;
  asunto: string;
  parrafos: string[];
  /** Plantilla fija de correos-reserva.md, sección 4. */
  plantilla: string;
  numeroReserva: string;
}

function vuelo(azar: Azar, nombre: string, estado: Estado, desde: Date): Reserva {
  const origen = elegir(azar, AEROPUERTOS);
  const destino = elegir(
    azar,
    AEROPUERTOS.filter((a) => a.iata !== origen.iata),
  );
  const numeroReserva = codigo(azar, 6);
  const numeroVuelo = String(entero(azar, 100, 9999));
  const salida = diaYHora(
    desde,
    entero(azar, 3, 120),
    entero(azar, 6, 21),
    elegir(azar, [0, 15, 30, 45]),
    origen.zona,
  );
  const llegada = momento(salida.ms + entero(azar, 6, 36) * 10 * 60_000, destino.zona);
  const { contexto, status } = marcadoEstado(azar, estado);
  const aeropuerto = (a: (typeof AEROPUERTOS)[number]) => ({
    '@type': 'Airport',
    name: a.nombre,
    iataCode: a.iata,
  });
  return {
    numeroReserva,
    asunto: `${ASUNTO[estado]} ${numeroReserva}`,
    marcado: {
      '@context': contexto,
      '@type': 'FlightReservation',
      reservationNumber: numeroReserva,
      reservationStatus: status,
      underName: { '@type': 'Person', name: nombre },
      reservationFor: {
        '@type': 'Flight',
        flightNumber: numeroVuelo,
        airline: { '@type': 'Airline', name: 'Aerolínea Andina', iataCode: 'AN' },
        departureAirport: aeropuerto(origen),
        departureTime: salida.iso,
        arrivalAirport: aeropuerto(destino),
        arrivalTime: llegada.iso,
      },
      airplaneSeat: `${entero(azar, 1, 32)}${elegir(azar, ['A', 'B', 'C', 'D', 'E', 'F'])}`,
      ...(estado === 'modificada' ? { modifiedTime: desde.toISOString() } : {}),
    },
    parrafos: [
      `Hola ${nombre}, tu reserva ${numeroReserva} ${PALABRA[estado]}.`,
      `Vuelo AN ${numeroVuelo}, ${origen.iata} a ${destino.iata}, salida ${salida.texto}.`,
    ],
    plantilla: [
      'Aerolínea Andina - Confirmación de reserva',
      `Código de reserva: ${numeroReserva}`,
      `Vuelo: AN ${numeroVuelo}`,
      `Salida: ${origen.iata} ${salida.texto}`,
      `Llegada: ${destino.iata} ${llegada.texto}`,
    ].join('\n'),
  };
}

function hotel(azar: Azar, nombre: string, estado: Estado, desde: Date): Reserva {
  const sede = elegir(azar, HOTELES);
  const numeroReserva = `HC-${entero(azar, 10000, 99999)}`;
  const dias = entero(azar, 3, 120);
  const entrada = diaYHora(desde, dias, 15, 0, sede.zona);
  const salida = diaYHora(desde, dias + entero(azar, 1, 10), 11, 0, sede.zona);
  const { contexto, status } = marcadoEstado(azar, estado);
  return {
    numeroReserva,
    asunto: `${ASUNTO[estado]} ${numeroReserva} en Hotel Cordillera`,
    marcado: {
      '@context': contexto,
      '@type': 'LodgingReservation',
      reservationNumber: numeroReserva,
      reservationStatus: status,
      underName: { '@type': 'Person', name: nombre },
      reservationFor: {
        '@type': 'LodgingBusiness',
        name: 'Hotel Cordillera',
        address: {
          '@type': 'PostalAddress',
          streetAddress: sede.calle,
          addressLocality: sede.ciudad,
          addressRegion: sede.region,
          postalCode: sede.postal,
          addressCountry: sede.pais,
        },
        telephone: sede.telefono,
      },
      checkinDate: entrada.iso,
      checkoutDate: salida.iso,
      ...(estado === 'modificada' ? { modifiedTime: desde.toISOString() } : {}),
    },
    parrafos: [
      `Hola ${nombre}, tu reserva ${numeroReserva} en Hotel Cordillera ${PALABRA[estado]}.`,
      `${sede.ciudad}: entrada ${entrada.texto}, salida ${salida.texto}.`,
    ],
    plantilla: [
      'Hotel Cordillera - Confirmación de reserva',
      `Número de reserva: ${numeroReserva}`,
      `Ciudad: ${sede.ciudad}`,
      `Entrada: ${entrada.texto}`,
      `Salida: ${salida.texto}`,
    ].join('\n'),
  };
}

function auto(azar: Azar, nombre: string, estado: Estado, desde: Date): Reserva {
  const retiro = elegir(azar, SUCURSALES);
  const devolucion = azar() < 0.7 ? retiro : elegir(azar, SUCURSALES);
  const vehiculo = elegir(azar, VEHICULOS);
  const numeroReserva = `RS-${entero(azar, 10000, 99999)}`;
  const dias = entero(azar, 3, 120);
  const desdeHora = diaYHora(desde, dias, entero(azar, 8, 18), elegir(azar, [0, 30]), retiro.zona);
  const hastaHora = diaYHora(
    desde,
    dias + entero(azar, 1, 10),
    entero(azar, 8, 18),
    elegir(azar, [0, 30]),
    devolucion.zona,
  );
  const { contexto, status } = marcadoEstado(azar, estado);
  const lugar = (s: (typeof SUCURSALES)[number]) => ({
    '@type': 'Place',
    name: s.nombre,
    address: {
      '@type': 'PostalAddress',
      streetAddress: s.calle,
      addressLocality: s.ciudad,
      addressRegion: s.region,
      postalCode: s.postal,
      addressCountry: s.pais,
    },
  });
  return {
    numeroReserva,
    asunto: `${ASUNTO[estado]} de auto ${numeroReserva}`,
    marcado: {
      '@context': contexto,
      '@type': 'RentalCarReservation',
      reservationNumber: numeroReserva,
      reservationStatus: status,
      underName: { '@type': 'Person', name: nombre },
      reservationFor: {
        '@type': 'RentalCar',
        name: vehiculo.categoria,
        model: vehiculo.modelo,
        brand: { '@type': 'Brand', name: vehiculo.marca },
        rentalCompany: { '@type': 'Organization', name: 'Rentadora Sur' },
      },
      pickupLocation: lugar(retiro),
      pickupTime: desdeHora.iso,
      potentialAction: {
        '@type': 'ConfirmAction',
        target: `https://rentadora-sur.example/confirmar?reserva=${numeroReserva}`,
      },
      dropoffLocation: lugar(devolucion),
      dropoffTime: hastaHora.iso,
      ...(estado === 'modificada' ? { modifiedTime: desde.toISOString() } : {}),
    },
    parrafos: [
      `Hola ${nombre}, tu reserva ${numeroReserva} ${PALABRA[estado]}.`,
      `${vehiculo.marca} ${vehiculo.modelo} (${vehiculo.categoria}). Retiro en ${retiro.nombre}, ${desdeHora.texto}.`,
    ],
    plantilla: [
      'Rentadora Sur - Confirmación de reserva',
      `Número de reserva: ${numeroReserva}`,
      `Retiro: ${retiro.nombre} ${desdeHora.texto}`,
      `Devolución: ${devolucion.nombre} ${hastaHora.texto}`,
      `Vehículo: ${vehiculo.marca} ${vehiculo.modelo} (${vehiculo.categoria})`,
    ].join('\n'),
  };
}

const ARMAR = { vuelo, hotel, auto } as const;
const TIPO_RESERVA = { vuelo: 'vuelo', hotel: 'hotel', auto: 'auto' } as const;

// --- Generador -----------------------------------------------------------------------------------

/** Un correo del tipo pedido. */
export function generarCorreo(azar: Azar, opciones: OpcionesCorreo): CorreoGenerado {
  const { tipo, para, nombre, estado = 'confirmada' } = opciones;
  const fecha = opciones.fecha ?? new Date();
  const desde = opciones.desde ?? fecha;

  if (tipo === 'no-viaje') {
    const plantilla = elegir(azar, NO_VIAJE);
    const texto = `Hola ${nombre}. ${plantilla.texto}`;
    return {
      correo: {
        de: plantilla.de,
        para,
        asunto: plantilla.asunto,
        fecha,
        texto,
        ...(plantilla.html ? { html: html(undefined, [texto]) } : {}),
      },
      etiqueta: { tipo },
    };
  }

  if (tipo === 'remitente-no-permitido') {
    // Un correo de viaje con marcado válido, pero de un remitente que no es un proveedor de prueba.
    const reserva = vuelo(azar, nombre, estado, desde);
    return {
      correo: {
        de: REMITENTE_NO_PERMITIDO,
        para,
        asunto: reserva.asunto,
        fecha,
        texto: reserva.parrafos.join('\n'),
        html: html(reserva.marcado, reserva.parrafos),
      },
      etiqueta: { tipo },
    };
  }

  const clase = tipo.replace('-sin-marcado', '') as keyof typeof ARMAR;
  const reserva = ARMAR[clase](azar, nombre, estado, desde);
  const proveedor = PROVEEDORES[clase];
  const sinMarcado = tipo.endsWith('-sin-marcado');
  return {
    correo: {
      de: `${proveedor.nombre} <${proveedor.remitente}>`,
      para,
      asunto: reserva.asunto,
      fecha,
      // Sin marcado: solo texto, con la plantilla fija que reconocen las reglas de texto.
      texto: sinMarcado ? reserva.plantilla : reserva.parrafos.join('\n'),
      ...(sinMarcado ? {} : { html: html(reserva.marcado, reserva.parrafos) }),
    },
    etiqueta: {
      tipo,
      reserva: {
        tipoReserva: TIPO_RESERVA[clase],
        proveedor: proveedor.proveedor,
        numeroReserva: reserva.numeroReserva,
        estado,
      },
    },
  };
}

/** Proporción de cada tipo en un lote (suma 100). */
const MEZCLA: [TipoCorreo, number][] = [
  ['vuelo', 20],
  ['hotel', 15],
  ['auto', 10],
  ['vuelo-sin-marcado', 5],
  ['hotel-sin-marcado', 5],
  ['auto-sin-marcado', 5],
  ['no-viaje', 30],
  ['remitente-no-permitido', 10],
];

export interface OpcionesLote {
  cantidad: number;
  para: string;
  nombre: string;
  semilla: number;
  /** Fecha del último correo; los anteriores, un minuto antes cada uno. */
  hasta?: Date;
}

/** Un lote mezclado de correos (por ejemplo, los 1.000 de la prueba de P2.B6). */
export function generarLote({ cantidad, para, nombre, semilla, hasta = new Date() }: OpcionesLote) {
  const azar = crearAzar(semilla);
  return Array.from({ length: cantidad }, (_, i) => {
    let suerte = azar() * 100;
    let tipo: TipoCorreo = 'no-viaje';
    for (const [t, peso] of MEZCLA) {
      if (suerte < peso) {
        tipo = t;
        break;
      }
      suerte -= peso;
    }
    const fecha = new Date(hasta.getTime() - (cantidad - 1 - i) * 60_000);
    return generarCorreo(azar, { tipo, para, nombre, fecha });
  });
}
