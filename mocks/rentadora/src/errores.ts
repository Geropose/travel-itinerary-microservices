// Respuestas de error en el formato de specs/externos/rentadora.md.
import type { Response } from 'express';

export type CodigoErrorRentadora =
  'INVALID_REQUEST' | 'UNAUTHORIZED' | 'BOOKING_NOT_FOUND' | 'SERVICE_UNAVAILABLE';

export function responderError(
  res: Response,
  status: number,
  errorCode: CodigoErrorRentadora,
  message: string,
): void {
  res.status(status).json({ status, errorCode, message });
}
