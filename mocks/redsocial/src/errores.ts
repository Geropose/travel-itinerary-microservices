// Respuestas de error en el formato de specs/externos/redsocial.md (inspirado en Mastodon).
import type { Response } from 'express';

export function responderNoAutorizado(res: Response): void {
  res.status(401).json({ error: 'The access token is invalid' });
}

export function responderInvalido(res: Response, mensaje: string): void {
  res.status(422).json({ error: `Validation failed: ${mensaje}` });
}

export function responderNoDisponible(res: Response): void {
  res.status(503).json({ error: 'Service temporarily unavailable' });
}
