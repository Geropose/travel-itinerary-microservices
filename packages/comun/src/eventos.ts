import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';
import modFormatos from 'ajv-formats';
import type { Region } from './config.ts';

/** Eventos de docs/CONVENCIONES.md 4.5, uno por esquema de specs/schemas. */
export const TIPOS_EVENTO = [
  'ReservaDetectada',
  'ReservaActualizada',
  'FiltrosActualizados',
  'IdiomaActualizado',
  'ViajeActualizado',
  'AccesoRechazado',
] as const;
export type TipoEvento = (typeof TIPOS_EVENTO)[number];

/** Sobre común de todos los eventos (specs/schemas/Sobre.json). */
export interface Sobre<D = Record<string, unknown>> {
  eventId: string;
  tipo: TipoEvento;
  version: number;
  ocurridoEn: string;
  region: Region;
  datos: D;
}

/** Carpeta specs/schemas del repositorio. */
export const DIR_SCHEMAS = fileURLToPath(new URL('../../../specs/schemas/', import.meta.url));

/** El evento no cumple su esquema (specs/schemas): no se publica, y si llega se manda a la DLQ. */
export class ErrorEventoInvalido extends Error {
  readonly detalles: string[];
  constructor(detalles: string[]) {
    super(`Evento inválido: ${detalles.join('; ')}`);
    this.name = 'ErrorEventoInvalido';
    this.detalles = detalles;
  }
}

const agregarFormatos = modFormatos.default;

/** Valida sobre y datos de cada evento con ajv contra los esquemas de specs/schemas. */
export class ValidadorEventos {
  readonly #validadores = new Map<string, ValidateFunction>();

  constructor(dirSchemas: string = DIR_SCHEMAS) {
    // Las mismas opciones que las pruebas de contrato (tests/contratos/eventos.test.ts).
    const ajv = new Ajv({ allErrors: true, strictTypes: true, strictTuples: true });
    agregarFormatos(ajv);
    const leer = (nombre: string): object =>
      JSON.parse(readFileSync(join(dirSchemas, `${nombre}.json`), 'utf8')) as object;
    ajv.addSchema(leer('Sobre'), 'Sobre.json');
    for (const tipo of TIPOS_EVENTO) {
      ajv.addSchema(leer(tipo), `${tipo}.json`);
      // El mismo armado que el payload de cada mensaje en specs/asyncapi/eventos.yaml.
      this.#validadores.set(
        tipo,
        ajv.compile({
          allOf: [
            { $ref: 'Sobre.json' },
            {
              type: 'object',
              properties: { tipo: { const: tipo }, datos: { $ref: `${tipo}.json` } },
            },
          ],
        }),
      );
    }
  }

  /** Devuelve el sobre tipado si es válido; si no, lanza ErrorEventoInvalido. */
  validar<D = Record<string, unknown>>(evento: unknown): Sobre<D> {
    const tipo = (evento as { tipo?: unknown } | null)?.tipo;
    const validar = typeof tipo === 'string' ? this.#validadores.get(tipo) : undefined;
    if (!validar) throw new ErrorEventoInvalido([`tipo desconocido: ${String(tipo)}`]);
    if (!validar(evento)) {
      throw new ErrorEventoInvalido(
        (validar.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()),
      );
    }
    return evento as Sobre<D>;
  }
}

let validadorPorDefecto: ValidadorEventos | undefined;

/** Validador sobre specs/schemas, compilado una sola vez por proceso. */
export function validadorEventos(): ValidadorEventos {
  validadorPorDefecto ??= new ValidadorEventos();
  return validadorPorDefecto;
}

/** Arma el sobre de un evento nuevo (versión 1, ahora). */
export function crearEvento<D>(tipo: TipoEvento, datos: D, region: Region): Sobre<D> {
  return {
    eventId: randomUUID(),
    tipo,
    version: 1,
    ocurridoEn: new Date().toISOString(),
    region,
    datos,
  };
}
