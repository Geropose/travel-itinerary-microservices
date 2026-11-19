// Respuestas de error en el formato de specs/externos/hotel.md.
import type { Response } from 'express';

export type CodigoErrorHotel =
  'INVALID_PARAMETER' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'SERVICE_UNAVAILABLE';

export function responderError(
  res: Response,
  status: number,
  code: CodigoErrorHotel,
  message: string,
): void {
  res.status(status).json({ error: { code, message } });
}
