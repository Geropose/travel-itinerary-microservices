// Rutas de conexión OAuth y gestión de buzones de specs/openapi/correo.yaml.
import { randomUUID } from 'node:crypto';
import {
  autenticacion,
  enTransaccion,
  ErrorHttp,
  errores,
  type Logger,
  type Pool,
  type Region,
  type Servidor,
} from '@trotamundos/comun';
import type { Request } from 'express';
import type { RegistroAdaptadores } from './adaptadores/registro.ts';
import { ErrorProveedorCorreo } from './adaptadores/tipos.ts';
import { derivarClaveState, firmarState, verificarState } from './cifrado.ts';
import * as repositorio from './repositorio.ts';
import type { GestorTokens } from './tokens.ts';

const STATE_TTL_MS = 10 * 60_000;

export interface Negocio {
  pool: Pool;
  claveTokens: Buffer;
  adaptadores: RegistroAdaptadores;
  gestorTokens: GestorTokens;
  urlWeb: string;
  logger: Logger;
  ahora?: () => number;
}

const textoQuery = (valor: unknown): string => (typeof valor === 'string' ? valor : '');

export function registrarRutas(servidor: Servidor, region: Region, negocio: Negocio): void {
  const { app } = servidor;
  const { pool, claveTokens, adaptadores, gestorTokens, logger } = negocio;
  const urlWebBase = negocio.urlWeb.replace(/\/+$/, '');
  const claveState = derivarClaveState(claveTokens);
  const ahora = negocio.ahora ?? Date.now;

  app.get('/cuentas-correo', async (req, res) => {
    const { sub } = autenticacion(req);
    const cuentas = await repositorio.listarCuentasUsuario(pool, sub);
    res.json({ cuentas });
  });

  app.post(
    '/cuentas-correo/:proveedorCorreo/conectar',
    async (req: Request<{ proveedorCorreo: string }>, res) => {
      const { sub } = autenticacion(req);
      const proveedor = req.params.proveedorCorreo;
      const adaptador = adaptadores.obtener(proveedor);
      if (!adaptador) {
        throw errores.solicitudInvalida(`Proveedor de correo no soportado: ${proveedor}.`);
      }

      const ahoraMs = ahora();
      const venceEnMs = ahoraMs + STATE_TTL_MS;
      const venceEn = new Date(venceEnMs);
      const nonce = randomUUID();

      await repositorio.crearStateOAuth(pool, {
        nonce,
        usuarioId: sub,
        proveedor,
        venceEn,
      });

      const state = firmarState(claveState, {
        nonce,
        usuarioId: sub,
        region,
        proveedor,
        venceEn: venceEnMs,
      });

      res.json({
        proveedorCorreo: proveedor,
        urlAutorizacion: adaptador.urlAutorizacion(state),
        stateVenceEn: venceEn.toISOString(),
      });
    },
  );

  app.get('/oauth/callback', async (req, res) => {
    const state = textoQuery(req.query.state);
    const datosState = state ? verificarState(claveState, state, region, ahora()) : null;
    const adaptador = datosState ? adaptadores.obtener(datosState.proveedor) : undefined;
    if (!datosState || !adaptador) {
      throw new ErrorHttp({
        status: 400,
        tipo: 'state-invalido',
        titulo: 'State inválido',
        detalle: 'El parámetro state es inválido, venció o corresponde a otra región.',
      });
    }

    const consumido = await repositorio.consumirStateOAuth(pool, {
      nonce: datosState.nonce,
      usuarioId: datosState.usuarioId,
      proveedor: datosState.proveedor,
      ahora: new Date(ahora()),
    });
    if (!consumido) {
      throw new ErrorHttp({
        status: 400,
        tipo: 'state-invalido',
        titulo: 'State inválido',
        detalle: 'El parámetro state ya fue utilizado o venció.',
      });
    }

    const redirigirError = (motivo: string) => {
      res.redirect(
        302,
        `${urlWebBase}/correo?resultado=error&motivo=${encodeURIComponent(motivo)}`,
      );
    };

    const errorProveedor = textoQuery(req.query.error);
    if (errorProveedor) {
      if (errorProveedor === 'invalid_scope') return redirigirError('scope-insuficiente');
      if (errorProveedor === 'temporarily_unavailable' || errorProveedor === 'server_error') {
        return redirigirError('proveedor-no-disponible');
      }
      return redirigirError('permiso-denegado');
    }

    const codigo = textoQuery(req.query.code);
    if (!codigo) {
      return redirigirError('codigo-invalido');
    }

    const scopeQuery = textoQuery(req.query.scope);
    if (
      scopeQuery &&
      adaptador.validarScopeCallback &&
      !adaptador.validarScopeCallback(scopeQuery)
    ) {
      logger.warn(
        { proveedor: adaptador.proveedor },
        'callback OAuth rechazado por scope en query',
      );
      return redirigirError('scope-insuficiente');
    }

    let intercambio;
    try {
      intercambio = await adaptador.canjearCodigo(codigo);
    } catch (err) {
      if (err instanceof ErrorProveedorCorreo) {
        const motivo =
          err.codigo === 'scope-insuficiente'
            ? 'scope-insuficiente'
            : err.codigo === 'codigo-invalido'
              ? 'codigo-invalido'
              : 'proveedor-no-disponible';
        logger.warn({ proveedor: adaptador.proveedor, motivo }, 'fallo en canje de código OAuth');
        return redirigirError(motivo);
      }
      throw err;
    }

    const guardado = await enTransaccion(pool, (db) =>
      repositorio.guardarCuentaConectada(db, claveTokens, {
        usuarioId: datosState.usuarioId,
        proveedor: adaptador.proveedor,
        email: intercambio.perfil.email,
        credenciales: intercambio.credenciales,
        ahora: new Date(ahora()),
      }),
    );

    if (guardado.resultado === 'cuenta-de-otro-usuario') {
      logger.warn({ proveedor: adaptador.proveedor }, 'buzón ya conectado a otro usuario');
      return redirigirError('cuenta-de-otro-usuario');
    }

    try {
      const suscripcion = await adaptador.suscribirAvisos(intercambio.credenciales.accessToken);
      if (suscripcion) {
        await repositorio.guardarSuscripcionCuenta(pool, claveTokens, {
          cuentaId: guardado.cuentaId,
          usuarioId: datosState.usuarioId,
          suscripcion,
          ahora: new Date(ahora()),
        });
      }
    } catch (err) {
      // Si falla la suscripción push, la cuenta igual queda activa para revisión periódica (ADR-010).
      logger.warn(
        {
          cuentaId: guardado.cuentaId,
          proveedor: adaptador.proveedor,
          codigo: err instanceof ErrorProveedorCorreo ? err.codigo : 'inesperado',
        },
        'no se pudo activar la suscripción push al conectar',
      );
    }

    logger.info(
      { cuentaId: guardado.cuentaId, proveedor: adaptador.proveedor },
      'cuenta de correo conectada',
    );
    res.redirect(
      302,
      `${urlWebBase}/correo?resultado=conectada&cuentaId=${encodeURIComponent(guardado.cuentaId)}`,
    );
  });

  app.delete('/cuentas-correo/:cuentaId', async (req: Request<{ cuentaId: string }>, res) => {
    const { sub } = autenticacion(req);
    const cuenta = await repositorio.buscarCuentaParaDesconectar(pool, req.params.cuentaId, sub);
    if (!cuenta) {
      throw errores.noEncontrado('La cuenta de correo no existe.');
    }

    if (cuenta.suscripcionId) {
      const adaptador = adaptadores.obtener(cuenta.proveedor);
      if (adaptador?.desuscribirAvisos) {
        try {
          const tokenVigente = await gestorTokens.obtenerTokenValido(cuenta.id);
          await adaptador.desuscribirAvisos(tokenVigente.accessToken, cuenta.suscripcionId);
        } catch (err) {
          logger.warn(
            {
              cuentaId: cuenta.id,
              proveedor: cuenta.proveedor,
              codigo: err instanceof ErrorProveedorCorreo ? err.codigo : 'inesperado',
            },
            'no se pudo cancelar la suscripción push al desconectar',
          );
        }
      }
    }

    await repositorio.eliminarCuentaUsuario(pool, cuenta.id, sub);
    logger.info({ cuentaId: cuenta.id, proveedor: cuenta.proveedor }, 'cuenta desconectada');
    res.status(204).end();
  });

  // Handshake de validación de suscripción de Microsoft Graph (specs/externos/outlook.md 4.2).
  app.post('/notificaciones/outlook', (req, res) => {
    const validationToken = textoQuery(req.query.validationToken);
    if (validationToken) {
      res.status(200).type('text/plain').send(validationToken);
      return;
    }
    res.status(202).end();
  });
}
