// Respuestas de error en el formato de specs/externos/aerolinea.md (inspirado en Duffel).
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';

export type CodigoErrorAerolinea =
  | 'unauthorized'
  | 'not_found'
  | 'offer_no_longer_available'
  | 'validation_error'
  | 'service_unavailable';

const TITULOS: Record<CodigoErrorAerolinea, string> = {
  unauthorized: 'Unauthorized',
  not_found: 'Not found',
  offer_no_longer_available: 'Offer no longer available',
  validation_error: 'Validation error',
  service_unavailable: 'Service unavailable',
};

export function responderError(
  res: Response,
  status: number,
  code: CodigoErrorAerolinea,
  message: string,
): void {
  res.status(status).json({
    errors: [{ code, title: TITULOS[code], message }],
    meta: { status, request_id: randomBytes(12).toString('base64url') },
  });
}
