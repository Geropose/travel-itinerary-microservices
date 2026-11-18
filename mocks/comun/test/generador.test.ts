// Correos generados contra specs/externos/correos-reserva.md: campos obligatorios de Google en el
// JSON-LD, plantillas de texto y remitentes de prueba.
import { describe, expect, it } from 'vitest';
import { crearAzar, generarCorreo, generarLote, TIPOS, type TipoCorreo } from '../src/generador.ts';
import { direccion } from '../src/correo.ts';

const desde = new Date('2026-11-28T12:00:00Z');
const correo = (
  tipo: TipoCorreo,
  semilla = 1,
  estado?: 'confirmada' | 'modificada' | 'cancelada',
) =>
  generarCorreo(crearAzar(semilla), {
    tipo,
    para: 'ana.garcia@gmail.example',
    nombre: 'Ana García',
    fecha: desde,
    ...(estado ? { estado } : {}),
  });

function jsonLd(html = ''): Record<string, unknown> {
  const bloque = /<script type="application\/ld\+json">([\s\S]+?)<\/script>/.exec(html);
  return JSON.parse(bloque?.[1] ?? 'null') as Record<string, unknown>;
}

/** Valor de un camino como "reservationFor.airline.iataCode". */
const valor = (objeto: unknown, camino: string): unknown =>
  camino
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], objeto);

const ISO_CON_ZONA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/;

describe('reservas con JSON-LD (campos obligatorios de Google)', () => {
  const OBLIGATORIOS: Record<'vuelo' | 'hotel' | 'auto', string[]> = {
    vuelo: [
      'reservationNumber',
      'reservationStatus',
      'underName.name',
      'reservationFor.flightNumber',
      'reservationFor.airline.name',
      'reservationFor.airline.iataCode',
      'reservationFor.departureAirport.name',
      'reservationFor.departureAirport.iataCode',
      'reservationFor.departureTime',
      'reservationFor.arrivalAirport.name',
      'reservationFor.arrivalAirport.iataCode',
      'reservationFor.arrivalTime',
    ],
    hotel: [
      'reservationNumber',
      'reservationStatus',
      'underName.name',
      'reservationFor.name',
      'reservationFor.address.streetAddress',
      'reservationFor.address.addressLocality',
      'reservationFor.address.addressRegion',
      'reservationFor.address.postalCode',
      'reservationFor.address.addressCountry',
      'reservationFor.telephone',
      'checkinDate',
      'checkoutDate',
    ],
    auto: [
      'reservationNumber',
      'reservationStatus',
      'underName.name',
      'reservationFor.name',
      'reservationFor.model',
      'reservationFor.brand.name',
      'reservationFor.rentalCompany.name',
      'pickupLocation.name',
      'pickupLocation.address.streetAddress',
      'pickupTime',
      'dropoffLocation.name',
      'dropoffLocation.address.streetAddress',
      'dropoffTime',
      'potentialAction.target',
    ],
  };
  const TIPO_LD = {
    vuelo: 'FlightReservation',
    hotel: 'LodgingReservation',
    auto: 'RentalCarReservation',
  };
  const REMITENTE = {
    vuelo: 'reservas@aerolinea-andina.example',
    hotel: 'reservas@hotel-cordillera.example',
    auto: 'reservas@rentadora-sur.example',
  };

  for (const tipo of ['vuelo', 'hotel', 'auto'] as const) {
    it(`${tipo}: ${TIPO_LD[tipo]} con todos los campos, del remitente del proveedor`, () => {
      for (let semilla = 1; semilla <= 30; semilla++) {
        const { correo: c, etiqueta } = correo(tipo, semilla);
        const ld = jsonLd(c.html);
        expect(ld['@type']).toBe(TIPO_LD[tipo]);
        expect(ld['@context']).toMatch(/^https?:\/\/schema\.org$/);
        for (const camino of OBLIGATORIOS[tipo]) expect(valor(ld, camino), camino).toBeTruthy();
        expect(ld.reservationNumber).toBe(etiqueta.reserva?.numeroReserva);
        expect(valor(ld, 'underName.name')).toBe('Ana García');
        expect(direccion(c.de)).toBe(REMITENTE[tipo]);
        expect(etiqueta.reserva?.tipoReserva).toBe(tipo);
      }
    });
  }

  it('vuelo: fechas con zona horaria, la llegada después de la salida y en el futuro', () => {
    for (let semilla = 1; semilla <= 30; semilla++) {
      const ld = jsonLd(correo('vuelo', semilla).correo.html);
      const salida = String(valor(ld, 'reservationFor.departureTime'));
      const llegada = String(valor(ld, 'reservationFor.arrivalTime'));
      expect(salida).toMatch(ISO_CON_ZONA);
      expect(llegada).toMatch(ISO_CON_ZONA);
      expect(Date.parse(llegada)).toBeGreaterThan(Date.parse(salida));
      expect(Date.parse(salida)).toBeGreaterThan(desde.getTime());
      expect(valor(ld, 'reservationFor.departureAirport.iataCode')).not.toBe(
        valor(ld, 'reservationFor.arrivalAirport.iataCode'),
      );
    }
  });

  it('hotel: entrada a las 15:00 y salida a las 11:00 de un día posterior', () => {
    const ld = jsonLd(correo('hotel', 4).correo.html);
    expect(String(ld.checkinDate)).toMatch(/T15:00:00[+-]/);
    expect(String(ld.checkoutDate)).toMatch(/T11:00:00[+-]/);
    expect(Date.parse(String(ld.checkoutDate))).toBeGreaterThan(Date.parse(String(ld.checkinDate)));
  });

  it('estado: Confirmed o ReservationConfirmed; modificada lleva modifiedTime; cancelada, Cancelled', () => {
    const estados = new Set<string>();
    for (let semilla = 1; semilla <= 20; semilla++) {
      const ld = jsonLd(correo('vuelo', semilla).correo.html);
      estados.add(String(ld.reservationStatus));
      expect(ld.modifiedTime).toBeUndefined();
    }
    // Usa los dos nombres que el procesador tiene que aceptar.
    expect([...estados].sort()).toEqual([
      'http://schema.org/Confirmed',
      'https://schema.org/ReservationConfirmed',
    ]);
    expect(jsonLd(correo('hotel', 1, 'modificada').correo.html).modifiedTime).toBe(
      desde.toISOString(),
    );
    expect(String(jsonLd(correo('auto', 1, 'cancelada').correo.html).reservationStatus)).toMatch(
      /Cancelled$/,
    );
  });
});

describe('reservas sin marcado (plantillas de la sección 4)', () => {
  it('vuelo, hotel y auto: solo texto, con la plantilla fija', () => {
    const vuelo = correo('vuelo-sin-marcado');
    expect(vuelo.correo.html).toBeUndefined();
    expect(vuelo.correo.texto).toMatch(
      /^Aerolínea Andina - Confirmación de reserva\nCódigo de reserva: [A-Z0-9]{6}\nVuelo: AN \d+\nSalida: [A-Z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} \([+-]\d{2}:\d{2}\)\nLlegada: [A-Z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} \([+-]\d{2}:\d{2}\)$/,
    );
    expect(vuelo.correo.texto).toContain(
      `Código de reserva: ${vuelo.etiqueta.reserva?.numeroReserva ?? ''}`,
    );
    expect(correo('hotel-sin-marcado').correo.texto).toMatch(
      /^Hotel Cordillera - Confirmación de reserva\nNúmero de reserva: HC-\d{5}\nCiudad: .+\nEntrada: .+\nSalida: .+$/,
    );
    expect(correo('auto-sin-marcado').correo.texto).toMatch(
      /^Rentadora Sur - Confirmación de reserva\nNúmero de reserva: RS-\d{5}\nRetiro: .+\nDevolución: .+\nVehículo: .+ \(.+\)$/,
    );
  });
});

describe('otros correos', () => {
  it('no-viaje: sin marcado ni reserva', () => {
    for (let semilla = 1; semilla <= 20; semilla++) {
      const { correo: c, etiqueta } = correo('no-viaje', semilla);
      expect(jsonLd(c.html)).toBeNull();
      expect(etiqueta).toEqual({ tipo: 'no-viaje' });
    }
  });

  it('remitente-no-permitido: reserva con marcado, de un remitente que no es un proveedor', () => {
    const { correo: c, etiqueta } = correo('remitente-no-permitido');
    expect(jsonLd(c.html)['@type']).toBe('FlightReservation');
    expect(direccion(c.de)).toBe('reservas@viajes-baratos.example');
    expect(etiqueta.reserva).toBeUndefined();
  });
});

describe('generarLote', () => {
  it('con la misma semilla genera los mismos correos', () => {
    const opciones = {
      cantidad: 50,
      para: 'a@gmail.example',
      nombre: 'A',
      semilla: 9,
      hasta: desde,
    };
    expect(generarLote(opciones)).toEqual(generarLote(opciones));
    expect(generarLote({ ...opciones, semilla: 10 })).not.toEqual(generarLote(opciones));
  });

  it('1.000 correos: todos los tipos, unos 55 % de viaje, números de reserva distintos', () => {
    const lote = generarLote({
      cantidad: 1000,
      para: 'a@gmail.example',
      nombre: 'A',
      semilla: 2026,
      hasta: desde,
    });
    const cuenta = new Map<string, number>();
    for (const { etiqueta } of lote)
      cuenta.set(etiqueta.tipo, (cuenta.get(etiqueta.tipo) ?? 0) + 1);
    expect([...cuenta.keys()].sort()).toEqual([...TIPOS].sort());
    const deViaje = lote.filter((g) => g.etiqueta.reserva).length;
    expect(deViaje).toBeGreaterThan(450);
    expect(deViaje).toBeLessThan(650);
    const numeros = lote.flatMap((g) => g.etiqueta.reserva?.numeroReserva ?? []);
    expect(new Set(numeros).size).toBeGreaterThan(numeros.length * 0.99);
    // Uno por minuto hasta la fecha pedida.
    expect(lote.at(-1)?.correo.fecha).toEqual(desde);
    expect(lote[0]?.correo.fecha.getTime()).toBe(desde.getTime() - 999 * 60_000);
  });
});
