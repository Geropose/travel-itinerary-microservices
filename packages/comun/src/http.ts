import { contextoActual } from './contexto.ts';

/** Ruta para logs y mensajes de error: quita query string y oculta segmentos con email. */
export function rutaParaLog(ruta: string): string {
  const sinQuery = ruta.split('?')[0] ?? '';
  return sinQuery
    .split('/')
    .map((parte) => (/@|%40/i.test(parte) ? ':email' : parte))
    .join('/');
}

/** La llamada a otro servicio no respondió dentro del tiempo máximo. */
export class ErrorTiempoAgotado extends Error {
  readonly url: string;
  readonly tiempoMs: number;
  constructor(url: string, tiempoMs: number) {
    super(`${url} no respondió en ${tiempoMs} ms`);
    this.name = 'ErrorTiempoAgotado';
    this.url = url;
    this.tiempoMs = tiempoMs;
  }
}

/** El otro servicio respondió con un código de error (4xx o 5xx). */
export class ErrorRespuestaHttp extends Error {
  readonly url: string;
  readonly status: number;
  readonly cuerpo: unknown;
  constructor(url: string, status: number, cuerpo: unknown) {
    super(`${url} respondió ${status}`);
    this.name = 'ErrorRespuestaHttp';
    this.url = url;
    this.status = status;
    this.cuerpo = cuerpo;
  }
}

export interface OpcionesCliente {
  /** URL base del otro servicio, por ejemplo http://usuarios:3002 */
  urlBase: string;
  /** Tiempo máximo por llamada (CONVENCIONES 4.3: 2 s por defecto). */
  tiempoMaximoMs?: number;
  /** fetch a usar (las pruebas pasan uno propio). */
  fetch?: typeof fetch;
}

export interface OpcionesLlamada {
  query?: Record<string, string | number | boolean | undefined>;
  cuerpo?: unknown;
  encabezados?: Record<string, string>;
  /**
   * Token a mandar. Por defecto se propaga el de la solicitud en curso (ADR-019); con null no se
   * manda ninguno; un token de servicio se pasa acá explícitamente.
   */
  token?: string | null;
  tiempoMaximoMs?: number;
}

export interface RespuestaHttp<T> {
  status: number;
  datos: T;
  encabezados: Headers;
}

export interface ClienteHttp {
  pedir<T = unknown>(
    metodo: string,
    ruta: string,
    opciones?: OpcionesLlamada,
  ): Promise<RespuestaHttp<T>>;
  get<T = unknown>(ruta: string, opciones?: OpcionesLlamada): Promise<RespuestaHttp<T>>;
  post<T = unknown>(
    ruta: string,
    cuerpo?: unknown,
    opciones?: OpcionesLlamada,
  ): Promise<RespuestaHttp<T>>;
}

/**
 * Cliente para llamar a otro servicio: corta a los 2 s, propaga el X-Request-Id y el JWT de la
 * solicitud en curso, y transforma las respuestas de error en ErrorRespuestaHttp.
 */
export function crearClienteHttp(opciones: OpcionesCliente): ClienteHttp {
  const { urlBase, tiempoMaximoMs = 2000 } = opciones;
  const hacerFetch = opciones.fetch ?? fetch;

  async function pedir<T>(
    metodo: string,
    ruta: string,
    llamada: OpcionesLlamada = {},
  ): Promise<RespuestaHttp<T>> {
    // La ruta se agrega a la de la URL base (que puede tener un prefijo, por ejemplo
    // http://nginx:8090/otra-region/autenticacion), en lugar de reemplazarla.
    const url = new URL(`${urlBase.replace(/\/+$/, '')}/${ruta.replace(/^\/+/, '')}`);
    for (const [clave, valor] of Object.entries(llamada.query ?? {})) {
      if (valor !== undefined) url.searchParams.set(clave, String(valor));
    }
    const contexto = contextoActual();
    const encabezados: Record<string, string> = { accept: 'application/json' };
    if (contexto) encabezados['x-request-id'] = contexto.requestId;
    const token = llamada.token === undefined ? contexto?.token : llamada.token;
    if (token) encabezados.authorization = `Bearer ${token}`;
    if (llamada.cuerpo !== undefined) encabezados['content-type'] = 'application/json';
    Object.assign(encabezados, llamada.encabezados);

    const urlParaError = `${url.origin}${rutaParaLog(url.pathname)}`;
    const tiempo = llamada.tiempoMaximoMs ?? tiempoMaximoMs;
    let respuesta: Response;
    let texto: string;
    try {
      respuesta = await hacerFetch(url, {
        method: metodo,
        headers: encabezados,
        ...(llamada.cuerpo !== undefined ? { body: JSON.stringify(llamada.cuerpo) } : {}),
        signal: AbortSignal.timeout(tiempo),
      });
      texto = await respuesta.text();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new ErrorTiempoAgotado(urlParaError, tiempo);
      }
      throw error;
    }
    let datos: unknown = texto;
    if (texto && (respuesta.headers.get('content-type') ?? '').includes('json')) {
      try {
        datos = JSON.parse(texto);
      } catch (error) {
        if (!respuesta.ok) throw new ErrorRespuestaHttp(urlParaError, respuesta.status, texto);
        throw new Error(`${urlParaError} devolvió JSON inválido`, { cause: error });
      }
    }
    if (!respuesta.ok) throw new ErrorRespuestaHttp(urlParaError, respuesta.status, datos);
    return { status: respuesta.status, datos: datos as T, encabezados: respuesta.headers };
  }

  return {
    pedir,
    get: (ruta, llamada) => pedir('GET', ruta, llamada),
    post: (ruta, cuerpo, llamada) => pedir('POST', ruta, { ...llamada, cuerpo }),
  };
}
