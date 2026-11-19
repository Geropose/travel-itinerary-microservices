// Anonimizador regional del Servicio de Analítica (Iteración 6, ADR-016, ADR-017, CONST-6):
// - Corre dentro de cada región y procesa únicamente eventos ViajeActualizado de su propia región.
// - Reemplaza numeroReserva por codigoReserva = HMAC-SHA256(numeroReserva, SECRETO_ANALITICA) en
//   hexadecimal en minúscula (64 caracteres); el secreto nunca sale de la región.
// - Recorta inicio y fin a fecha pura YYYY-MM-DD sin hora para evitar re-identificación.
// - Quita cualquier dato personal o campo extra y valida estrictamente cada fila contra
//   specs/schemas/ViajeAnonimizado.json (additionalProperties: false) antes de guardarla.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIR_SCHEMAS, type Region, type Sobre } from '@trotamundos/comun';
import { Ajv, type ValidateFunction } from 'ajv';
import modFormatos from 'ajv-formats';
import type { ViajeActualizadoDatos, ViajeAnonimizado } from './modelo.ts';

const agregarFormatos = modFormatos.default;

/** Error lanzado cuando una fila no cumple specs/schemas/ViajeAnonimizado.json (o trae campos extra). */
export class ErrorFilaAnonimizadaInvalida extends Error {
  readonly detalles: string[];

  constructor(detalles: string[]) {
    super(`Fila anonimizada inválida: ${detalles.join('; ')}`);
    this.name = 'ErrorFilaAnonimizadaInvalida';
    this.detalles = detalles;
  }
}

let validadorCompilado: ValidateFunction | undefined;

function obtenerValidadorAnonimizado(): ValidateFunction {
  if (!validadorCompilado) {
    const ajv = new Ajv({ allErrors: true, strictTypes: true, strictTuples: true });
    agregarFormatos(ajv);
    const esquema = JSON.parse(
      readFileSync(join(DIR_SCHEMAS, 'ViajeAnonimizado.json'), 'utf8'),
    ) as object;
    validadorCompilado = ajv.compile(esquema);
  }
  return validadorCompilado;
}

/** Calcula codigoReserva = HMAC-SHA256(numeroReserva, secreto) en hexadecimal en minúsculas. */
export function calcularCodigoReserva(numeroReserva: string, secretoAnalitica: string): string {
  if (!numeroReserva || numeroReserva.trim().length === 0) {
    throw new ErrorFilaAnonimizadaInvalida(['numeroReserva no puede estar vacío']);
  }
  if (!secretoAnalitica || secretoAnalitica.length === 0) {
    throw new Error('SECRETO_ANALITICA no puede estar vacío.');
  }
  return createHmac('sha256', secretoAnalitica).update(numeroReserva, 'utf8').digest('hex');
}

/** Convierte un timestamp ISO 8601 (o fecha YYYY-MM-DD) a fecha UTC pura YYYY-MM-DD sin hora. */
export function aFechaSinHora(valor: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    const verificado = new Date(`${valor}T00:00:00Z`);
    if (!Number.isNaN(verificado.getTime()) && verificado.toISOString().startsWith(valor)) {
      return valor;
    }
    throw new ErrorFilaAnonimizadaInvalida([`fecha inválida: ${valor}`]);
  }
  const fecha = new Date(valor);
  if (Number.isNaN(fecha.getTime())) {
    throw new ErrorFilaAnonimizadaInvalida([`fecha inválida: ${valor}`]);
  }
  return fecha.toISOString().slice(0, 10);
}

/**
 * Valida estrictamente una fila contra specs/schemas/ViajeAnonimizado.json antes de persistirla.
 * Si falta un campo obligatorio, un formato no coincide o existe cualquier campo adicional
 * (usuarioId, email, nombre, numeroReserva, etc.), lanza ErrorFilaAnonimizadaInvalida.
 */
export function validarViajeAnonimizado(fila: unknown): ViajeAnonimizado {
  const validar = obtenerValidadorAnonimizado();
  if (!validar(fila)) {
    const detalles = (validar.errors ?? []).map((e) => {
      const extra =
        e.keyword === 'additionalProperties' &&
        typeof (e.params as { additionalProperty?: unknown }).additionalProperty === 'string'
          ? ` (${(e.params as { additionalProperty: string }).additionalProperty})`
          : '';
      return `${e.instancePath || '/'} ${e.message ?? ''}${extra}`.trim();
    });
    throw new ErrorFilaAnonimizadaInvalida(detalles);
  }
  const valida = fila as ViajeAnonimizado;
  if (valida.fin < valida.inicio) {
    throw new ErrorFilaAnonimizadaInvalida(['/fin debe ser igual o posterior a /inicio']);
  }
  return valida;
}

/**
 * Transforma un evento ViajeActualizado en una fila ViajeAnonimizado lista para la base global:
 * - Verifica residencia de datos (solo eventos de la región del anonimizador, CONST-6).
 * - Reemplaza numeroReserva por HMAC-SHA256(numeroReserva, secretoAnalitica).
 * - Recorta inicio y fin a fecha sin hora (YYYY-MM-DD).
 * - Descarta cualquier campo personal o ajeno al esquema y valida contra ViajeAnonimizado.json.
 */
export function anonimizarViajeActualizado(
  sobre: Sobre<ViajeActualizadoDatos>,
  secretoAnalitica: string,
  regionEsperada?: Region,
): ViajeAnonimizado {
  if (regionEsperada && sobre.region !== regionEsperada) {
    throw new ErrorFilaAnonimizadaInvalida([
      `región del evento (${sobre.region}) no coincide con la región del anonimizador (${regionEsperada})`,
    ]);
  }

  const { datos } = sobre;
  const codigoReserva = calcularCodigoReserva(datos.numeroReserva, secretoAnalitica);
  const inicio = aFechaSinHora(datos.inicio);
  const fin = aFechaSinHora(datos.fin);
  const origen =
    typeof datos.origen === 'string' && datos.origen.trim().length > 0
      ? datos.origen.trim()
      : undefined;

  const fila: ViajeAnonimizado = {
    codigoReserva,
    region: sobre.region,
    proveedor: datos.proveedor,
    tipoReserva: datos.tipoReserva,
    ...(origen !== undefined ? { origen } : {}),
    destino: datos.destino,
    inicio,
    fin,
    estado: datos.estado,
    origenCambio: datos.origenCambio,
  };

  return validarViajeAnonimizado(fila);
}
