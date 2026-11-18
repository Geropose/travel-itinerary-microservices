// Formatos de error de Microsoft (specs/externos/outlook.md): el de /token (sección 1.4) y el de
// Graph (secciones 1.5 y 6).
import { randomUUID } from 'node:crypto';

/** Fecha sin milisegundos ni zona, como en innerError.date: 2026-11-28T12:12:30. */
const fechaInterna = (ms: number) => new Date(ms).toISOString().slice(0, 19);

/** Error de Graph: { error: { code, message, innerError } }. */
export function errorGraph(code: string, message: string, ahora: number) {
  return {
    error: { code, message, innerError: { date: fechaInterna(ahora), 'request-id': randomUUID() } },
  };
}

/** 429 de Graph (sección 6), con el mismo orden de campos que el ejemplo. */
export function demasiadasSolicitudes(ahora: number) {
  return {
    error: {
      code: 'TooManyRequests',
      innerError: {
        code: '429',
        date: fechaInterna(ahora),
        message: 'Please retry after',
        'request-id': randomUUID(),
        status: '429',
      },
      message: 'Please retry again later.',
    },
  };
}

/** Error de /token (sección 1.4): el adaptador solo mira `error`. */
export function errorToken(error: string, codigo: number, descripcion: string, ahora: number) {
  return {
    error,
    error_description: `AADSTS${codigo}: ${descripcion}`,
    error_codes: [codigo],
    timestamp: `${new Date(ahora).toISOString().slice(0, 19).replace('T', ' ')}Z`,
    trace_id: randomUUID(),
    correlation_id: randomUUID(),
  };
}
