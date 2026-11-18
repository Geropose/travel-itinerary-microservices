// Sesión del usuario en el navegador: el JWT (15 min), el token de renovación (7 días) y la región
// de la cuenta (Iteración 6). La región se recuerda aunque se cierre la sesión, para mandarla en
// X-Region en el próximo inicio de sesión y que el enrutador global vaya directo a esa región.
import type { components } from './generado/autenticacion.ts';

export type Region = components['schemas']['Sesion']['region'];
export type Idioma = 'es' | 'en';
export type Rol = 'usuario' | 'analista';

export interface Claims {
  sub: string;
  region: Region;
  roles: string[];
  idioma?: Idioma;
  /** Vencimiento en segundos desde 1970. */
  exp: number;
}

export interface DatosSesion {
  jwt: string;
  tokenRenovacion: string;
}

/** Dónde se guarda la sesión: localStorage en el navegador, un Map en las pruebas. */
export interface Almacen {
  getItem(clave: string): string | null;
  setItem(clave: string, valor: string): void;
  removeItem(clave: string): void;
}

const CLAVE_SESION = 'trotamundos.sesion';
const CLAVE_REGION = 'trotamundos.region';
const REGIONES: readonly string[] = ['region-1', 'region-2'];

/** Claims del JWT, sin verificar la firma (la verifica el gateway). undefined si no se puede leer. */
export function leerClaims(jwt: string): Claims | undefined {
  const carga = jwt.split('.')[1];
  if (!carga) return undefined;
  try {
    const base64 = carga.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Claims>;
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return undefined;
    if (!REGIONES.includes(claims.region ?? '')) return undefined;
    return { ...claims, roles: Array.isArray(claims.roles) ? claims.roles : [] } as Claims;
  } catch {
    return undefined;
  }
}

export interface Sesion {
  obtener(): DatosSesion | undefined;
  claims(): Claims | undefined;
  /** Guarda la sesión del login y recuerda su región. */
  guardar(datos: DatosSesion & { region: Region }): void;
  actualizarJwt(jwt: string): void;
  /** Cierra la sesión; la región queda recordada. */
  cerrar(): void;
  region(): Region | undefined;
  recordarRegion(region: Region): void;
  /** ¿El JWT ya venció (o vence dentro del margen)? */
  vencido(margenMs?: number): boolean;
  /** Avisa cada cambio (para React). Devuelve cómo dejar de escuchar. */
  suscribir(alCambiar: () => void): () => void;
}

export function crearSesion(almacen: Almacen, ahora: () => number = Date.now): Sesion {
  const oyentes = new Set<() => void>();
  const avisar = () => oyentes.forEach((oyente) => oyente());
  let cache: { texto: string | null; datos: DatosSesion | undefined } = {
    texto: null,
    datos: undefined,
  };

  function obtener(): DatosSesion | undefined {
    const texto = almacen.getItem(CLAVE_SESION);
    // Mismo objeto mientras no cambie: useSyncExternalStore lo necesita.
    if (texto === cache.texto) return cache.datos;
    let datos: DatosSesion | undefined;
    try {
      const leido = texto ? (JSON.parse(texto) as Partial<DatosSesion>) : undefined;
      datos =
        leido && typeof leido.jwt === 'string' && typeof leido.tokenRenovacion === 'string'
          ? { jwt: leido.jwt, tokenRenovacion: leido.tokenRenovacion }
          : undefined;
    } catch {
      datos = undefined;
    }
    cache = { texto, datos };
    return datos;
  }

  const escribir = (datos: DatosSesion) => {
    almacen.setItem(CLAVE_SESION, JSON.stringify(datos));
    avisar();
  };

  const sesion: Sesion = {
    obtener,
    claims: () => {
      const datos = obtener();
      return datos ? leerClaims(datos.jwt) : undefined;
    },
    guardar: ({ jwt, tokenRenovacion, region }) => {
      almacen.setItem(CLAVE_REGION, region);
      escribir({ jwt, tokenRenovacion });
    },
    actualizarJwt: (jwt) => {
      const datos = obtener();
      if (datos) escribir({ ...datos, jwt });
    },
    cerrar: () => {
      almacen.removeItem(CLAVE_SESION);
      avisar();
    },
    region: () => {
      const region = almacen.getItem(CLAVE_REGION);
      return region && REGIONES.includes(region) ? (region as Region) : undefined;
    },
    recordarRegion: (region) => {
      almacen.setItem(CLAVE_REGION, region);
      avisar();
    },
    vencido: (margenMs = 30_000) => {
      const claims = sesion.claims();
      return !claims || claims.exp * 1000 - margenMs <= ahora();
    },
    suscribir: (alCambiar) => {
      oyentes.add(alCambiar);
      return () => oyentes.delete(alCambiar);
    },
  };
  return sesion;
}
