// Control común de demoras y fallas simuladas para las rutas /admin de los mocks externos
// (aerolínea, hotel, rentadora, agencia y red social): permite simular demoras (p. ej. 4 s para el
// "estoy consultando" del asistente) y fallas (503 o no responder) para degradación controlada.
import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type RequestHandler, type Response, type Router } from 'express';
import { z } from 'zod';

export type ModoFalla = 'ninguna' | '503' | 'no-responder';

export interface EstadoComportamiento {
  demoraMs: number;
  modoFalla: ModoFalla;
}

export interface ControlComportamiento {
  obtener(): EstadoComportamiento;
  configurar(parcial: Partial<EstadoComportamiento>): EstadoComportamiento;
  reiniciar(): EstadoComportamiento;
  /** Cancela demoras y solicitudes retenidas en "no-responder" para apagar el servidor limpio. */
  detener(): void;
  registrarPendiente(cancelar: () => void): () => void;
}

export function crearControlComportamiento(): ControlComportamiento {
  let estado: EstadoComportamiento = { demoraMs: 0, modoFalla: 'ninguna' };
  const pendientes = new Set<() => void>();

  return {
    obtener: () => ({ ...estado }),
    configurar(parcial) {
      estado = {
        demoraMs: parcial.demoraMs ?? estado.demoraMs,
        modoFalla: parcial.modoFalla ?? estado.modoFalla,
      };
      return { ...estado };
    },
    reiniciar() {
      estado = { demoraMs: 0, modoFalla: 'ninguna' };
      for (const cancelar of pendientes) cancelar();
      pendientes.clear();
      return { ...estado };
    },
    detener() {
      for (const cancelar of pendientes) cancelar();
      pendientes.clear();
    },
    registrarPendiente(cancelar) {
      pendientes.add(cancelar);
      return () => {
        pendientes.delete(cancelar);
      };
    },
  };
}

/**
 * Middleware para rutas de negocio del mock (nunca sobre /health ni /admin).
 * Aplica demora configurable y falla simulada (503 con el formato del proveedor o no responder).
 * Escucha `res.once('close')` (y no `req.once('close')`) porque en POST con cuerpo `express.json()`
 * consume `req` hasta EOF y dispara el cierre de `req` antes de que salga la respuesta.
 */
export function crearMiddlewareComportamiento(
  control: ControlComportamiento,
  responder503: (res: Response) => void,
): RequestHandler {
  return (_req, res, next) => {
    const { demoraMs, modoFalla } = control.obtener();

    if (modoFalla === 'no-responder') {
      const liberar = control.registrarPendiente(() => {
        if (!res.writableEnded) res.destroy();
      });
      res.once('close', liberar);
      return;
    }

    const continuar = () => {
      if (res.writableEnded || res.destroyed) return;
      if (modoFalla === '503') {
        responder503(res);
        return;
      }
      next();
    };

    if (demoraMs <= 0) {
      continuar();
      return;
    }

    let liberado = false;
    const temporizador = setTimeout(() => {
      if (liberado) return;
      liberado = true;
      quitar();
      continuar();
    }, demoraMs);

    const cancelar = () => {
      if (liberado) return;
      liberado = true;
      clearTimeout(temporizador);
      quitar();
      if (!res.writableEnded) res.destroy();
    };
    const quitar = control.registrarPendiente(cancelar);
    res.once('close', () => {
      if (!liberado) {
        liberado = true;
        clearTimeout(temporizador);
        quitar();
      }
    });
  };
}

const esquemaComportamiento = z.object({
  demoraMs: z.number().int().min(0).max(60_000).optional(),
  modoFalla: z.enum(['ninguna', '503', 'no-responder']).optional(),
});

/** Monta GET/PUT/POST/DELETE /comportamiento dentro del router /admin de cada mock. */
export function montarRutasComportamiento(admin: Router, control: ControlComportamiento): void {
  admin.use(express.json({ limit: '2mb' }));

  admin.get('/comportamiento', (_req, res) => {
    res.json(control.obtener());
  });

  const actualizar: RequestHandler = (req, res) => {
    const datos = esquemaComportamiento.safeParse(req.body ?? {});
    if (!datos.success) return void res.status(400).json({ error: z.prettifyError(datos.error) });
    res.json(
      control.configurar({
        ...(datos.data.demoraMs !== undefined ? { demoraMs: datos.data.demoraMs } : {}),
        ...(datos.data.modoFalla !== undefined ? { modoFalla: datos.data.modoFalla } : {}),
      }),
    );
  };

  admin.put('/comportamiento', actualizar);
  admin.post('/comportamiento', actualizar);

  admin.delete('/comportamiento', (_req, res) => {
    res.json(control.reiniciar());
  });
}

/** Comparación en tiempo constante (por hash SHA-256) para claves de API y tokens de los mocks. */
export function compararSeguro(recibido: string, esperado: string): boolean {
  const hashA = createHash('sha256').update(recibido).digest();
  const hashB = createHash('sha256').update(esperado).digest();
  return timingSafeEqual(hashA, hashB);
}

/** Extrae el token de `Authorization: Bearer <token>`, o undefined si no tiene ese formato. */
export function leerBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/** Comprueba que el texto sea una fecha ISO 8601 con fecha y hora parseable. */
export function esFechaIsoValida(valor: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(valor)) {
    return false;
  }
  return !Number.isNaN(Date.parse(valor));
}
