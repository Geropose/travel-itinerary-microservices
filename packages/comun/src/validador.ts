import { isIP } from 'node:net';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  createLocalJWKSet,
  decodeJwt,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { REGIONES, type Region } from './config.ts';
import { contextoActual } from './contexto.ts';
import { aProblema, errores, type ErrorHttp } from './errores.ts';
import { crearClienteHttp, rutaParaLog, type ClienteHttp } from './http.ts';
import type { Logger } from './logger.ts';
import type { MotivoRechazo, RegistrarRechazo } from './registro-accesos.ts';
import type { Spec } from './spec.ts';

/** Quién hace la solicitud, según el token ya verificado. */
export interface Autenticacion {
  /** usuarioId (UUID) o, con un token de servicio, el nombre del servicio. */
  sub: string;
  region: Region;
  roles: string[];
  idioma: string | undefined;
  esServicio: boolean;
  token: string;
}

/** De dónde salen las claves públicas: la URL del JWKS de Autenticación o las claves mismas. */
export type FuenteClaves = { url: string } | { claves: JSONWebKeySet };

/** Reglas de una operación del contrato, con clave "MÉTODO /ruta" (por ejemplo "GET /interna/cuentas"). */
export interface ReglaRuta {
  /** Servicios que pueden llamarla con token de servicio (sub del token). Sin esto, ninguno. */
  servicios?: string[];
  /** Roles de usuario que la pueden usar (por defecto, rolesPorDefecto). */
  roles?: string[];
  /** Regiones de token aceptadas (por defecto solo la del servicio). */
  regiones?: Region[];
}

/**
 * Reglas para interceptar las rutas de un contrato que no es el del propio servicio. Lo usa el
 * gateway, que valida con un solo validador las rutas de todos los servicios (ADR-005).
 */
export interface AjustesContrato {
  /** Reglas de las operaciones de ese contrato (en lugar de las del validador). */
  reglas?: Record<string, ReglaRuta>;
  /** Roles por defecto de las rutas con bearerJWT de ese contrato (en lugar de los del validador). */
  rolesPorDefecto?: string[];
}

export interface OpcionesValidador {
  servicio: string;
  region: Region;
  logger: Logger;
  /** Claves de cada región. La propia es obligatoria; la otra solo si alguna ruta la acepta. */
  claves: Partial<Record<Region, FuenteClaves>>;
  registrar: RegistrarRechazo;
  reglas?: Record<string, ReglaRuta>;
  /** Roles que pueden usar las rutas con bearerJWT si su regla no dice otra cosa (por defecto usuario). */
  rolesPorDefecto?: string[];
  /** Cada cuánto se vuelve a descargar el JWKS (por defecto 10 min). */
  renovarClavesCadaMs?: number;
  fetch?: typeof fetch;
}

export class ErrorTokenInvalido extends Error {
  readonly motivo: MotivoRechazo;
  constructor(motivo: MotivoRechazo, mensaje: string) {
    super(mensaje);
    this.name = 'ErrorTokenInvalido';
    this.motivo = motivo;
  }
}

const autenticaciones = new WeakMap<Request, Autenticacion>();

/** Quién hizo la solicitud (solo en rutas protegidas, después del validador). */
export function autenticacion(req: Request): Autenticacion {
  const auth = autenticaciones.get(req);
  if (!auth) throw new Error('La solicitud no pasó por el Validador de Intercepción');
  return auth;
}

export function ipDe(req: { ip?: string }): string | undefined {
  const ip = (req.ip ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return isIP(ip) ? ip : undefined;
}

export interface OpcionesDuenoODesignado {
  /** Dueño del itinerario según los datos del servicio; undefined si el viaje no existe (404). */
  obtenerDueno: (req: Request) => Promise<string | undefined> | string | undefined;
  viajeId: (req: Request) => string;
  /** Cliente del Servicio de Usuarios (por defecto uno a urlUsuarios con 2 s de tiempo máximo). */
  usuarios?: ClienteHttp;
  urlUsuarios?: string;
}

export interface Validador {
  /** Descarga las claves (reintenta hasta lograrlo) y programa la renovación. */
  iniciar(): Promise<void>;
  detener(): void;
  /** Verifica firma, vencimiento, roles y región de un token. Lanza ErrorTokenInvalido. */
  verificarToken(token: string, regiones?: Region[]): Promise<Autenticacion>;
  /**
   * Middleware que intercepta todas las solicitudes según la seguridad del contrato. Con ajustes,
   * usa otras reglas y roles por defecto para ese contrato (el gateway, uno por servicio).
   */
  middleware(spec: Spec, ajustes?: AjustesContrato): RequestHandler;
  /** Solo el dueño: el sub del token tiene que ser el usuarioId del recurso. */
  soloDueno(
    obtenerDueno: (req: Request) => Promise<string | undefined> | string | undefined,
  ): RequestHandler;
  /** Dueño o persona designada del itinerario (consulta al Servicio de Usuarios, 2 s como máximo). */
  duenoODesignado(opciones: OpcionesDuenoODesignado): RequestHandler;
}

/**
 * Validador de Intercepción (ADR-005, ADR-014). Verifica el JWT RS256 con las claves del JWKS de
 * Autenticación descargadas al arrancar y renovadas cada 10 min (sin usar la red en cada
 * solicitud), el vencimiento, los roles y la región. Si rechaza, responde 401 o 403 y registra el
 * intento sin esperar.
 */
export function crearValidador(opciones: OpcionesValidador): Validador {
  const { servicio, region, logger, registrar } = opciones;
  const reglasValidador = opciones.reglas ?? {};
  const rolesValidador = opciones.rolesPorDefecto ?? ['usuario'];
  const renovarCadaMs = opciones.renovarClavesCadaMs ?? 10 * 60 * 1000;
  const hacerFetch = opciones.fetch ?? fetch;
  const juegos = new Map<Region, JWTVerifyGetKey>();
  const recargasEnCurso = new Map<Region, Promise<boolean>>();
  const ultimaRecargaPorKidMs = new Map<Region, number>();
  const COOLDOWN_RECARGA_KID_MS = 30_000;
  const temporizadores: NodeJS.Timeout[] = [];
  if (!opciones.claves[region]) throw new Error(`Faltan las claves de la región ${region}`);

  async function cargarClaves(r: Region, fuente: FuenteClaves): Promise<void> {
    if ('claves' in fuente) {
      juegos.set(r, createLocalJWKSet(fuente.claves));
      return;
    }
    const respuesta = await hacerFetch(fuente.url, { signal: AbortSignal.timeout(2000) });
    if (!respuesta.ok) throw new Error(`${fuente.url} respondió ${respuesta.status}`);
    juegos.set(r, createLocalJWKSet((await respuesta.json()) as JSONWebKeySet));
    logger.info({ regionClaves: r }, 'Claves del JWKS descargadas');
  }

  async function intentarRecargaPorKidDesconocido(r: Region): Promise<boolean> {
    const fuente = opciones.claves[r];
    if (!fuente || !('url' in fuente)) return false;
    const enCurso = recargasEnCurso.get(r);
    if (enCurso) return await enCurso;
    const ahoraMs = Date.now();
    if (ahoraMs - (ultimaRecargaPorKidMs.get(r) ?? 0) < COOLDOWN_RECARGA_KID_MS) return false;
    ultimaRecargaPorKidMs.set(r, ahoraMs);
    const promesa = cargarClaves(r, fuente)
      .then(() => true)
      .catch((error: unknown) => {
        logger.warn(
          { err: error, regionClaves: r },
          'No se pudo recargar el JWKS ante kid desconocido',
        );
        return false;
      })
      .finally(() => {
        recargasEnCurso.delete(r);
      });
    recargasEnCurso.set(r, promesa);
    return await promesa;
  }

  let detenido = false;

  /** Reintenta hasta descargar las claves (o hasta que se detenga el validador). */
  async function cargarConReintentos(r: Region, fuente: FuenteClaves): Promise<void> {
    for (let intento = 1; !detenido; intento++) {
      try {
        await cargarClaves(r, fuente);
        return;
      } catch (error) {
        logger.warn(
          { err: error, intento, regionClaves: r },
          'No se pudo descargar el JWKS: reintentando',
        );
        await new Promise((resolver) => setTimeout(resolver, Math.min(5000, 250 * intento)));
      }
    }
  }

  async function iniciar(): Promise<void> {
    for (const r of REGIONES) {
      const fuente = opciones.claves[r];
      if (!fuente) continue;
      if (r === region) {
        // Sin las claves propias no se puede atender: se espera hasta tenerlas.
        await cargarConReintentos(r, fuente);
      } else {
        // Las de la otra región se cargan aparte: si esa región está caída, esta igual arranca, y
        // sus tokens se rechazan hasta tener las claves (ADR-017).
        void cargarConReintentos(r, fuente);
      }
      if ('url' in fuente) {
        const t = setInterval(() => {
          cargarClaves(r, fuente).catch((error: unknown) =>
            logger.warn(
              { err: error },
              'No se pudo renovar el JWKS: se siguen usando las claves anteriores',
            ),
          );
        }, renovarCadaMs);
        t.unref();
        temporizadores.push(t);
      }
    }
  }

  async function verificarToken(
    token: string,
    regiones: Region[] = [region],
  ): Promise<Autenticacion> {
    let regionReclamada: unknown;
    try {
      regionReclamada = decodeJwt(token).region;
    } catch {
      throw new ErrorTokenInvalido('token-invalido', 'El token no es un JWT');
    }
    // Primero con las claves de la región que dice el token (si las tenemos) y después con las
    // propias: si las dos regiones comparten la clave, el claim region igual se controla abajo.
    const regionesCandidatas = [
      ...new Set([REGIONES.find((r) => r === regionReclamada), region]),
    ].filter((r): r is Region => r !== undefined && juegos.has(r));
    if (regionesCandidatas.length === 0)
      throw new ErrorTokenInvalido('token-invalido', 'Todavía no hay claves para verificar');
    let payload: JWTPayload | undefined;
    let ultimoError: unknown;
    for (const rCandidata of regionesCandidatas) {
      const claves = juegos.get(rCandidata);
      if (!claves) continue;
      try {
        ({ payload } = await jwtVerify(token, claves, {
          algorithms: ['RS256'],
          requiredClaims: ['exp', 'sub'],
        }));
        break;
      } catch (error) {
        if ((error as { code?: string } | null)?.code === 'ERR_JWKS_NO_MATCHING_KEY') {
          const recargado = await intentarRecargaPorKidDesconocido(rCandidata);
          const nuevasClaves = recargado ? juegos.get(rCandidata) : undefined;
          if (nuevasClaves) {
            try {
              ({ payload } = await jwtVerify(token, nuevasClaves, {
                algorithms: ['RS256'],
                requiredClaims: ['exp', 'sub'],
              }));
              break;
            } catch (errorReintento) {
              ultimoError = errorReintento;
              continue;
            }
          }
        }
        ultimoError = error;
      }
    }
    if (!payload) throw new ErrorTokenInvalido('token-invalido', (ultimoError as Error).message);
    const roles = payload.roles;
    const regionToken = REGIONES.find((r) => r === payload.region);
    if (
      !regionToken ||
      typeof payload.sub !== 'string' ||
      !Array.isArray(roles) ||
      !roles.every((r) => typeof r === 'string')
    ) {
      throw new ErrorTokenInvalido('token-invalido', 'Faltan claims o no son válidos');
    }
    if (!regiones.includes(regionToken)) {
      throw new ErrorTokenInvalido('otra-region', `El token es de ${regionToken}`);
    }
    return {
      sub: payload.sub,
      region: regionToken,
      roles,
      idioma: typeof payload.idioma === 'string' ? payload.idioma : undefined,
      esServicio: roles.includes('servicio'),
      token,
    };
  }

  function rechazar(
    req: Request,
    res: Response,
    error: ErrorHttp,
    motivo: MotivoRechazo,
    usuarioId?: string,
  ): void {
    const requestId = contextoActual()?.requestId ?? '';
    const ip = ipDe(req);
    // Ruta completa: en el gateway el validador está montado en /api/<servicio>.
    const ruta = rutaParaLog(req.baseUrl + req.path);
    registrar({
      servicio,
      metodo: req.method,
      ruta,
      status: error.status as 401 | 403,
      motivo,
      ...(usuarioId ? { usuarioId } : {}),
      ...(ip ? { ip } : {}),
      requestId,
    });
    logger.info({ metodo: req.method, ruta, status: error.status, motivo }, 'Acceso rechazado');
    res.status(error.status).type('application/problem+json').json(aProblema(error, requestId));
  }

  /** usuarioId para el registro: solo si es un usuario (UUID), nunca el nombre de un servicio. */
  const usuarioDe = (auth: Autenticacion) => (auth.esServicio ? undefined : auth.sub);

  function middleware(spec: Spec, ajustes: AjustesContrato = {}): RequestHandler {
    const reglas = ajustes.reglas ?? reglasValidador;
    const rolesPorDefecto = ajustes.rolesPorDefecto ?? rolesValidador;
    for (const clave of Object.keys(reglas)) {
      const [metodo = '', ruta = ''] = clave.split(' ');
      if (!spec.operaciones.some((o) => o.metodo === metodo && o.ruta === ruta)) {
        throw new Error(`La regla "${clave}" no corresponde a ninguna operación del contrato`);
      }
    }
    return async (req, res, next) => {
      const op = spec.buscar(req.method, req.path);
      // Fuera del contrato: lo responde el validador de OpenAPI (404/405). Pública: pasa.
      if (!op || op.seguridad.length === 0) {
        next();
        return;
      }
      const encabezado = req.headers.authorization;
      if (!encabezado?.startsWith('Bearer ')) {
        rechazar(req, res, errores.noAutenticado('Falta el token.'), 'sin-token');
        return;
      }
      const regla = reglas[`${op.metodo} ${op.ruta}`] ?? {};
      let auth: Autenticacion;
      try {
        auth = await verificarToken(
          encabezado.slice('Bearer '.length).trim(),
          regla.regiones ?? [region],
        );
      } catch (error) {
        if (error instanceof ErrorTokenInvalido && error.motivo === 'otra-region') {
          rechazar(req, res, errores.prohibido('El token es de otra región.'), 'otra-region');
        } else {
          rechazar(
            req,
            res,
            errores.noAutenticado('El token no es válido o venció.'),
            'token-invalido',
          );
        }
        return;
      }
      const permitido = auth.esServicio
        ? op.seguridad.includes('tokenServicio') && (regla.servicios ?? []).includes(auth.sub)
        : op.seguridad.includes('bearerJWT') &&
          auth.roles.some((r) => (regla.roles ?? rolesPorDefecto).includes(r));
      if (!permitido) {
        rechazar(req, res, errores.prohibido(), 'sin-permiso', usuarioDe(auth));
        return;
      }
      autenticaciones.set(req, auth);
      const contexto = contextoActual();
      if (contexto) contexto.token = auth.token;
      next();
    };
  }

  function soloDueno(
    obtenerDueno: (req: Request) => Promise<string | undefined> | string | undefined,
  ): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction) => {
      const auth = autenticacion(req);
      const dueno = await obtenerDueno(req);
      if (dueno === undefined) throw errores.noEncontrado();
      if (auth.esServicio || auth.sub !== dueno) {
        rechazar(
          req,
          res,
          errores.prohibido('Solo el dueño puede hacer esta operación.'),
          'sin-permiso',
          usuarioDe(auth),
        );
        return;
      }
      next();
    };
  }

  function duenoODesignado(o: OpcionesDuenoODesignado): RequestHandler {
    const usuarios =
      o.usuarios ??
      crearClienteHttp({ urlBase: o.urlUsuarios ?? 'http://usuarios:3002', tiempoMaximoMs: 2000 });
    return async (req: Request, res: Response, next: NextFunction) => {
      const auth = autenticacion(req);
      const dueno = await o.obtenerDueno(req);
      if (dueno === undefined) throw errores.noEncontrado();
      if (!auth.esServicio && auth.sub === dueno) {
        next();
        return;
      }
      let puedeVer = false;
      if (!auth.esServicio) {
        try {
          const viajeId = encodeURIComponent(o.viajeId(req));
          const { datos } = await usuarios.get<{ puedeVer: boolean }>(
            `/interna/permisos/itinerarios/${viajeId}`,
            { query: { usuarioId: auth.sub }, token: auth.token },
          );
          puedeVer = datos.puedeVer === true;
        } catch (error) {
          // Sin respuesta de Usuarios no se puede decidir: no se muestra (falla cerrada).
          logger.warn({ err: error }, 'No se pudo consultar el permiso del itinerario');
          throw errores.noDisponible('No se pudo verificar el permiso del itinerario.');
        }
      }
      if (!puedeVer) {
        rechazar(
          req,
          res,
          errores.prohibido('No es el dueño ni una persona designada.'),
          'sin-permiso',
          usuarioDe(auth),
        );
        return;
      }
      next();
    };
  }

  return {
    iniciar,
    detener: () => {
      detenido = true;
      temporizadores.forEach((t) => clearInterval(t));
    },
    verificarToken,
    middleware,
    soloDueno,
    duenoODesignado,
  };
}
