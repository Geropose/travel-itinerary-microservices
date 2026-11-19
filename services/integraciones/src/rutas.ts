import express, { type Express } from 'express';
import {
  ErrorHttp,
  errores,
  type Logger,
  type Pool,
  type ReglaRuta,
  type Servidor,
} from '@trotamundos/comun';
import type { RegistroAdaptadoresProveedores } from './adaptadores/registro.ts';
import { ErrorCuerpoNoJson, ErrorFirmaInvalida } from './adaptadores/tipos.ts';
import type { ProcesadorProveedores } from './procesador.ts';
import * as repositorio from './repositorio.ts';

/**
 * Reglas del Validador de Intercepción para rutas internas con token de servicio
 * (specs/openapi/integraciones.yaml).
 */
export const REGLAS_VALIDADOR_INTEGRACIONES: Record<string, ReglaRuta> = {
  'GET /interna/no-traducidos': { servicios: ['pruebas'] },
};

export interface NegocioIntegraciones {
  pool: Pool;
  registro: RegistroAdaptadoresProveedores;
  procesador: ProcesadorProveedores;
  logger: Logger;
}

const PATRON_PROVEEDOR = /^[a-z0-9-]+$/;

/**
 * Registra `POST /webhooks/proveedores/:proveedor` ANTES de `express.json()` y de
 * `OpenApiValidator.middleware`:
 * 1. Verifica HMAC-SHA256 sobre los bytes exactos que llegaron (sin re-serializar JSON).
 * 2. Responde 401 (`firma-invalida`) si la firma falta, es inválida o venció.
 * 3. Si la firma es válida pero el cuerpo no es JSON, lo guarda en `no_traducidos` con su tamaño y
 *    responde 400.
 * 4. Si la firma es válida y es JSON pero no se puede traducir, lo guarda en `no_traducidos` sin
 *    datos personales y responde 200 `{ estado: "no-traducido" }`.
 */
export function registrarRutasAntesDelContrato(app: Express, negocio: NegocioIntegraciones): void {
  app.post(
    '/webhooks/proveedores/:proveedor',
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req, res) => {
      const proveedor = req.params.proveedor ?? '';
      if (!PATRON_PROVEEDOR.test(proveedor)) {
        throw errores.noEncontrado(`No existe un proveedor registrado con el nombre ${proveedor}.`);
      }

      const adaptador = negocio.registro.obtener(proveedor);
      if (!adaptador || adaptador.modo !== 'aviso') {
        throw errores.noEncontrado(
          `El proveedor ${proveedor} no existe o no recibe avisos por webhook.`,
        );
      }

      const cuerpoCrudo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      let mensaje: unknown;
      try {
        ({ mensaje } = adaptador.recibirAviso(cuerpoCrudo, req.headers));
      } catch (error) {
        if (error instanceof ErrorFirmaInvalida) {
          throw new ErrorHttp({
            status: 401,
            tipo: 'firma-invalida',
            titulo: 'Firma inválida',
            detalle: error.message,
          });
        }
        if (error instanceof ErrorCuerpoNoJson) {
          await negocio.procesador.registrarCuerpoNoJson(
            adaptador.nombre,
            error.tamanoBytes,
            'webhook',
          );
          throw errores.solicitudInvalida('El cuerpo del aviso no es JSON válido.');
        }
        throw error;
      }

      const estado = await negocio.procesador.procesarMensaje(adaptador, mensaje, 'webhook');
      res.status(200).json({ estado });
    },
  );
}

/** Registra las rutas del contrato validadas por el Validador de Intercepción y OpenAPI. */
export function registrarRutas(servidor: Servidor, negocio: NegocioIntegraciones): void {
  servidor.app.get('/interna/no-traducidos', async (req, res) => {
    const proveedor = typeof req.query.proveedor === 'string' ? req.query.proveedor : undefined;
    const desde = typeof req.query.desde === 'string' ? req.query.desde : undefined;
    const limiteCrudo = req.query.limite;
    const limite =
      typeof limiteCrudo === 'number'
        ? limiteCrudo
        : typeof limiteCrudo === 'string' && limiteCrudo.length > 0
          ? Number(limiteCrudo)
          : undefined;

    const mensajes = await repositorio.listarNoTraducidos(negocio.pool, {
      ...(proveedor ? { proveedor } : {}),
      ...(desde ? { desde } : {}),
      ...(limite !== undefined && Number.isFinite(limite) ? { limite } : {}),
    });

    res.json({ mensajes });
  });
}
