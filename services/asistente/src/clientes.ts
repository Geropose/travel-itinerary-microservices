import { crearClienteHttp, ErrorRespuestaHttp } from '@trotamundos/comun';

export type ServicioDependencia = 'viajes' | 'usuarios' | 'integraciones' | 'proveedor' | 'agencia';

/** Error lanzado cuando una dependencia no responde a tiempo o responde 5xx (ADR-019). */
export class ErrorDependenciaNoDisponible extends Error {
  readonly servicio: ServicioDependencia;
  constructor(servicio: ServicioDependencia, mensaje: string, causa?: unknown) {
    super(mensaje, causa !== undefined ? { cause: causa } : undefined);
    this.name = 'ErrorDependenciaNoDisponible';
    this.servicio = servicio;
  }
}

/** Error lanzado cuando Integraciones devuelve 409 (opción vencida o no disponible). */
export class ErrorOpcionRechazada extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorOpcionRechazada';
  }
}

export interface ReservaDeViajes {
  reservaId: string;
  proveedor: string;
  numeroReserva: string;
  tipoReserva: 'vuelo' | 'hotel' | 'auto';
  estado: 'confirmada' | 'modificada' | 'cancelada';
  inicio: string;
  fin: string;
  origen?: string;
  destino: string;
}

export interface PerfilDeUsuarios {
  usuarioId: string;
  email: string;
  nombre: string;
  agenciaPreferida: string | null;
}

export interface OpcionDeIntegraciones {
  opcionId: string;
  venceEn: string;
  costo: { monto: string; moneda: string };
  inicio: string;
  fin: string;
  origen?: string;
  destino?: string;
  detalle?: { numeroVuelo?: string };
}

export interface CasoDeIntegraciones {
  agencia: string;
  numeroCaso: string;
  creadoEn: string;
}

export interface ResultadoAplicarIntegraciones {
  proveedor: string;
  numeroReserva: string;
  opcionId: string;
  estado: 'aplicada';
  aplicadaEn: string;
}

export interface ClienteViajes {
  listarReservas(usuarioId: string, token: string): Promise<ReservaDeViajes[]>;
}

export interface ClienteUsuarios {
  obtenerPerfil(token: string): Promise<PerfilDeUsuarios>;
}

export interface ClienteIntegraciones {
  pedirOpcionesReprogramacion(
    proveedor: string,
    numeroReserva: string,
    token: string,
  ): Promise<OpcionDeIntegraciones[]>;
  aplicarReprogramacion(
    proveedor: string,
    numeroReserva: string,
    opcionId: string,
    token: string,
  ): Promise<ResultadoAplicarIntegraciones>;
  crearCasoAgencia(
    datos: {
      agencia: string;
      usuarioId: string;
      resumen: string;
      contacto?: { nombre: string; email: string };
      conversacion: Array<{ autor: 'usuario' | 'asistente'; texto: string; enviadoEn: string }>;
    },
    token: string,
  ): Promise<CasoDeIntegraciones>;
}

export interface ClientesAsistente {
  viajes: ClienteViajes;
  usuarios: ClienteUsuarios;
  integraciones: ClienteIntegraciones;
}

export interface OpcionesClientesAsistente {
  urlViajes: string;
  urlUsuarios: string;
  urlIntegraciones: string;
  timeoutServiciosMs?: number;
  timeoutProveedorMs?: number;
  fetch?: typeof fetch;
}

function extraerTipoProblema(cuerpo: unknown): string | undefined {
  if (typeof cuerpo !== 'object' || cuerpo === null) return undefined;
  const tipo = (cuerpo as { type?: unknown }).type;
  return typeof tipo === 'string' ? tipo : undefined;
}

function clasificarErrorIntegraciones(
  error: unknown,
  servicioExterno: 'proveedor' | 'agencia',
): ErrorDependenciaNoDisponible {
  if (error instanceof ErrorRespuestaHttp) {
    const tipo = extraerTipoProblema(error.cuerpo) ?? '';
    if (
      tipo.endsWith('/tercero-no-disponible') ||
      tipo.endsWith('/error-tercero') ||
      error.status === 502
    ) {
      return new ErrorDependenciaNoDisponible(servicioExterno, error.message, error);
    }
    return new ErrorDependenciaNoDisponible('integraciones', error.message, error);
  }
  return new ErrorDependenciaNoDisponible(
    'integraciones',
    'El Servicio de Integraciones no respondió a tiempo.',
    error,
  );
}

/**
 * Crea los clientes HTTP hacia Viajes, Usuarios e Integraciones propagando el JWT del usuario en
 * cada llamada (QA-9) y traduciendo fallas/timeouts a `ErrorDependenciaNoDisponible` (ADR-019).
 */
export function crearClientesAsistente(opciones: OpcionesClientesAsistente): ClientesAsistente {
  const timeoutServiciosMs = opciones.timeoutServiciosMs ?? 2000;
  const timeoutProveedorMs = opciones.timeoutProveedorMs ?? 15_000;

  const httpViajes = crearClienteHttp({
    urlBase: opciones.urlViajes,
    tiempoMaximoMs: timeoutServiciosMs,
    ...(opciones.fetch ? { fetch: opciones.fetch } : {}),
  });
  const httpUsuarios = crearClienteHttp({
    urlBase: opciones.urlUsuarios,
    tiempoMaximoMs: timeoutServiciosMs,
    ...(opciones.fetch ? { fetch: opciones.fetch } : {}),
  });
  const httpIntegraciones = crearClienteHttp({
    urlBase: opciones.urlIntegraciones,
    tiempoMaximoMs: timeoutServiciosMs,
    ...(opciones.fetch ? { fetch: opciones.fetch } : {}),
  });
  // Para reprogramaciones permitimos esperar más que el umbral de 3 s en segundo plano (P2.D5).
  const httpIntegracionesProveedor = crearClienteHttp({
    urlBase: opciones.urlIntegraciones,
    tiempoMaximoMs: timeoutProveedorMs,
    ...(opciones.fetch ? { fetch: opciones.fetch } : {}),
  });

  return {
    viajes: {
      async listarReservas(usuarioId, token) {
        try {
          const { datos } = await httpViajes.get<{ reservas: ReservaDeViajes[] }>(
            '/interna/reservas',
            { query: { usuarioId }, token },
          );
          return datos.reservas;
        } catch (error) {
          throw new ErrorDependenciaNoDisponible(
            'viajes',
            'El Servicio de Viajes no respondió a tiempo.',
            error,
          );
        }
      },
    },

    usuarios: {
      async obtenerPerfil(token) {
        try {
          const { datos } = await httpUsuarios.get<PerfilDeUsuarios>('/perfil', { token });
          return datos;
        } catch (error) {
          throw new ErrorDependenciaNoDisponible(
            'usuarios',
            'El Servicio de Usuarios no respondió a tiempo.',
            error,
          );
        }
      },
    },

    integraciones: {
      async pedirOpcionesReprogramacion(proveedor, numeroReserva, token) {
        try {
          const { datos } = await httpIntegracionesProveedor.post<{
            opciones: OpcionDeIntegraciones[];
          }>('/interna/reprogramaciones/opciones', { proveedor, numeroReserva }, { token });
          return datos.opciones;
        } catch (error) {
          if (error instanceof ErrorRespuestaHttp && error.status === 404) {
            return [];
          }
          throw clasificarErrorIntegraciones(error, 'proveedor');
        }
      },

      async aplicarReprogramacion(proveedor, numeroReserva, opcionId, token) {
        try {
          const { datos } = await httpIntegracionesProveedor.post<ResultadoAplicarIntegraciones>(
            '/interna/reprogramaciones/aplicar',
            { proveedor, numeroReserva, opcionId },
            { token },
          );
          return datos;
        } catch (error) {
          if (
            error instanceof ErrorRespuestaHttp &&
            (error.status === 409 || error.status === 404)
          ) {
            throw new ErrorOpcionRechazada(error.message);
          }
          throw clasificarErrorIntegraciones(error, 'proveedor');
        }
      },

      async crearCasoAgencia(datos, token) {
        try {
          const { datos: caso } = await httpIntegraciones.post<CasoDeIntegraciones>(
            '/interna/agencias/casos',
            datos,
            { token },
          );
          return caso;
        } catch (error) {
          throw clasificarErrorIntegraciones(error, 'agencia');
        }
      },
    },
  };
}
