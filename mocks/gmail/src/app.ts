// Mock de Gmail (specs/externos/gmail.md): OAuth de Google, Gmail API v1 y avisos push con el
// formato de Pub/Sub, en un solo puerto. Más las rutas /admin para las pruebas, que no son parte
// del formato real.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@trotamundos/comun';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { cargarSemillas, crearRutasAdmin, direccion, nombreDe } from '@trotamundos/mocks-comun';
import { z } from 'zod';
import { crearAvisos, type Avisos } from './avisos.ts';
import { crearAlmacen, type Almacen, type Buzon } from './buzones.ts';
import { crearCuota, type Metodo } from './cuota.ts';
import {
  argumentoInvalido,
  credencialesInvalidas,
  errorGmail,
  limiteSuperado,
  noEncontrado,
} from './errores.ts';
import { crearOAuth, type OAuth } from './oauth.ts';

/** Dominio de los buzones de prueba. */
export const DOMINIO = 'gmail.example';

/** Duración de un watch (Gmail: 7 días). */
const VIDA_WATCH_MS = 7 * 86_400_000;

export interface OpcionesMock {
  puerto: number;
  logger: Logger;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  vidaTokenS?: number;
  cuotaPorMinuto?: number;
  /** Tópico de Pub/Sub → URL de su suscripción push. */
  suscripciones?: Map<string, string>;
  semillas?: boolean;
  reloj?: () => number;
  /** Para las pruebas: intervalo entre avisos y espera de los reintentos. */
  avisos?: { intervaloMs?: number; esperaMs?: number; reintentos?: number };
}

export interface Mock {
  app: express.Express;
  almacen: Almacen;
  oauth: OAuth;
  avisos: Avisos;
  /** Empieza a escuchar; devuelve el puerto (con puerto 0, uno libre). */
  iniciar(): Promise<number>;
  detener(): Promise<void>;
}

/** Valor de texto de la query. */
const texto = (valor: unknown) => (typeof valor === 'string' ? valor : '');

/** maxResults: por defecto 100, máximo 500. */
function cantidadMaxima(valor: unknown): number | undefined {
  if (valor === undefined) return 100;
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : undefined;
}

/** pageToken del mock: la posición donde sigue la lista. */
function posicion(valor: unknown): number | undefined {
  if (valor === undefined || valor === '') return 0;
  const n = Number(valor);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Filtro de la búsqueda q: solo after:<segundos epoch> y from:<dirección> (sección 2). */
function filtroDe(q: string): ((de: string, fechaMs: number) => boolean) | undefined {
  const condiciones: ((de: string, fechaMs: number) => boolean)[] = [];
  for (const termino of q.split(/\s+/).filter(Boolean)) {
    const [clave, ...resto] = termino.split(':');
    const valor = resto.join(':');
    if (clave === 'after' && /^\d+$/.test(valor)) {
      condiciones.push((_, fechaMs) => fechaMs >= Number(valor) * 1000);
    } else if (clave === 'from' && valor) {
      condiciones.push((de) => direccion(de).includes(valor.toLowerCase()));
    } else {
      return undefined;
    }
  }
  return (de, fechaMs) => condiciones.every((c) => c(de, fechaMs));
}

export function crearMock(opciones: OpcionesMock): Mock {
  const { logger, reloj = Date.now } = opciones;
  const avisos = crearAvisos({
    suscripciones: opciones.suscripciones ?? new Map(),
    logger,
    reloj,
    ...opciones.avisos,
  });

  /** Watch activo que pide aviso por un correo nuevo en INBOX. */
  function avisarSiCorresponde(buzon: Buzon) {
    const watch = buzon.watch;
    if (!watch || watch.expiration <= reloj()) return;
    const conInbox = watch.labelIds.length === 0 || watch.labelIds.includes('INBOX');
    if (watch.excluir ? !watch.labelIds.includes('INBOX') : conInbox) {
      avisos.avisar(buzon.email, buzon.historyId, watch.topicName);
    }
  }

  const almacen = crearAlmacen(avisarSiCorresponde);
  if (opciones.semillas) {
    cargarSemillas(
      DOMINIO,
      (email, correo, etiqueta) => almacen.agregar(email, correo, etiqueta),
      new Date(reloj()),
    );
  }

  const oauth = crearOAuth({
    clientId: opciones.clientId,
    clientSecret: opciones.clientSecret,
    redirectUris: opciones.redirectUris,
    vidaTokenS: opciones.vidaTokenS ?? 3599,
    reloj,
    almacen,
  });
  const cuota = crearCuota(opciones.cuotaPorMinuto ?? 6000, reloj);

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

  // --- Gmail API v1 -------------------------------------------------------------------------------

  const api = Router({ mergeParams: true });

  /** Token válido (401 si no) y userId "me" o el dueño del token (403 si no). */
  api.use((req: Request<{ userId: string }>, res: Response, next: NextFunction) => {
    const acceso = oauth.validar(req.get('authorization'));
    if (!acceso) {
      res.status(401).json(credencialesInvalidas());
      return;
    }
    const usuario = req.params.userId.toLowerCase();
    if (usuario !== 'me' && usuario !== acceso.email) {
      res.status(403).json(errorGmail(403, 'Delegation denied for ' + acceso.email, 'forbidden'));
      return;
    }
    res.locals.buzon = almacen.obtener(acceso.email);
    next();
  });

  /** Descuenta la cuota del usuario; si se pasa, responde 429. */
  function cobrar(res: Response, metodo: Metodo): boolean {
    const buzon = res.locals.buzon as Buzon;
    if (cuota.consumir(buzon.email, metodo)) return true;
    res.status(429).json(limiteSuperado());
    return false;
  }

  // 1.6 users.getProfile
  api.get('/profile', (_req, res) => {
    if (!cobrar(res, 'perfil')) return;
    const buzon = res.locals.buzon as Buzon;
    res.json({
      emailAddress: buzon.email,
      messagesTotal: buzon.guardados.length,
      threadsTotal: buzon.guardados.length,
      historyId: String(buzon.historyId),
    });
  });

  // 2. users.messages.list (del más nuevo al más viejo, como Gmail)
  api.get('/messages', (req, res) => {
    const maximo = cantidadMaxima(req.query.maxResults);
    const desde = posicion(req.query.pageToken);
    const filtro = filtroDe(texto(req.query.q));
    if (maximo === undefined)
      return void res.status(400).json(argumentoInvalido('Invalid maxResults'));
    if (desde === undefined)
      return void res.status(400).json(argumentoInvalido('Invalid pageToken'));
    if (!filtro) return void res.status(400).json(argumentoInvalido('Invalid query'));
    if (!cobrar(res, 'messages.list')) return;

    const buzon = res.locals.buzon as Buzon;
    const encontrados = buzon.guardados
      .filter((g) => filtro(g.de, Number(g.mensaje.internalDate)))
      .reverse();
    const pagina = encontrados.slice(desde, desde + maximo);
    const siguiente = desde + maximo < encontrados.length ? String(desde + maximo) : undefined;
    // Sin resultados, Gmail omite messages y nextPageToken.
    res.json({
      ...(pagina.length > 0
        ? { messages: pagina.map((g) => ({ id: g.mensaje.id, threadId: g.mensaje.threadId })) }
        : {}),
      ...(siguiente ? { nextPageToken: siguiente } : {}),
      resultSizeEstimate: encontrados.length,
    });
  });

  // 3. users.messages.get (format=full por defecto; minimal sin payload)
  api.get('/messages/:id', (req: Request<{ userId: string; id: string }>, res) => {
    const formato = texto(req.query.format) || 'full';
    if (formato !== 'full' && formato !== 'minimal') {
      return void res.status(400).json(argumentoInvalido(`Invalid format: ${formato}`));
    }
    if (!cobrar(res, formato === 'full' ? 'messages.get.full' : 'messages.get')) return;
    const buzon = res.locals.buzon as Buzon;
    const guardado = buzon.guardados.find((g) => g.mensaje.id === req.params.id);
    if (!guardado) return void res.status(404).json(noEncontrado());
    if (formato === 'minimal') {
      // minimal: el mensaje sin payload.
      return void res.json({ ...guardado.mensaje, payload: undefined });
    }
    res.json(guardado.mensaje);
  });

  // 4. users.history.list (solo historyTypes=messageAdded)
  api.get('/history', (req, res) => {
    const inicio = texto(req.query.startHistoryId);
    const maximo = cantidadMaxima(req.query.maxResults);
    const desde = posicion(req.query.pageToken);
    const tipos = req.query.historyTypes;
    if (!/^\d+$/.test(inicio)) {
      return void res.status(400).json(argumentoInvalido('startHistoryId is required'));
    }
    if (maximo === undefined || desde === undefined) {
      return void res.status(400).json(argumentoInvalido('Invalid maxResults or pageToken'));
    }
    if (tipos !== undefined && tipos !== 'messageAdded') {
      return void res.status(400).json(argumentoInvalido('The mock only supports messageAdded'));
    }
    if (!cobrar(res, 'history.list')) return;

    const buzon = res.locals.buzon as Buzon;
    // Un startHistoryId demasiado viejo: 404 y el adaptador hace una sincronización completa.
    if (Number(inicio) < buzon.historyIdInicial) return void res.status(404).json(noEncontrado());
    const cambios = buzon.historial.filter((h) => h.id > Number(inicio));
    const pagina = cambios.slice(desde, desde + maximo);
    const siguiente = desde + maximo < cambios.length ? String(desde + maximo) : undefined;
    const mensajes = new Map(buzon.guardados.map((g) => [g.mensaje.id, g.mensaje]));
    // Sin cambios, Gmail omite history y devuelve solo el historyId actual.
    res.json({
      ...(pagina.length > 0
        ? {
            history: pagina.flatMap((h) => {
              const m = mensajes.get(h.mensajeId);
              if (!m) return [];
              return {
                id: String(h.id),
                messages: [{ id: m.id, threadId: m.threadId }],
                messagesAdded: [
                  { message: { id: m.id, threadId: m.threadId, labelIds: m.labelIds } },
                ],
              };
            }),
          }
        : {}),
      ...(siguiente ? { nextPageToken: siguiente } : {}),
      historyId: String(buzon.historyId),
    });
  });

  // 5. users.watch
  const esquemaWatch = z.object({
    topicName: z.string().regex(/^projects\/[^/]+\/topics\/[^/]+$/),
    labelIds: z.array(z.string()).optional(),
    labelFilterBehavior: z.enum(['include', 'exclude', 'INCLUDE', 'EXCLUDE']).optional(),
  });
  api.post('/watch', express.json(), (req, res) => {
    const datos = esquemaWatch.safeParse(req.body);
    if (!datos.success) return void res.status(400).json(argumentoInvalido('Invalid topicName'));
    if (!cobrar(res, 'watch')) return;
    const buzon = res.locals.buzon as Buzon;
    buzon.watch = {
      topicName: datos.data.topicName,
      labelIds: datos.data.labelIds ?? [],
      excluir: datos.data.labelFilterBehavior?.toLowerCase() === 'exclude',
      expiration: reloj() + VIDA_WATCH_MS,
    };
    // Un watch exitoso manda enseguida una notificación.
    avisos.avisar(buzon.email, buzon.historyId, buzon.watch.topicName);
    res.json({ historyId: String(buzon.historyId), expiration: String(buzon.watch.expiration) });
  });

  app.use('/gmail/v1/users/:userId', api);

  // --- Administración (solo para pruebas, rutas de mocks/comun) ----------------------------------

  const admin = crearRutasAdmin(
    {
      resumen: () =>
        almacen.todos().map((b) => ({
          email: b.email,
          correos: b.guardados.length,
          historyId: String(b.historyId),
          watch: Boolean(b.watch && b.watch.expiration > reloj()),
        })),
      correos: (email) =>
        almacen.buscar(email)?.guardados.map((g) => ({
          id: g.mensaje.id,
          de: g.de,
          asunto: g.mensaje.payload.headers.find((h) => h.name === 'Subject')?.value ?? '',
          ...(g.etiqueta ? { etiqueta: g.etiqueta } : {}),
        })),
      agregar: (email, correo, etiqueta) => almacen.agregar(email, correo, etiqueta).id,
      extra: (email) => ({ historyId: String(almacen.obtener(email).historyId) }),
      vencerTokens: (email) => oauth.vencerTokens(email),
      revocarTokens: (email) => oauth.revocar(email),
    },
    { reloj, nombreDe: (email) => nombreDe(email, DOMINIO) },
  );

  app.use('/admin', admin);

  // Cuerpo JSON mal formado u otro error inesperado.
  app.use(
    (error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
      const codigo = error.status && error.status < 500 ? error.status : 500;
      if (codigo === 500) logger.error({ err: error }, 'error inesperado');
      res
        .status(codigo)
        .json(
          errorGmail(
            codigo,
            codigo === 500 ? 'Backend Error' : 'Bad Request',
            codigo === 500 ? 'backendError' : 'badRequest',
          ),
        );
    },
  );

  let servidor: Server | undefined;
  return {
    app,
    almacen,
    oauth,
    avisos,
    iniciar: () =>
      new Promise((resolver) => {
        servidor = app.listen(opciones.puerto, () => {
          const puerto = (servidor?.address() as AddressInfo).port;
          logger.info({ puerto }, 'mock de Gmail escuchando');
          resolver(puerto);
        });
      }),
    detener: () =>
      new Promise((resolver) => {
        avisos.detener();
        if (!servidor) return resolver();
        servidor.close(() => resolver());
      }),
  };
}
