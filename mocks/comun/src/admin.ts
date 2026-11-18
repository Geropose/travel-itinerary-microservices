// Rutas /admin de los mocks de correo (solo para pruebas, no son parte del formato real): listar
// buzones, inyectar correos generados o escritos a mano, y hacer vencer o revocar tokens.
import { randomInt } from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import type { Correo, Etiqueta } from './correo.ts';
import { crearAzar, generarCorreo, generarLote, TIPOS, type CorreoGenerado } from './generador.ts';

export interface ResumenCorreo {
  id: string;
  de: string;
  asunto: string;
  etiqueta?: Etiqueta;
}

export interface BuzonesAdmin {
  /** GET /admin/buzones: un resumen de cada buzón. */
  resumen(): object[];
  /** GET /admin/buzones/{email}/correos; undefined si el buzón no existe. */
  correos(email: string): ResumenCorreo[] | undefined;
  /** Guarda el correo (crea el buzón si no existe) y devuelve su id. */
  agregar(email: string, correo: Correo, etiqueta: Etiqueta): string;
  /** Datos extra de la respuesta de POST .../correos (por ejemplo, el historyId de Gmail). */
  extra?(email: string): Record<string, unknown>;
  vencerTokens(email: string): number;
  revocarTokens(email: string): number;
}

export interface OpcionesAdmin {
  reloj: () => number;
  /** Nombre del dueño del buzón (underName de las reservas). */
  nombreDe: (email: string) => string;
}

const esquemaCorreo = z.union([
  z.object({
    cantidad: z.number().int().min(1).max(5000),
    semilla: z.number().int().optional(),
    nombre: z.string().min(1).optional(),
  }),
  z.object({
    tipo: z.enum(TIPOS),
    estado: z.enum(['confirmada', 'modificada', 'cancelada']).optional(),
    semilla: z.number().int().optional(),
    nombre: z.string().min(1).optional(),
  }),
  z.object({
    de: z.string().min(3),
    asunto: z.string(),
    texto: z.string(),
    html: z.string().optional(),
  }),
]);

export function crearRutasAdmin(buzones: BuzonesAdmin, { reloj, nombreDe }: OpcionesAdmin): Router {
  const admin = Router();
  admin.use(express.json({ limit: '2mb' }));

  admin.get('/buzones', (_req, res) => {
    res.json(buzones.resumen());
  });

  admin.get('/buzones/:email/correos', (req, res) => {
    const correos = buzones.correos(req.params.email.toLowerCase());
    if (!correos) return void res.status(404).json({ error: 'No existe ese buzón' });
    res.json(correos.map(({ etiqueta, ...resto }) => ({ ...resto, ...etiqueta })));
  });

  // Inyecta correos en un buzón (lo crea si no existe): generados por tipo, un lote mezclado o uno
  // escrito a mano. Si el buzón tiene un aviso activo, sale el aviso.
  admin.post('/buzones/:email/correos', (req, res) => {
    const datos = esquemaCorreo.safeParse(req.body);
    if (!datos.success) return void res.status(400).json({ error: z.prettifyError(datos.error) });
    const email = req.params.email.toLowerCase();
    const ahora = new Date(reloj());
    const cuerpo = datos.data;
    const nombre = ('nombre' in cuerpo && cuerpo.nombre) || nombreDe(email);
    const semilla = ('semilla' in cuerpo && cuerpo.semilla) || randomInt(2 ** 31);

    let generados: CorreoGenerado[];
    if ('cantidad' in cuerpo) {
      generados = generarLote({
        cantidad: cuerpo.cantidad,
        para: email,
        nombre,
        semilla,
        hasta: ahora,
      });
    } else if ('tipo' in cuerpo) {
      const { tipo, estado } = cuerpo;
      generados = [
        generarCorreo(crearAzar(semilla), {
          tipo,
          para: email,
          nombre,
          fecha: ahora,
          ...(estado ? { estado } : {}),
        }),
      ];
    } else {
      const { de, asunto, texto, html } = cuerpo;
      generados = [
        {
          correo: { de, para: email, asunto, fecha: ahora, texto, ...(html ? { html } : {}) },
          etiqueta: { tipo: 'manual' },
        },
      ];
    }
    const correos = generados.map(({ correo, etiqueta }) => ({
      id: buzones.agregar(email, correo, etiqueta),
      ...etiqueta,
    }));
    res.status(201).json({ ...buzones.extra?.(email), correos });
  });

  admin.post('/buzones/:email/vencer-tokens', (req, res) => {
    res.json({ vencidos: buzones.vencerTokens(req.params.email.toLowerCase()) });
  });

  admin.post('/buzones/:email/revocar-tokens', (req, res) => {
    res.json({ revocados: buzones.revocarTokens(req.params.email.toLowerCase()) });
  });

  return admin;
}
