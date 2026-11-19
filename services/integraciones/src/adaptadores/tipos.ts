/** Modo de obtención de cambios de un proveedor de viaje (Iteración 3, ADR-003). */
export type ModoProveedor = 'aviso' | 'consulta';

export type EstadoReservaTraducido = 'confirmada' | 'modificada' | 'cancelada';

/** Carga útil del evento ReservaActualizada (specs/schemas/ReservaActualizada.json). */
export interface CambiosReserva {
  inicio?: string;
  fin?: string;
  origen?: string;
  destino?: string;
  detalle?: Record<string, unknown>;
}

export interface DatosReservaActualizada {
  proveedor: string;
  numeroReserva: string;
  estado: EstadoReservaTraducido;
  cambios: CambiosReserva;
  origenCambio: 'proveedor';
}

/** Estado conocido de una reserva en su proveedor para calcular diffs en consultas sucesivas. */
export interface EstadoReservaProveedor {
  estado: EstadoReservaTraducido;
  inicio?: string;
  fin?: string;
  origen?: string;
  destino?: string;
  detalle: Record<string, unknown>;
  versionCambio: string;
}

export interface OpcionReprogramacion {
  opcionId: string;
  venceEn: string;
  costo: {
    monto: string;
    moneda: string;
  };
  inicio: string;
  fin: string;
  origen?: string;
  destino?: string;
  detalle?: {
    numeroVuelo?: string;
  };
}

export interface ResultadoAplicarReprogramacion {
  opcionId: string;
  aplicadaEn: string;
}

export type EncabezadosAviso = Record<string, string | string[] | undefined>;

export interface ResultadoAvisoCrudo {
  mensaje: unknown;
}

export interface ResultadoConsultaCruda {
  mensajes: unknown[];
  /** Marca temporal ISO UTC más alta observada en la respuesta, para avanzar el cursor. */
  marcaMasAlta?: string;
}

export type ResultadoTraduccion =
  | {
      ok: true;
      claveVersion: string;
      evento: DatosReservaActualizada;
      estadoActual: EstadoReservaProveedor;
      marcaTemporal?: string;
    }
  | {
      ok: false;
      motivo: string;
      cuerpoSinDatosPersonales: string;
    };

/**
 * Interfaz común de los adaptadores de proveedores de viaje (Iteración 3, ADR-003, QA-10).
 * Cada proveedor externo (aerolínea, hotel, rentadora, y en el futuro trenes o autobuses)
 * implementa esta interfaz sin tocar el resto del servicio.
 */
export interface AdaptadorProveedorViaje {
  readonly nombre: string;
  readonly tipo: string;
  readonly modo: ModoProveedor;
  /** Intervalo configurado para proveedores de consulta (ms). */
  readonly intervaloConsultaMs: number;
  recibirAviso(cuerpo: Buffer | string, headers: EncabezadosAviso): ResultadoAvisoCrudo;
  consultarCambios(desde: string): Promise<ResultadoConsultaCruda>;
  traducir(mensaje: unknown, estadoPrevio?: EstadoReservaProveedor): ResultadoTraduccion;
  pedirOpcionesReprogramacion(numeroReserva: string): Promise<OpcionReprogramacion[]>;
  aplicarReprogramacion(
    numeroReserva: string,
    opcionId: string,
  ): Promise<ResultadoAplicarReprogramacion>;
}

/** Error de firma HMAC ausente, malformada, vencida o inválida en un webhook (401). */
export class ErrorFirmaInvalida extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorFirmaInvalida';
  }
}

/** Error cuando un webhook con firma válida trae cuerpo que no es JSON (400 + no_traducidos). */
export class ErrorCuerpoNoJson extends Error {
  readonly tamanoBytes: number;
  constructor(tamanoBytes: number, mensaje = 'El cuerpo del aviso no es JSON válido.') {
    super(mensaje);
    this.name = 'ErrorCuerpoNoJson';
    this.tamanoBytes = tamanoBytes;
  }
}

/** Error cuando se invoca una operación que el modo o tipo de proveedor no soporta. */
export class ErrorModoNoSoportado extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorModoNoSoportado';
  }
}

/** Error HTTP o de red al comunicarse con un proveedor externo (404, 422, 502, 503). */
export class ErrorProveedorExterno extends Error {
  readonly status: 404 | 422 | 502 | 503;
  readonly codigo: string;
  constructor(status: 404 | 422 | 502 | 503, codigo: string, mensaje: string, causa?: unknown) {
    super(mensaje, causa !== undefined ? { cause: causa } : undefined);
    this.name = 'ErrorProveedorExterno';
    this.status = status;
    this.codigo = codigo;
  }
}

const ISO_FECHA_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Verifica que un valor sea un string ISO 8601 con fecha, hora y zona horaria válidas. */
export function esFechaIsoValida(valor: unknown): valor is string {
  return (
    typeof valor === 'string' && ISO_FECHA_HORA.test(valor) && Number.isFinite(Date.parse(valor))
  );
}

export function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

export function esCadenaNoVacia(valor: unknown): valor is string {
  return typeof valor === 'string' && valor.trim().length > 0;
}

export function esEnteroPositivo(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isInteger(valor) && valor >= 1;
}

/** Busca un encabezado sin distinguir mayúsculas ni minúsculas. */
export function leerEncabezado(headers: EncabezadosAviso, nombre: string): string | undefined {
  const objetivo = nombre.toLowerCase();
  for (const [clave, valor] of Object.entries(headers)) {
    if (clave.toLowerCase() !== objetivo) continue;
    if (Array.isArray(valor)) return valor[0];
    return valor;
  }
  return undefined;
}

/** Compara dos fechas ISO y devuelve la más reciente (o la única válida). */
export function fechaMasReciente(
  actual: string | undefined,
  candidata: unknown,
): string | undefined {
  if (!esFechaIsoValida(candidata)) return actual;
  if (!actual) return candidata;
  return Date.parse(candidata) > Date.parse(actual) ? candidata : actual;
}

const CLAVES_PERSONALES = new Set([
  'given_name',
  'family_name',
  'firstname',
  'lastname',
  'first_name',
  'last_name',
  'fullname',
  'full_name',
  'email',
  'emailaddress',
  'email_address',
  'correo',
  'phone',
  'phonenumber',
  'phone_number',
  'telefono',
  'mobile',
  'passport',
  'document',
  'dni',
  'born_on',
  'birthdate',
  'birth_date',
]);

const CONTENEDORES_PERSONA = new Set([
  'passengers',
  'passenger',
  'guest',
  'guests',
  'driver',
  'drivers',
]);

function sanitizarValor(valor: unknown, dentroDePersona: boolean): unknown {
  if (valor === null || valor === undefined) return valor;
  if (Array.isArray(valor)) {
    return valor.map((item) => sanitizarValor(item, dentroDePersona));
  }
  if (!esObjeto(valor)) {
    return dentroDePersona ? '[quitado]' : valor;
  }
  const copia: Record<string, unknown> = {};
  for (const [clave, v] of Object.entries(valor)) {
    const claveNorm = clave.toLowerCase();
    if (CONTENEDORES_PERSONA.has(claveNorm)) {
      copia[clave] = sanitizarValor(v, true);
      continue;
    }
    if (CLAVES_PERSONALES.has(claveNorm)) {
      copia[clave] = '[quitado]';
      continue;
    }
    if (dentroDePersona) {
      // Conservamos solo identificadores técnicos (`id`) dentro de objetos de persona.
      if (claveNorm === 'id') {
        copia[clave] = v;
      } else if (esObjeto(v) || Array.isArray(v)) {
        copia[clave] = sanitizarValor(v, true);
      } else {
        copia[clave] = '[quitado]';
      }
      continue;
    }
    copia[clave] = sanitizarValor(v, false);
  }
  return copia;
}

/**
 * Quita datos personales de un mensaje antes de guardarlo en `no_traducidos` (QA-6,
 * specs/openapi/integraciones.yaml): nombres de pasajeros, huéspedes y conductores, emails y
 * teléfonos quedan reemplazados por `"[quitado]"`.
 */
export function serializarSinDatosPersonales(mensaje: unknown): string {
  try {
    return JSON.stringify(sanitizarValor(mensaje, false));
  } catch {
    return '[mensaje no serializable]';
  }
}

/** Ejecuta una llamada HTTP con timeout y traduce errores de red/timeout a ErrorProveedorExterno. */
export async function llamarProveedorHttp(
  hacerFetch: typeof fetch,
  url: string,
  init: RequestInit,
  tiempoMaximoMs: number,
  nombreProveedor: string,
): Promise<Response> {
  try {
    return await hacerFetch(url, {
      ...init,
      signal: AbortSignal.timeout(tiempoMaximoMs),
    });
  } catch (error) {
    throw new ErrorProveedorExterno(
      503,
      'proveedor-no-disponible',
      `El proveedor ${nombreProveedor} no respondió a tiempo o no está disponible.`,
      error,
    );
  }
}
