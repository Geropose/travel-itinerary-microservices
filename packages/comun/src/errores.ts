import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler } from 'express';
import { contextoActual } from './contexto.ts';
import type { Logger } from './logger.ts';

const BASE_TIPO = 'https://trotamundos.example/errores/';

export interface ErrorDeCampo {
  campo: string;
  mensaje: string;
}

export interface DatosErrorHttp {
  status: number;
  /** Última parte de la URI del tipo: "no-encontrado" → https://trotamundos.example/errores/no-encontrado */
  tipo: string;
  titulo: string;
  detalle?: string;
  errores?: ErrorDeCampo[];
  /** Encabezados extra de la respuesta (por ejemplo Location en un 307 o Retry-After en un 503). */
  encabezados?: Record<string, string>;
}

/** Error que se responde tal cual en formato application/problem+json (RFC 7807). */
export class ErrorHttp extends Error {
  readonly status: number;
  readonly tipo: string;
  readonly titulo: string;
  readonly detalle: string | undefined;
  readonly errores: ErrorDeCampo[] | undefined;
  readonly encabezados: Record<string, string> | undefined;

  constructor(datos: DatosErrorHttp) {
    super(datos.detalle ?? datos.titulo);
    this.name = 'ErrorHttp';
    this.status = datos.status;
    this.tipo = datos.tipo;
    this.titulo = datos.titulo;
    this.detalle = datos.detalle;
    this.errores = datos.errores;
    this.encabezados = datos.encabezados;
  }
}

/** Los errores de specs/openapi/comun.yaml, con el mismo type y title. */
export const errores = {
  solicitudInvalida: (detalle?: string, campos?: ErrorDeCampo[]) =>
    new ErrorHttp({
      status: 400,
      tipo: 'solicitud-invalida',
      titulo: 'Solicitud inválida',
      ...(detalle ? { detalle } : {}),
      ...(campos ? { errores: campos } : {}),
    }),
  noAutenticado: (detalle = 'Falta el token o no es válido.') =>
    new ErrorHttp({ status: 401, tipo: 'no-autenticado', titulo: 'No autenticado', detalle }),
  prohibido: (detalle = 'No tiene permiso para esta operación.') =>
    new ErrorHttp({ status: 403, tipo: 'prohibido', titulo: 'Acceso denegado', detalle }),
  noEncontrado: (detalle?: string) =>
    new ErrorHttp({
      status: 404,
      tipo: 'no-encontrado',
      titulo: 'No encontrado',
      ...(detalle ? { detalle } : {}),
    }),
  conflicto: (detalle?: string) =>
    new ErrorHttp({
      status: 409,
      tipo: 'conflicto',
      titulo: 'Conflicto',
      ...(detalle ? { detalle } : {}),
    }),
  noDisponible: (detalle?: string) =>
    new ErrorHttp({
      status: 503,
      tipo: 'no-disponible',
      titulo: 'Servicio no disponible',
      ...(detalle ? { detalle } : {}),
    }),
};

export interface Problema {
  type: string;
  title: string;
  status: number;
  detail?: string;
  requestId: string;
  errores?: ErrorDeCampo[];
}

/** Arma el cuerpo problem+json de un ErrorHttp. */
export function aProblema(error: ErrorHttp, requestId: string): Problema {
  return {
    type: `${BASE_TIPO}${error.tipo}`,
    title: error.titulo,
    status: error.status,
    ...(error.detalle ? { detail: error.detalle } : {}),
    requestId,
    ...(error.errores ? { errores: error.errores } : {}),
  };
}

/** Error con status que lanzan express-openapi-validator y express.json (400, 404, 405, 413, 415). */
interface ErrorConStatus {
  status: number;
  message?: string;
  errors?: { path?: string; message?: string }[];
}

function tieneStatus(error: unknown): error is ErrorConStatus {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { status?: unknown }).status === 'number'
  );
}

/** Traduce los errores de las librerías a un ErrorHttp; undefined si es un error no esperado. */
function traducir(error: unknown): ErrorHttp | undefined {
  if (error instanceof ErrorHttp) return error;
  if (!tieneStatus(error) || error.status >= 500 || error.status < 400) return undefined;
  switch (error.status) {
    case 400:
      return errores.solicitudInvalida(
        'La solicitud no cumple el contrato.',
        (error.errors ?? []).map((e) => ({
          campo: e.path ?? '',
          mensaje: e.message ?? 'Valor inválido',
        })),
      );
    case 404:
      return errores.noEncontrado('La ruta no existe.');
    case 405:
      return new ErrorHttp({
        status: 405,
        tipo: 'metodo-no-permitido',
        titulo: 'Método no permitido',
      });
    case 413:
      return new ErrorHttp({
        status: 413,
        tipo: 'solicitud-muy-grande',
        titulo: 'Solicitud muy grande',
      });
    case 415:
      return new ErrorHttp({
        status: 415,
        tipo: 'tipo-no-soportado',
        titulo: 'Tipo de contenido no soportado',
      });
    default:
      return new ErrorHttp({
        status: error.status,
        tipo: 'solicitud-invalida',
        titulo: 'Solicitud inválida',
      });
  }
}

/**
 * Middleware final de errores: responde application/problem+json. Un error no esperado responde
 * 500 sin detalles internos (el detalle queda solo en el log, con el requestId).
 */
export function manejadorErrores(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const requestId = contextoActual()?.requestId ?? randomUUID();
    let conocido = traducir(error);
    if (!conocido) {
      logger.error({ err: error }, 'Error no esperado');
      conocido = new ErrorHttp({ status: 500, tipo: 'error-interno', titulo: 'Error interno' });
    }
    for (const [nombre, valor] of Object.entries(conocido.encabezados ?? {})) {
      res.setHeader(nombre, valor);
    }
    res
      .status(conocido.status)
      .type('application/problem+json')
      .json(aProblema(conocido, requestId));
  };
}
