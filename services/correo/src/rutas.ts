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
import { compararSecretos, derivarClaveState, firmarState, verificarState } from './cifrado.ts';
import type { Examinador } from './examinador.ts';
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
  examinador?: Examinador;
  pushGmail?: {
    secreto: string;
    suscripcion: string;
  };
  ahora?: () => number;
}

interface AvisoPubSubGmail {
  message: {
    data: string;
    messageId: string;
  };
  subscription: string;
}

interface AvisoGraphItem {
  id?: string;
  subscriptionId: string;
  clientState?: string;
  changeType: 'created' | 'updated' | 'deleted';
  resourceData: {
    id: string;
  };
}

function decodificarDataPubSub(data: string): { emailAddress: string; historyId: string } | null {
  try {
    const normalizado = data.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const parsed = JSON.parse(Buffer.from(normalizado, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.emailAddress !== 'string' ||
      !obj.emailAddress.trim() ||
      typeof obj.historyId !== 'string' ||
      !obj.historyId.trim()
    ) {
      return null;
    }
    return {
      emailAddress: obj.emailAddress.trim().toLowerCase(),
      historyId: obj.historyId.trim(),
    };
  } catch {
    return null;
  }
}

const errorAvisoNoVerificado = () =>
  new ErrorHttp({
    status: 401,
    tipo: 'aviso-no-verificado',
    titulo: 'Aviso no verificado',
    detalle: 'El secreto del aviso push falta o no coincide.',
  });

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
        const suscripcionId = cuenta.suscripcionId;
        try {
          await gestorTokens.ejecutarConToken(cuenta.id, (ad, accessToken) =>
            ad.desuscribirAvisos
              ? ad.desuscribirAvisos(accessToken, suscripcionId)
              : Promise.resolve(),
          );
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

  // Aviso push de Google Cloud Pub/Sub (specs/openapi/correo.yaml y specs/externos/gmail.md 6).
  app.post('/notificaciones/gmail', async (req, res) => {
    const token = textoQuery(req.query.token);
    const configPush = negocio.pushGmail;
    if (!configPush || !token || !compararSecretos(token, configPush.secreto)) {
      throw errorAvisoNoVerificado();
    }

    const cuerpo = req.body as AvisoPubSubGmail;
    if (cuerpo.subscription !== configPush.suscripcion) {
      logger.warn({ subscription: cuerpo.subscription }, 'suscripción Pub/Sub inesperada');
      throw errorAvisoNoVerificado();
    }

    const datos = decodificarDataPubSub(cuerpo.message.data);
    if (!datos) {
      throw errores.solicitudInvalida('El campo message.data no contiene JSON válido de Gmail.');
    }

    const examinador = negocio.examinador;
    if (!examinador) {
      throw errores.noDisponible('El examinador de correo no está disponible.');
    }

    const ahoraDate = new Date(ahora());
    const messageId = cuerpo.message.messageId;
    const esNuevo = await repositorio.registrarAvisoPushVisto(pool, 'gmail', messageId, ahoraDate);
    if (!esNuevo) {
      res.status(202).end();
      return;
    }

    const cuenta = await repositorio.buscarCuentaPorEmail(pool, 'gmail', datos.emailAddress);
    if (!cuenta) {
      res.status(202).end();
      return;
    }

    try {
      await examinador.encolarPorPush({
        cuentaId: cuenta.id,
        usuarioId: cuenta.usuarioId,
        proveedor: 'gmail',
        email: cuenta.email,
        bloqueadoHasta: cuenta.bloqueadoHasta,
        push: { historyId: datos.historyId },
      });
    } catch (err) {
      await repositorio.eliminarAvisoPushVisto(pool, 'gmail', messageId).catch(() => undefined);
      logger.warn({ err, cuentaId: cuenta.id }, 'no se pudo encolar el aviso push de Gmail');
      throw errores.noDisponible('No se pudo encolar la revisión del buzón.');
    }

    res.status(202).end();
  });

  // Validación URL (validationToken) y change notifications de Microsoft Graph (specs/externos/outlook.md).
  app.post('/notificaciones/outlook', async (req, res) => {
    const validationToken = textoQuery(req.query.validationToken);
    if (validationToken) {
      res.status(200).type('text/plain').send(validationToken);
      return;
    }

    const examinador = negocio.examinador;
    if (!examinador) {
      throw errores.noDisponible('El examinador de correo no está disponible.');
    }

    const cuerpo = req.body as { value?: AvisoGraphItem[] };
    const avisos = Array.isArray(cuerpo?.value) ? cuerpo.value : [];
    const ahoraDate = new Date(ahora());

    const porCuenta = new Map<
      string,
      { cuenta: repositorio.CuentaPushSuscripcion; mensajeIds: string[]; avisoIds: string[] }
    >();

    for (const aviso of avisos) {
      if (aviso.changeType === 'deleted') continue;

      const cuenta = await repositorio.buscarCuentaPorSuscripcion(
        pool,
        claveTokens,
        'outlook',
        aviso.subscriptionId,
      );
      if (
        !cuenta ||
        !cuenta.secretoSuscripcion ||
        !aviso.clientState ||
        !compararSecretos(aviso.clientState, cuenta.secretoSuscripcion)
      ) {
        logger.warn(
          { subscriptionId: aviso.subscriptionId },
          'aviso push de Outlook descartado por clientState inválido o suscripción desconocida',
        );
        continue;
      }

      const grupo = porCuenta.get(cuenta.id) ?? { cuenta, mensajeIds: [], avisoIds: [] };
      grupo.mensajeIds.push(aviso.resourceData.id);
      if (aviso.id && !grupo.avisoIds.includes(aviso.id)) grupo.avisoIds.push(aviso.id);
      porCuenta.set(cuenta.id, grupo);
    }

    for (const { cuenta, mensajeIds, avisoIds } of porCuenta.values()) {
      const registradosCuenta: string[] = [];
      for (const id of avisoIds) {
        const esNuevo = await repositorio.registrarAvisoPushVisto(pool, 'outlook', id, ahoraDate);
        if (esNuevo) registradosCuenta.push(id);
      }
      if (avisoIds.length > 0 && registradosCuenta.length === 0) continue;

      try {
        await examinador.encolarPorPush({
          cuentaId: cuenta.id,
          usuarioId: cuenta.usuarioId,
          proveedor: 'outlook',
          email: cuenta.email,
          bloqueadoHasta: cuenta.bloqueadoHasta,
          push: { mensajeIds },
        });
      } catch (err) {
        for (const id of registradosCuenta) {
          await repositorio.eliminarAvisoPushVisto(pool, 'outlook', id).catch(() => undefined);
        }
        logger.warn({ err, cuentaId: cuenta.id }, 'no se pudo encolar el aviso push de Outlook');
        throw errores.noDisponible('No se pudo encolar el aviso push de Outlook.');
      }
    }

    res.status(202).end();
  });

  app.get('/no-procesados', async (req, res) => {
    const { sub } = autenticacion(req);
    const desdeTexto = textoQuery(req.query.desde);
    const desde = desdeTexto ? new Date(desdeTexto) : undefined;
    const cuentaId = textoQuery(req.query.cuentaId) || undefined;
    const limite = req.query.limite !== undefined ? Number(req.query.limite) : 100;

    const resultado = await repositorio.listarNoProcesados(pool, {
      usuarioId: sub,
      ...(desde ? { desde } : {}),
      ...(cuentaId ? { cuentaId } : {}),
      limite,
    });
    res.json(resultado);
  });
}
