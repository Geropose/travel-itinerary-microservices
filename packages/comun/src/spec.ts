import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';

type Nodo = unknown;
type Objeto = Record<string, unknown>;

const METODOS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Una operación del contrato, con su seguridad ya resuelta. */
export interface Operacion {
  metodo: string;
  /** Ruta como está en el spec, por ejemplo /viajes/{viajeId} */
  ruta: string;
  operationId: string | undefined;
  /**
   * Esquemas aceptados (bearerJWT, tokenServicio). Vacío: ruta pública (security: []).
   * Si hay más de uno, alcanza con cualquiera.
   */
  seguridad: string[];
}

export interface Spec {
  /** El contrato con los $ref a comun.yaml ya resueltos y servidor "/" (para el validador). */
  documento: Objeto;
  operaciones: Operacion[];
  /** Operación que corresponde a una solicitud, o undefined si la ruta no está en el contrato. */
  buscar(metodo: string, ruta: string): Operacion | undefined;
}

const esObjeto = (nodo: Nodo): nodo is Objeto =>
  typeof nodo === 'object' && nodo !== null && !Array.isArray(nodo);

function leerYaml(archivo: string, cache: Map<string, Nodo>): Nodo {
  let doc = cache.get(archivo);
  if (doc === undefined) {
    doc = parse(readFileSync(archivo, 'utf8')) as Nodo;
    cache.set(archivo, doc);
  }
  return doc;
}

function seguirPuntero(doc: Nodo, puntero: string): Nodo {
  const partes = puntero
    .replace(/^\//, '')
    .split('/')
    .filter(Boolean)
    .map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'));
  let actual = doc;
  for (const parte of partes) {
    if (!esObjeto(actual) && !Array.isArray(actual)) throw new Error(`$ref inválido: ${puntero}`);
    actual = (actual as Objeto)[parte];
  }
  if (actual === undefined) throw new Error(`$ref no encontrado: ${puntero}`);
  return actual;
}

/**
 * Copia el documento reemplazando los $ref a otros archivos (./comun.yaml#/...) por su contenido.
 * Los $ref internos del archivo principal quedan como están; los internos de otro archivo también
 * se reemplazan, porque fuera de ese archivo no significan nada.
 */
function resolverRefs(
  nodo: Nodo,
  archivo: string,
  principal: string,
  cache: Map<string, Nodo>,
  profundidad = 0,
): Nodo {
  if (profundidad > 50) throw new Error('Demasiados $ref anidados');
  if (Array.isArray(nodo))
    return nodo.map((n) => resolverRefs(n, archivo, principal, cache, profundidad));
  if (!esObjeto(nodo)) return nodo;
  const ref = nodo.$ref;
  if (typeof ref === 'string') {
    const [parteArchivo = '', puntero = ''] = ref.split('#');
    const destino = parteArchivo ? resolve(dirname(archivo), parteArchivo) : archivo;
    if (destino !== principal) {
      const resto: Objeto = { ...nodo };
      delete resto.$ref;
      const contenido = seguirPuntero(leerYaml(destino, cache), puntero);
      const resuelto = resolverRefs(contenido, destino, principal, cache, profundidad + 1);
      return esObjeto(resuelto) ? { ...resuelto, ...resto } : resuelto;
    }
    if (parteArchivo) return { ...nodo, $ref: `#${puntero}` };
  }
  const copia: Objeto = {};
  for (const [clave, valor] of Object.entries(nodo)) {
    copia[clave] = resolverRefs(valor, archivo, principal, cache, profundidad);
  }
  return copia;
}

function aRegex(ruta: string): RegExp {
  const escapada = ruta
    .split(/\{[^}]+\}/)
    .map((tramo) => tramo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${escapada}/?$`);
}

function nombresSeguridad(requisitos: unknown): string[] {
  if (!Array.isArray(requisitos)) return [];
  return [...new Set(requisitos.flatMap((r) => (esObjeto(r) ? Object.keys(r) : [])))];
}

/**
 * Lee specs/openapi/<servicio>.yaml. Deja un único servidor "/" (el servicio atiende sus rutas
 * sin el prefijo /api/<servicio>, que pone el gateway) y calcula la seguridad de cada operación.
 */
export function cargarSpec(rutaSpec: string): Spec {
  const principal = resolve(rutaSpec);
  const cache = new Map<string, Nodo>();
  const documento = resolverRefs(leerYaml(principal, cache), principal, principal, cache) as Objeto;
  documento.servers = [{ url: '/' }];
  const seguridadGeneral = documento.security;
  const operaciones: (Operacion & { regex: RegExp; parametros: number })[] = [];
  const rutas = esObjeto(documento.paths) ? documento.paths : {};
  for (const [ruta, item] of Object.entries(rutas)) {
    if (!esObjeto(item)) continue;
    delete item.servers;
    for (const metodo of METODOS) {
      const op = item[metodo];
      if (!esObjeto(op)) continue;
      delete op.servers;
      operaciones.push({
        metodo: metodo.toUpperCase(),
        ruta,
        operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
        seguridad: nombresSeguridad(op.security ?? seguridadGeneral),
        regex: aRegex(ruta),
        parametros: (ruta.match(/\{/g) ?? []).length,
      });
    }
  }
  // Las rutas fijas ganan a las que tienen parámetros (/viajes/proximos antes que /viajes/{viajeId}).
  operaciones.sort((a, b) => a.parametros - b.parametros);
  return {
    documento,
    operaciones: operaciones.map(({ metodo, ruta, operationId, seguridad }) => ({
      metodo,
      ruta,
      operationId,
      seguridad,
    })),
    buscar(metodo, ruta) {
      const m = metodo.toUpperCase();
      const op = operaciones.find((o) => o.metodo === m && o.regex.test(ruta));
      return (
        op && {
          metodo: op.metodo,
          ruta: op.ruta,
          operationId: op.operationId,
          seguridad: op.seguridad,
        }
      );
    },
  };
}
