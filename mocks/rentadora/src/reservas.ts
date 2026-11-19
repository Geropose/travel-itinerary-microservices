// Almacén en memoria de reservas de vehículos de Rentadora Sur (specs/externos/rentadora.md).
import { cargarSemillasProveedores, type SemillaAuto } from '@trotamundos/mocks-comun';

export type EstadoAuto = 'CONFIRMED' | 'MODIFIED' | 'CANCELLED';

export interface ReservaAuto {
  confirmationNumber: string;
  status: EstadoAuto;
  version: number;
  createdAt: string;
  updatedAt: string;
  driver: { firstName: string; lastName: string };
  vehicle: {
    acrissCode: string;
    categoryName: string;
    make: string;
    model: string;
  };
  pickUp: {
    locationCode: string;
    locationName: string;
    city: string;
    dateTime: string;
  };
  dropOff: {
    locationCode: string;
    locationName: string;
    city: string;
    dateTime: string;
  };
}

export interface CambioReservaAuto {
  pickUpDateTime?: string;
  dropOffDateTime?: string;
  pickUpLocationName?: string;
  dropOffLocationName?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleCategoryName?: string;
  vehicleAcrissCode?: string;
}

function clonar(b: ReservaAuto): ReservaAuto {
  return {
    ...b,
    driver: { ...b.driver },
    vehicle: { ...b.vehicle },
    pickUp: { ...b.pickUp },
    dropOff: { ...b.dropOff },
  };
}

function estadoDesdeSemilla(e: SemillaAuto['estado']): EstadoAuto {
  if (e === 'cancelada') return 'CANCELLED';
  if (e === 'modificada') return 'MODIFIED';
  return 'CONFIRMED';
}

function compararOrden(
  a: { updatedAt: string; confirmationNumber: string },
  b: { updatedAt: string; confirmationNumber: string },
): number {
  const diff = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  if (diff !== 0) return diff;
  return a.confirmationNumber.localeCompare(b.confirmationNumber);
}

export interface AlmacenRentadora {
  cargarSemillas(ahora?: Date): void;
  limpiar(): void;
  listarTodas(): ReservaAuto[];
  buscar(confirmationNumber: string): ReservaAuto | undefined;
  consultarActualizadas(params: { updatedSince: string; page: number; pageSize: number }): {
    bookings: ReservaAuto[];
    page: number;
    pageSize: number;
    totalCount: number;
  };
  guardar(reserva: ReservaAuto): ReservaAuto;
  cambiar(confirmationNumber: string, cambios: CambioReservaAuto): ReservaAuto | undefined;
  cancelar(confirmationNumber: string): ReservaAuto | undefined;
  tormenta(cantidad: number): ReservaAuto[];
}

export function crearAlmacenRentadora(reloj: () => number = Date.now): AlmacenRentadora {
  const reservas = new Map<string, ReservaAuto>();
  let seqTormenta = 1;

  function desdeSemilla(s: SemillaAuto): ReservaAuto {
    return {
      confirmationNumber: s.confirmationNumber,
      status: estadoDesdeSemilla(s.estado),
      version: 1,
      createdAt: s.creadaEn,
      updatedAt: s.creadaEn,
      driver: { firstName: s.conductorNombre, lastName: s.conductorApellido },
      vehicle: {
        acrissCode: s.acrissCode,
        categoryName: s.categoria,
        make: s.marca,
        model: s.modelo,
      },
      pickUp: {
        locationCode: s.retiroCodigo,
        locationName: s.retiroNombre,
        city: s.retiroCiudad,
        dateTime: s.retiroFecha,
      },
      dropOff: {
        locationCode: s.devolucionCodigo,
        locationName: s.devolucionNombre,
        city: s.devolucionCiudad,
        dateTime: s.devolucionFecha,
      },
    };
  }

  return {
    cargarSemillas(ahora = new Date(reloj())) {
      const { autos } = cargarSemillasProveedores(ahora);
      for (const a of autos) reservas.set(a.confirmationNumber, desdeSemilla(a));
    },

    limpiar() {
      reservas.clear();
    },

    listarTodas() {
      return [...reservas.values()].sort(compararOrden).map(clonar);
    },

    buscar(confirmationNumber) {
      const b = reservas.get(confirmationNumber);
      return b ? clonar(b) : undefined;
    },

    consultarActualizadas({ updatedSince, page, pageSize }) {
      const desdeMs = Date.parse(updatedSince);
      const filtradas = [...reservas.values()]
        .filter((b) => Date.parse(b.updatedAt) >= desdeMs)
        .sort(compararOrden);
      const inicio = (page - 1) * pageSize;
      const pagina = filtradas.slice(inicio, inicio + pageSize).map(clonar);
      return {
        bookings: pagina,
        page,
        pageSize,
        totalCount: filtradas.length,
      };
    },

    guardar(reserva) {
      const copia = clonar(reserva);
      reservas.set(copia.confirmationNumber, copia);
      return clonar(copia);
    },

    cambiar(confirmationNumber, cambios) {
      const actual = reservas.get(confirmationNumber);
      if (!actual) return undefined;
      actual.status = 'MODIFIED';
      actual.version += 1;
      actual.updatedAt = new Date(reloj()).toISOString();
      if (cambios.pickUpDateTime) actual.pickUp.dateTime = cambios.pickUpDateTime;
      if (cambios.dropOffDateTime) actual.dropOff.dateTime = cambios.dropOffDateTime;
      if (cambios.pickUpLocationName) actual.pickUp.locationName = cambios.pickUpLocationName;
      if (cambios.dropOffLocationName) actual.dropOff.locationName = cambios.dropOffLocationName;
      if (cambios.vehicleMake) actual.vehicle.make = cambios.vehicleMake;
      if (cambios.vehicleModel) actual.vehicle.model = cambios.vehicleModel;
      if (cambios.vehicleCategoryName) actual.vehicle.categoryName = cambios.vehicleCategoryName;
      if (cambios.vehicleAcrissCode) actual.vehicle.acrissCode = cambios.vehicleAcrissCode;
      return clonar(actual);
    },

    cancelar(confirmationNumber) {
      const actual = reservas.get(confirmationNumber);
      if (!actual) return undefined;
      actual.status = 'CANCELLED';
      actual.version += 1;
      actual.updatedAt = new Date(reloj()).toISOString();
      return clonar(actual);
    },

    tormenta(cantidad) {
      const ahora = new Date(reloj()).toISOString();
      const afectadas: ReservaAuto[] = [];
      for (const b of reservas.values()) {
        if (afectadas.length >= cantidad) break;
        if (b.status === 'CANCELLED') continue;
        b.status = 'CANCELLED';
        b.version += 1;
        b.updatedAt = ahora;
        afectadas.push(clonar(b));
      }
      while (afectadas.length < cantidad) {
        const num = `RS-STM${String(seqTormenta++).padStart(5, '0')}`;
        const nueva: ReservaAuto = {
          confirmationNumber: num,
          status: 'CANCELLED',
          version: 2,
          createdAt: ahora,
          updatedAt: ahora,
          driver: { firstName: 'Conductor', lastName: num },
          vehicle: {
            acrissCode: 'ECMR',
            categoryName: 'Económico',
            make: 'Toyota',
            model: 'Yaris',
          },
          pickUp: {
            locationCode: 'SCLA01',
            locationName: 'Rentadora Sur Aeropuerto SCL',
            city: 'Santiago',
            dateTime: '2026-12-10T11:30:00-03:00',
          },
          dropOff: {
            locationCode: 'SCLA01',
            locationName: 'Rentadora Sur Aeropuerto SCL',
            city: 'Santiago',
            dateTime: '2026-12-14T09:00:00-03:00',
          },
        };
        reservas.set(num, nueva);
        afectadas.push(clonar(nueva));
      }
      return afectadas;
    },
  };
}
