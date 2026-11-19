// Respuestas de error en el formato de specs/externos/agencia.md (inspirado en Zendesk).
import type { Response } from 'express';

export function responderNoAutorizado(res: Response): void {
  res.status(401).json({
    error: 'Unauthorized',
    description: 'Missing or invalid Bearer token',
  });
}

export function responderInvalido(
  res: Response,
  details: Record<string, { description: string }[]>,
): void {
  res.status(422).json({
    error: 'RecordInvalid',
    description: 'Record validation errors',
    details,
  });
}

export function responderNoDisponible(res: Response): void {
  res.status(503).json({
    error: 'ServiceUnavailable',
    description: 'Simulated travel agency service outage',
  });
}
