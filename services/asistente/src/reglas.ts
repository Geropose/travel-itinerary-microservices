import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@trotamundos/comun';
import { parse } from 'yaml';
import { z } from 'zod';

export type IdiomaAsistente = 'es' | 'en';
export type IntencionDetectada =
  'estado' | 'reprogramar' | 'problemaMenor' | 'derivar' | 'desconocida';

export const DIR_REGLAS_DEFECTO = fileURLToPath(new URL('../config/', import.meta.url));

const esquemaProblemaMenor = z.object({
  palabrasClave: z.array(z.string().min(1)).min(1),
  respuesta: z.string().min(1),
});

const esquemaReglasIdioma = z.object({
  idioma: z.enum(['es', 'en']),
  intenciones: z.object({
    derivar: z.array(z.string().min(1)).min(1),
    reprogramar: z.array(z.string().min(1)).min(1),
    estado: z.array(z.string().min(1)).min(1),
    problemaMenor: z.array(z.string().min(1)).min(1),
    cortesia: z.array(z.string().min(1)).optional(),
  }),
  afirmaciones: z.array(z.string().min(1)).min(1),
  problemasMenores: z.record(z.string().min(1), esquemaProblemaMenor),
  textos: z.object({
    saludo: z.string().min(1),
    repregunta: z.string().min(1),
    derivacionAutomaticaMotivo: z.string().min(1),
    sinReservas: z.string().min(1),
    reservaNoEncontrada: z.string().min(1),
    estadoEncabezado: z.string().min(1),
    estadoUnicaReserva: z.string().min(1),
    pedirNumeroReprogramacion: z.string().min(1),
    reprogramacionSinReservas: z.string().min(1),
    opcionesEncontradas: z.string().min(1),
    sinOpcionesReprogramacion: z.string().min(1),
    confirmacionUsuario: z.string().min(1),
    reprogramadoOk: z.string().min(1),
    opcionRechazada: z.string().min(1),
    consultandoOpciones: z.string().min(1),
    consultandoAplicar: z.string().min(1),
    derivadoOk: z.string().min(1),
    sinAgenciaPreferida: z.string().min(1),
    noDisponibleEstado: z.string().min(1),
    noDisponibleReprogramar: z.string().min(1),
    noDisponibleDerivar: z.string().min(1),
  }),
});

export type ReglasIdioma = z.infer<typeof esquemaReglasIdioma>;

/** Normaliza texto eliminando tildes, signos y pasando a minúsculas para matcheo rápido (~1 ms). */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapaRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Comprueba si `textoNormalizado` contiene `frase` como palabra/frase completa. */
export function contieneFrase(textoNormalizado: string, fraseCruda: string): boolean {
  const frase = normalizarTexto(fraseCruda);
  if (!frase) return false;
  const patron = new RegExp(`(?:^|\\s)${escapaRegex(frase)}(?:\\s|$)`);
  return patron.test(textoNormalizado);
}

/** Reemplaza placeholders `{clave}` en plantillas de `reglas.<idioma>.yaml`. */
export function interpolarTexto(plantilla: string, valores: Record<string, string>): string {
  return plantilla.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, clave: string) => valores[clave] ?? '');
}

// `problemaMenor` va antes que `estado` porque preguntas como "¿Cómo comparto mi itinerario?"
// o "¿Cuánto equipaje lleva mi vuelo?" mencionan "itinerario" o "vuelo" junto a la duda específica.
const ORDEN_INTENCIONES = ['derivar', 'reprogramar', 'problemaMenor', 'estado'] as const;

/** Detecta la intención de un mensaje a partir de las reglas externas (en pocos ms). */
export function detectarIntencionConReglas(
  texto: string,
  reglas: ReglasIdioma,
  ofreceDerivar = false,
): IntencionDetectada {
  const normalizado = normalizarTexto(texto);
  if (!normalizado) return 'desconocida';

  if (ofreceDerivar) {
    for (const af of reglas.afirmaciones) {
      if (contieneFrase(normalizado, af)) {
        return 'derivar';
      }
    }
  }

  for (const intencion of ORDEN_INTENCIONES) {
    const palabras = reglas.intenciones[intencion];
    for (const palabra of palabras) {
      if (contieneFrase(normalizado, palabra)) {
        return intencion;
      }
    }
  }

  // Saludos, agradecimientos, despedidas y preguntas generales se evalúan al final para que
  // mensajes como "Hola, ¿cómo está mi vuelo?" prioricen siempre la intención operativa.
  for (const frase of reglas.intenciones.cortesia ?? []) {
    if (contieneFrase(normalizado, frase)) {
      return 'problemaMenor';
    }
  }

  return 'desconocida';
}

export interface GestorReglas {
  obtener(idioma: IdiomaAsistente): ReglasIdioma;
  estaCargado(): boolean;
  recargar(): void;
}

interface EntradaCache {
  ruta: string;
  mtimeMs: number;
  reglas: ReglasIdioma;
}

/**
 * Carga `reglas.es.yaml` y `reglas.en.yaml` desde disco y los recarga automáticamente sin
 * reiniciar el servicio cada vez que detecta un cambio en el archivo (`mtimeMs`). Si un cambio
 * en caliente es inválido, conserva la última versión válida y registra una advertencia.
 */
export function crearGestorReglas(
  opciones: {
    dirReglas?: string;
    logger?: Logger;
  } = {},
): GestorReglas {
  const dir = opciones.dirReglas ?? DIR_REGLAS_DEFECTO;
  const cache = new Map<IdiomaAsistente, EntradaCache>();

  function cargarArchivo(idioma: IdiomaAsistente): EntradaCache {
    const ruta = join(dir, `reglas.${idioma}.yaml`);
    const stats = statSync(ruta);
    const contenido = readFileSync(ruta, 'utf8');
    const bruto: unknown = parse(contenido);
    const reglas = esquemaReglasIdioma.parse(bruto);
    if (reglas.idioma !== idioma) {
      throw new Error(
        `El archivo ${ruta} declara idioma "${reglas.idioma}" en lugar de "${idioma}".`,
      );
    }
    return { ruta, mtimeMs: stats.mtimeMs, reglas };
  }

  function cargarTodos(): void {
    for (const idioma of ['es', 'en'] as const) {
      cache.set(idioma, cargarArchivo(idioma));
    }
  }

  cargarTodos();

  function obtener(idioma: IdiomaAsistente): ReglasIdioma {
    const actual = cache.get(idioma);
    if (!actual) {
      const cargado = cargarArchivo(idioma);
      cache.set(idioma, cargado);
      return cargado.reglas;
    }
    try {
      const stats = statSync(actual.ruta);
      if (stats.mtimeMs !== actual.mtimeMs) {
        const recargado = cargarArchivo(idioma);
        cache.set(idioma, recargado);
        opciones.logger?.info(
          { idioma, ruta: actual.ruta },
          'Reglas de intenciones recargadas sin reiniciar',
        );
        return recargado.reglas;
      }
    } catch (error) {
      opciones.logger?.warn(
        { err: error, idioma, ruta: actual.ruta },
        'Error al recargar reglas; se mantienen las últimas válidas',
      );
    }
    return actual.reglas;
  }

  function recargar(): void {
    for (const idioma of ['es', 'en'] as const) {
      const actual = cache.get(idioma);
      try {
        cache.set(idioma, cargarArchivo(idioma));
      } catch (error) {
        if (!actual) throw error;
        opciones.logger?.warn({ err: error, idioma }, 'Falló recarga manual de reglas');
      }
    }
  }

  return {
    obtener,
    estaCargado: () => cache.has('es') && cache.has('en'),
    recargar,
  };
}
