// Cliente de API tipado con los contratos de specs/openapi (tipos en ./generado, npm run web:api).
// Habla con el enrutador global: agrega el JWT, lo renueva cuando vence y manda la región
// recordada en X-Region para que el enrutador elija la región antes de tener JWT (Iteración 6).
import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { paths as Analitica } from './generado/analitica.ts';
import type { paths as Asistente } from './generado/asistente.ts';
import type { paths as Autenticacion } from './generado/autenticacion.ts';
import type { paths as Correo } from './generado/correo.ts';
import type { paths as Integraciones } from './generado/integraciones.ts';
import type { paths as Usuarios } from './generado/usuarios.ts';
import type { paths as Viajes } from './generado/viajes.ts';
import type { Sesion } from './sesion.ts';

/** Header de la región recordada (comun.yaml, XRegion). El gateway le permite CORS. */
export const HEADER_REGION = 'X-Region';

/** Rutas de Autenticación que no llevan JWT: la región la elige X-Region (o la por defecto). */
const SIN_JWT = new Set(['/login', '/registro', '/renovar', '/.well-known/jwks.json']);

export interface OpcionesApi {
  /** URL del enrutador global (VITE_URL_API). */
  urlBase: string;
  sesion: Sesion;
  /** fetch a usar (las pruebas pasan uno falso). */
  fetch?: typeof fetch;
  /** Se llama cuando la sesión venció y no se pudo renovar (recibe el sub vencido para limpiar caché). */
  alVencer?: (sub?: string) => void;
}

export interface Api {
  autenticacion: Client<Autenticacion>;
  usuarios: Client<Usuarios>;
  correo: Client<Correo>;
  viajes: Client<Viajes>;
  integraciones: Client<Integraciones>;
  analitica: Client<Analitica>;
  asistente: Client<Asistente>;
  /** Pide un JWT nuevo con el token de renovación. Si hay una renovación en curso, la reutiliza. */
  renovar(): Promise<boolean>;
}

export function crearApi(o: OpcionesApi): Api {
  const hacerFetch = (pedido: Request) => (o.fetch ?? globalThis.fetch)(pedido);
  const clienteDe = <P extends object>(servicio: string) =>
    createClient<P>({ baseUrl: `${o.urlBase}/api/${servicio}`, fetch: hacerFetch });

  // Sin middleware: renovar no puede depender de sí mismo.
  const renovador = clienteDe<Autenticacion>('autenticacion');
  let renovando: Promise<boolean> | undefined;

  function renovar(): Promise<boolean> {
    renovando ??= (async () => {
      const actual = o.sesion.obtener();
      if (!actual) return false;
      const region = o.sesion.region();
      try {
        const { data, response } = await renovador.POST('/renovar', {
          body: { tokenRenovacion: actual.tokenRenovacion },
          headers: region ? { [HEADER_REGION]: region } : {},
        });
        if (o.sesion.obtener()?.tokenRenovacion !== actual.tokenRenovacion) {
          return false;
        }
        if (data) {
          o.sesion.actualizarJwt(data.jwt);
          return true;
        }
        if (response.status !== 401 && response.status !== 400) {
          return false;
        }
      } catch {
        // Sin red: la sesión sigue; se vuelve a intentar en la próxima solicitud.
        return false;
      }
      if (o.sesion.obtener()?.tokenRenovacion !== actual.tokenRenovacion) {
        return false;
      }
      const subVencido = o.sesion.claims()?.sub;
      // El token de renovación venció o se revocó: hay que iniciar sesión de nuevo.
      o.sesion.cerrar();
      o.alVencer?.(subVencido);
      return false;
    })().finally(() => {
      renovando = undefined;
    });
    return renovando;
  }

  // Copia de cada solicitud con JWT, para repetirla si el gateway responde 401 (el cuerpo de la
  // original ya se leyó).
  const copias = new WeakMap<Request, Request>();

  const middleware = (servicio: string): Middleware => ({
    async onRequest({ request, schemaPath }) {
      const region = o.sesion.region();
      if (region) request.headers.set(HEADER_REGION, region);
      if (servicio === 'autenticacion' && SIN_JWT.has(schemaPath)) return request;
      if (o.sesion.obtener() && o.sesion.vencido()) await renovar();
      const jwt = o.sesion.obtener()?.jwt;
      if (!jwt) return request;
      request.headers.set('Authorization', `Bearer ${jwt}`);
      copias.set(request, request.clone());
      return request;
    },
    async onResponse({ request, response }) {
      const copia = copias.get(request);
      if (response.status !== 401 || !copia) return response;
      // El JWT venció en el camino (o el reloj está corrido): se renueva y se repite una vez.
      if (!(await renovar())) return response;
      const jwt = o.sesion.obtener()?.jwt;
      if (!jwt) return response;
      copia.headers.set('Authorization', `Bearer ${jwt}`);
      return hacerFetch(copia);
    },
  });

  const conMiddleware = <P extends object>(servicio: string): Client<P> => {
    const cliente = clienteDe<P>(servicio);
    cliente.use(middleware(servicio));
    return cliente;
  };

  return {
    autenticacion: conMiddleware<Autenticacion>('autenticacion'),
    usuarios: conMiddleware<Usuarios>('usuarios'),
    correo: conMiddleware<Correo>('correo'),
    viajes: conMiddleware<Viajes>('viajes'),
    integraciones: conMiddleware<Integraciones>('integraciones'),
    analitica: conMiddleware<Analitica>('analitica'),
    asistente: conMiddleware<Asistente>('asistente'),
    renovar,
  };
}
