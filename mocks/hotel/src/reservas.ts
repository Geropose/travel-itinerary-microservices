// Almacén en memoria de reservas hoteleras para Hotel Cordillera (specs/externos/hotel.md).
import { cargarSemillasProveedores, type SemillaHotel } from '@trotamundos/mocks-comun';

export type EstadoHotel = 'confirmed' | 'modified' | 'cancelled';

export interface ReservaHotel {
  reservationId: string;
  status: EstadoHotel;
  revision: number;
  createdAt: string;
  lastModified: string;
  hotel: {
    code: string;
    name: string;
    address: string;
    city: string;
    countryCode: string;
  };
  guest: { firstName: string; lastName: string };
  checkIn: string;
  checkOut: string;
  room: { type: string; description: string; guests: number };
}

export interface CambioReservaHotel {
  checkIn?: string;
  checkOut?: string;
  roomDescription?: string;
  roomType?: string;
  guests?: number;
  hotelName?: string;
  city?: string;
}

interface CursorHotel {
  lm: string;
  id: string;
}

export function codificarCursor(cursor: CursorHotel): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodificarCursor(texto: string): CursorHotel | undefined {
  try {
    const parsed = JSON.parse(
      Buffer.from(texto, 'base64url').toString('utf8'),
    ) as Partial<CursorHotel>;
    if (typeof parsed.lm === 'string' && typeof parsed.id === 'string') {
      return { lm: parsed.lm, id: parsed.id };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function clonar(r: ReservaHotel): ReservaHotel {
  return {
    ...r,
    hotel: { ...r.hotel },
    guest: { ...r.guest },
    room: { ...r.room },
  };
}

function estadoDesdeSemilla(e: SemillaHotel['estado']): EstadoHotel {
  if (e === 'cancelada') return 'cancelled';
  if (e === 'modificada') return 'modified';
  return 'confirmed';
}

function compararOrden(
  a: { lastModified: string; reservationId: string },
  b: { lastModified: string; reservationId: string },
): number {
  const diff = Date.parse(a.lastModified) - Date.parse(b.lastModified);
  if (diff !== 0) return diff;
  return a.reservationId.localeCompare(b.reservationId);
}

export interface AlmacenHotel {
  cargarSemillas(ahora?: Date): void;
  limpiar(): void;
  listarTodas(): ReservaHotel[];
  buscar(reservationId: string): ReservaHotel | undefined;
  consultarModificadas(params: { modifiedSince: string; limit: number; cursor?: CursorHotel }): {
    reservations: ReservaHotel[];
    nextCursor: string | null;
  };
  guardar(reserva: ReservaHotel): ReservaHotel;
  cambiar(reservationId: string, cambios: CambioReservaHotel): ReservaHotel | undefined;
  cancelar(reservationId: string): ReservaHotel | undefined;
  tormenta(cantidad: number): ReservaHotel[];
}

export function crearAlmacenHotel(reloj: () => number = Date.now): AlmacenHotel {
  const reservas = new Map<string, ReservaHotel>();
  let seqTormenta = 1;

  function desdeSemilla(s: SemillaHotel): ReservaHotel {
    return {
      reservationId: s.reservationId,
      status: estadoDesdeSemilla(s.estado),
      revision: 1,
      createdAt: s.creadaEn,
      lastModified: s.creadaEn,
      hotel: {
        code: s.codigoHotel,
        name: s.nombreHotel,
        address: s.direccion,
        city: s.ciudad,
        countryCode: s.pais,
      },
      guest: { firstName: s.huespedNombre, lastName: s.huespedApellido },
      checkIn: s.checkIn,
      checkOut: s.checkOut,
      room: {
        type: s.tipoHabitacion,
        description: s.descripcionHabitacion,
        guests: s.huespedes,
      },
    };
  }

  return {
    cargarSemillas(ahora = new Date(reloj())) {
      const { hoteles } = cargarSemillasProveedores(ahora);
      for (const h of hoteles) reservas.set(h.reservationId, desdeSemilla(h));
    },

    limpiar() {
      reservas.clear();
    },

    listarTodas() {
      return [...reservas.values()].sort(compararOrden).map(clonar);
    },

    buscar(reservationId) {
      const r = reservas.get(reservationId);
      return r ? clonar(r) : undefined;
    },

    consultarModificadas({ modifiedSince, limit, cursor }) {
      const desdeMs = Date.parse(modifiedSince);
      const filtradas = [...reservas.values()]
        .filter((r) => Date.parse(r.lastModified) >= desdeMs)
        .sort(compararOrden)
        .filter((r) => {
          if (!cursor) return true;
          return compararOrden(r, { lastModified: cursor.lm, reservationId: cursor.id }) > 0;
        });

      const pagina = filtradas.slice(0, limit).map(clonar);
      const ultima = pagina.at(-1);
      const hayMas = filtradas.length > limit;
      return {
        reservations: pagina,
        nextCursor:
          hayMas && ultima
            ? codificarCursor({ lm: ultima.lastModified, id: ultima.reservationId })
            : null,
      };
    },

    guardar(reserva) {
      const copia = clonar(reserva);
      reservas.set(copia.reservationId, copia);
      return clonar(copia);
    },

    cambiar(reservationId, cambios) {
      const actual = reservas.get(reservationId);
      if (!actual) return undefined;
      actual.status = 'modified';
      actual.revision += 1;
      actual.lastModified = new Date(reloj()).toISOString();
      if (cambios.checkIn) actual.checkIn = cambios.checkIn;
      if (cambios.checkOut) actual.checkOut = cambios.checkOut;
      if (cambios.roomDescription) actual.room.description = cambios.roomDescription;
      if (cambios.roomType) actual.room.type = cambios.roomType;
      if (cambios.guests !== undefined) actual.room.guests = cambios.guests;
      if (cambios.hotelName) actual.hotel.name = cambios.hotelName;
      if (cambios.city) actual.hotel.city = cambios.city;
      return clonar(actual);
    },

    cancelar(reservationId) {
      const actual = reservas.get(reservationId);
      if (!actual) return undefined;
      actual.status = 'cancelled';
      actual.revision += 1;
      actual.lastModified = new Date(reloj()).toISOString();
      return clonar(actual);
    },

    tormenta(cantidad) {
      const ahora = new Date(reloj()).toISOString();
      const afectadas: ReservaHotel[] = [];
      for (const r of reservas.values()) {
        if (afectadas.length >= cantidad) break;
        if (r.status === 'cancelled') continue;
        r.status = 'cancelled';
        r.revision += 1;
        r.lastModified = ahora;
        afectadas.push(clonar(r));
      }
      while (afectadas.length < cantidad) {
        const id = `HC-STM${String(seqTormenta++).padStart(5, '0')}`;
        const nueva: ReservaHotel = {
          reservationId: id,
          status: 'cancelled',
          revision: 2,
          createdAt: ahora,
          lastModified: ahora,
          hotel: {
            code: 'HC-SCL-01',
            name: 'Hotel Cordillera',
            address: 'Av. Providencia 1234',
            city: 'Santiago',
            countryCode: 'CL',
          },
          guest: { firstName: 'Huésped', lastName: id },
          checkIn: '2026-12-10T15:00:00-03:00',
          checkOut: '2026-12-14T11:00:00-03:00',
          room: { type: 'DBL', description: 'Doble superior', guests: 2 },
        };
        reservas.set(id, nueva);
        afectadas.push(clonar(nueva));
      }
      return afectadas;
    },
  };
}
