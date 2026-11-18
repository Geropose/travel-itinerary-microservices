// Mock de Outlook (specs/externos/outlook.md): Microsoft identity platform (OAuth) y Microsoft Graph
// v1.0 (mensajes y change notifications), en un solo puerto. Más las rutas /admin de mocks/comun,
// que no son parte del formato real.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@trotamundos/comun';
import {
  buzonesDePrueba,
  cargarSemillas,
  crearRutasAdmin,
  nombreDe,
} from '@trotamundos/mocks-comun';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import {
  aMensaje,
  crearAlmacen,
  PROPIEDADES,
  type Almacen,
  type Buzon,
  type Guardado,
} from './buzones.ts';
import { demasiadasSolicitudes, errorGraph } from './errores.ts';
import { crearOAuth, MAIL_READ, USER_READ, type Acceso, type OAuth } from './oauth.ts';
import { aRecurso, crearSuscripciones, type Suscripciones } from './suscripciones.ts';

/** Dominio de los buzones de prueba. */
export const DOMINIO = 'outlook.example';
/** Las últimas 5 semillas son cuentas personales: Graph devuelve `mail` en null (sección 1.6). */
const PERSONALES = 5;

export interface OpcionesMock {
  puerto: number;
  logger: Logger;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  vidaTokenS?: number;
  /** Límite de solicitudes a Graph por buzón en cada ventana (QA-7). */
  limiteSolicitudes?: number;
  ventanaLimiteS?: number;
  semillas?: boolean;
  reloj?: () => number;
  /** Para las pruebas: reintentos de los avisos. */
  avisos?: { reintentos?: number; esperaMs?: number };
}

export interface Mock {
  app: express.Express;
  almacen: Almacen;
  oauth: OAuth;
  suscripciones: Suscripciones;
  /** Empieza a escuchar; devuelve el puerto (con puerto 0, uno libre). */
  iniciar(): Promise<number>;
  detener(): Promise<void>;
}

/** Valor de texto de la query. */
const texto = (valor: unknown) => (typeof valor === 'string' ? valor : '');

/** $select: lista de propiedades; devuelve la primera que no existe si hay una. */
function leerSelect(valor: unknown): { campos?: string[]; desconocido?: string } {
  const lista = texto(valor)
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  if (lista.length === 0) return {};
  const desconocido = lista.find((c) => !(PROPIEDADES as readonly string[]).includes(c));
  return desconocido ? { desconocido } : { campos: lista };
}

/** Deja @odata.etag, id y las propiedades pedidas, en el orden del recurso (como Graph). */
function seleccionar(mensaje: Record<string, unknown>, campos?: string[]) {
  if (!campos) return mensaje;
  return Object.fromEntries(
    Object.entries(mensaje).filter(
      ([clave]) => clave === '@odata.etag' || clave === 'id' || campos.includes(clave),
    ),
  );
}

/** Prefer: outlook.body-content-type="text" o "html" (sin el header, HTML). */
function tipoDeCuerpo(prefer: string | undefined): 'html' | 'text' | undefined {
  const tipo = /outlook\.body-content-type\s*=\s*"?(html|text)"?/i.exec(prefer ?? '')?.[1];
  return tipo ? (tipo.toLowerCase() as 'html' | 'text') : undefined;
}

export function crearMock(opciones: OpcionesMock): Mock {
  const { logger, reloj = Date.now } = opciones;
  const suscripciones = crearSuscripciones({ logger, reloj, ...opciones.avisos });
  const almacen = crearAlmacen((buzon, guardado) => suscripciones.avisar(buzon, guardado));

  if (opciones.semillas) {
    cargarSemillas(
      DOMINIO,
      (email, correo, etiqueta) => almacen.agregar(email, correo, etiqueta),
      new Date(reloj()),
    );
    for (const { email } of buzonesDePrueba(DOMINIO).slice(-PERSONALES)) {
      almacen.obtener(email).personal = true;
    }
  }

  const oauth = crearOAuth({
    clientId: opciones.clientId,
    clientSecret: opciones.clientSecret,
    redirectUris: opciones.redirectUris,
    vidaTokenS: opciones.vidaTokenS ?? 3599,
    reloj,
    almacen,
  });

  const limite = opciones.limiteSolicitudes ?? 10_000;
  const ventanaMs = (opciones.ventanaLimiteS ?? 600) * 1000;
  const solicitudes = new Map<string, number[]>();

  const app = express();
  app.disable('x-powered-by');

  // Una línea por solicitud, sin la query (puede traer el código OAuth) ni los headers.
  app.use((req, res, next) => {
    const inicio = performance.now();
    res.on('finish', () => {
      logger.info(
        {
          metodo: req.method,
          ruta: req.path,
          status: res.statusCode,
          ms: Math.round(performance.now() - inicio),
        },
        'solicitud',
      );
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ estado: 'ok' });
  });

  app.use(oauth.router);

  // --- Microsoft Graph v1.0 -----------------------------------------------------------------------

  const graph = Router();

  const error = (res: Response, status: number, code: string, message: string) =>
    void res.status(status).json(errorGraph(code, message, reloj()));

  /** Token válido (401 si no) y límite de solicitudes por buzón (429 si se pasa). */
  graph.use((req: Request, res: Response, next: NextFunction) => {
    const resultado = oauth.validar(req.get('authorization'));
    if ('error' in resultado) {
      const mensaje = {
        vacio: 'Access token is empty.',
        invalido: 'Access token validation failure.',
        vencido: 'Access token has expired or is not yet valid.',
      }[resultado.error];
      return error(res, 401, 'InvalidAuthenticationToken', mensaje);
    }
    const ahora = reloj();
    const email = resultado.acceso.email;
    const recientes = (solicitudes.get(email) ?? []).filter((t) => ahora - t < ventanaMs);
    if (recientes.length >= limite) {
      solicitudes.set(email, recientes);
      const espera = Math.max(1, Math.ceil(((recientes[0] ?? ahora) + ventanaMs - ahora) / 1000));
      res.set('Retry-After', String(espera)).status(429).json(demasiadasSolicitudes(ahora));
      return;
    }
    recientes.push(ahora);
    solicitudes.set(email, recientes);
    res.locals.acceso = resultado.acceso;
    res.locals.buzon = almacen.obtener(email);
    next();
  });

  /** El token tiene alguno de los permisos; si no, 403 como Graph. */
  function permiso(res: Response, scopes: string[], code: string, message: string): boolean {
    const acceso = res.locals.acceso as Acceso;
    if (scopes.some((s) => acceso.scopes.includes(s))) return true;
    error(res, 403, code, message);
    return false;
  }
  const leerCorreo = (res: Response) =>
    permiso(
      res,
      [MAIL_READ, 'https://graph.microsoft.com/Mail.ReadWrite'],
      'ErrorAccessDenied',
      'Access is denied. Check credentials and try again.',
    );

  // 1.6 Perfil del usuario.
  graph.get('/me', (req, res) => {
    if (
      !permiso(
        res,
        [USER_READ],
        'Authorization_RequestDenied',
        'Insufficient privileges to complete the operation.',
      )
    ) {
      return;
    }
    const buzon = res.locals.buzon as Buzon;
    const nombre = nombreDe(buzon.email, DOMINIO);
    const usuario: Record<string, unknown> = {
      id: buzon.id,
      displayName: nombre,
      mail: buzon.personal ? null : buzon.email,
      userPrincipalName: buzon.email,
    };
    const campos = texto(req.query.$select)
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    res.json({
      '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users/$entity',
      ...(campos.length > 0
        ? Object.fromEntries(Object.entries(usuario).filter(([c]) => campos.includes(c)))
        : usuario),
    });
  });

  // 2. Listar mensajes.
  graph.get('/me/messages', (req, res) => {
    if (!leerCorreo(res)) return;
    const buzon = res.locals.buzon as Buzon;
    const { campos, desconocido } = leerSelect(req.query.$select);
    if (desconocido) {
      return error(
        res,
        400,
        'RequestBroker--ParseUri',
        `Could not find a property named '${desconocido}' on type 'Microsoft.OutlookServices.Message'.`,
      );
    }
    const filtro = texto(req.query.$filter).trim();
    let desde = -Infinity;
    let estricto = false;
    if (filtro) {
      const partes = /^receivedDateTime\s+(ge|gt)\s+(\S+)$/i.exec(filtro);
      const ms = Date.parse(partes?.[2] ?? '');
      if (!partes || Number.isNaN(ms)) {
        return error(res, 400, 'BadRequest', `Invalid filter clause: ${filtro}`);
      }
      desde = ms;
      estricto = partes[1]?.toLowerCase() === 'gt';
    }
    const orden = texto(req.query.$orderby).trim();
    const partesOrden = /^(\w+)(?:\s+(asc|desc))?$/i.exec(orden);
    if (orden && partesOrden?.[1] !== 'receivedDateTime') {
      // Graph exige que la propiedad del $orderby esté también en el $filter.
      return filtro
        ? error(
            res,
            400,
            'InefficientFilter',
            'The restriction or sort order is too complex for this operation.',
          )
        : error(
            res,
            400,
            'BadRequest',
            `The mock only supports $orderby=receivedDateTime: ${orden}`,
          );
    }
    const ascendente = partesOrden?.[2]?.toLowerCase() === 'asc';
    const top = req.query.$top === undefined ? 10 : Number(req.query.$top);
    const saltar = req.query.$skip === undefined ? 0 : Number(req.query.$skip);
    if (!Number.isInteger(top) || top < 1 || top > 1000) {
      return error(
        res,
        400,
        'BadRequest',
        'Invalid value for $top: it must be between 1 and 1000.',
      );
    }
    if (!Number.isInteger(saltar) || saltar < 0) {
      return error(res, 400, 'BadRequest', 'Invalid value for $skip.');
    }

    const encontrados = buzon.guardados
      .map((g, i) => ({ g, i }))
      .filter(({ g }) =>
        estricto ? g.correo.fecha.getTime() > desde : g.correo.fecha.getTime() >= desde,
      )
      .sort((a, b) => {
        const diferencia = a.g.correo.fecha.getTime() - b.g.correo.fecha.getTime() || a.i - b.i;
        return ascendente ? diferencia : -diferencia;
      })
      .map(({ g }) => g);
    const pagina = encontrados.slice(saltar, saltar + top);
    const cuerpo = tipoDeCuerpo(req.get('prefer'));
    if (cuerpo) res.set('Preference-Applied', `outlook.body-content-type="${cuerpo}"`);

    // @odata.nextLink: la misma consulta con $skip, para usarla tal cual.
    let siguiente: string | undefined;
    if (saltar + top < encontrados.length) {
      const parametros = Object.entries({ ...req.query, $skip: String(saltar + top) })
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
        .join('&');
      siguiente = `${req.protocol}://${req.get('host') ?? 'localhost'}/v1.0/me/messages?${parametros}`;
    }
    res.json({
      '@odata.context': `https://graph.microsoft.com/v1.0/$metadata#users('${buzon.id}')/messages${campos ? `(${campos.join(',')})` : ''}`,
      value: pagina.map((g) => seleccionar(aMensaje(buzon, g, cuerpo ?? 'html'), campos)),
      ...(siguiente ? { '@odata.nextLink': siguiente } : {}),
    });
  });

  // 3. Obtener un mensaje.
  graph.get('/me/messages/:id', (req: Request<{ id: string }>, res) => {
    if (!leerCorreo(res)) return;
    const buzon = res.locals.buzon as Buzon;
    const { campos, desconocido } = leerSelect(req.query.$select);
    if (desconocido) {
      return error(
        res,
        400,
        'RequestBroker--ParseUri',
        `Could not find a property named '${desconocido}' on type 'Microsoft.OutlookServices.Message'.`,
      );
    }
    const guardado: Guardado | undefined = buzon.guardados.find((g) => g.id === req.params.id);
    if (!guardado) {
      return error(
        res,
        404,
        'ErrorItemNotFound',
        'The specified object was not found in the store.',
      );
    }
    const cuerpo = tipoDeCuerpo(req.get('prefer'));
    if (cuerpo) res.set('Preference-Applied', `outlook.body-content-type="${cuerpo}"`);
    res.json({
      '@odata.context': `https://graph.microsoft.com/v1.0/$metadata#users('${buzon.id}')/messages/$entity`,
      ...seleccionar(aMensaje(buzon, guardado, cuerpo ?? 'html'), campos),
    });
  });

  // 4.1 Crear la suscripción (con la validación de la URL).
  graph.post('/subscriptions', express.json(), async (req, res) => {
    if (!leerCorreo(res)) return;
    const acceso = res.locals.acceso as Acceso;
    const resultado = await suscripciones.crear(
      res.locals.buzon as Buzon,
      acceso.clientId,
      (req.body ?? {}) as Record<string, unknown>,
    );
    if (!('ok' in resultado))
      return error(res, resultado.status, resultado.code, resultado.message);
    res.status(201).json(aRecurso(resultado.ok));
  });

  // 4.3 Renovar la suscripción.
  graph.patch('/subscriptions/:id', express.json(), (req: Request<{ id: string }>, res) => {
    const acceso = res.locals.acceso as Acceso;
    const suscripcion = suscripciones.buscar(
      req.params.id,
      res.locals.buzon as Buzon,
      acceso.clientId,
    );
    if (!suscripcion) {
      return error(res, 404, 'ResourceNotFound', 'The object was not found.');
    }
    const resultado = suscripciones.renovar(
      suscripcion,
      ((req.body ?? {}) as Record<string, unknown>).expirationDateTime,
    );
    if (!('ok' in resultado))
      return error(res, resultado.status, resultado.code, resultado.message);
    res.json(aRecurso(resultado.ok));
  });

  // Borrar la suscripción (por ejemplo, al desconectar la cuenta).
  graph.delete('/subscriptions/:id', (req: Request<{ id: string }>, res) => {
    const acceso = res.locals.acceso as Acceso;
    const suscripcion = suscripciones.buscar(
      req.params.id,
      res.locals.buzon as Buzon,
      acceso.clientId,
    );
    if (!suscripcion) {
      return error(res, 404, 'ResourceNotFound', 'The object was not found.');
    }
    suscripciones.borrar(suscripcion.id);
    res.status(204).end();
  });

  app.use('/v1.0', graph);

  // --- Administración (solo para pruebas, rutas de mocks/comun) ----------------------------------

  app.use(
    '/admin',
    crearRutasAdmin(
      {
        resumen: () =>
          almacen.todos().map((b) => ({
            email: b.email,
            id: b.id,
            personal: b.personal,
            correos: b.guardados.length,
            suscripciones: suscripciones.vigentes(b.email),
          })),
        correos: (email) =>
          almacen.buscar(email)?.guardados.map((g) => ({
            id: g.id,
            de: g.correo.de,
            asunto: g.correo.asunto,
            ...(g.etiqueta ? { etiqueta: g.etiqueta } : {}),
          })),
        agregar: (email, correo, etiqueta) => almacen.agregar(email, correo, etiqueta).id,
        vencerTokens: (email) => oauth.vencerTokens(email),
        revocarTokens: (email) => oauth.revocar(email),
      },
      { reloj, nombreDe: (email) => nombreDe(email, DOMINIO) },
    ),
  );

  // Cuerpo JSON mal formado u otro error inesperado, con el formato de Graph.
  app.use(
    (fallo: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
      const status = fallo.status && fallo.status < 500 ? fallo.status : 500;
      if (status === 500) logger.error({ err: fallo }, 'error inesperado');
      error(
        res,
        status,
        status === 500 ? 'generalException' : 'BadRequest',
        status === 500 ? 'An internal server error occurred.' : 'Unable to read the request body.',
      );
    },
  );

  let servidor: Server | undefined;
  return {
    app,
    almacen,
    oauth,
    suscripciones,
    iniciar: () =>
      new Promise((resolver) => {
        servidor = app.listen(opciones.puerto, () => {
          const puerto = (servidor?.address() as AddressInfo).port;
          logger.info({ puerto }, 'mock de Outlook escuchando');
          resolver(puerto);
        });
      }),
    detener: () =>
      new Promise((resolver) => {
        suscripciones.detener();
        if (!servidor) return resolver();
        servidor.close(() => resolver());
      }),
  };
}
