// Gestor de tokens OAuth: descifra tokens bajo demanda, renueva proactivamente antes del
// vencimiento y reintenta una vez ante 401 del proveedor sin exponer credenciales en logs.
import { enTransaccion, type Logger, type Pool } from '@trotamundos/comun';
import type { RegistroAdaptadores } from './adaptadores/registro.ts';
import {
  ErrorProveedorCorreo,
  type AdaptadorCorreo,
  type DesdeRevision,
  type MensajeCorreo,
  type ResultadoListaMensajes,
} from './adaptadores/tipos.ts';
import { desencriptarTexto } from './cifrado.ts';
import * as repositorio from './repositorio.ts';

export class ErrorCuentaNoEncontrada extends Error {
  constructor(cuentaId: string) {
    super(`Cuenta de correo ${cuentaId} no encontrada.`);
    this.name = 'ErrorCuentaNoEncontrada';
  }
}

export class ErrorCuentaSinPermiso extends Error {
  readonly cuentaId: string;

  constructor(cuentaId: string) {
    super(`La cuenta de correo ${cuentaId} perdió el permiso de acceso.`);
    this.name = 'ErrorCuentaSinPermiso';
    this.cuentaId = cuentaId;
  }
}

export interface OpcionesGestorTokens {
  pool: Pool;
  claveTokens: Buffer;
  adaptadores: RegistroAdaptadores;
  logger: Logger;
  margenRenovacionMs: number;
  ahora?: () => number;
}

export interface TokenCuentaResuelto {
  accessToken: string;
  adaptador: AdaptadorCorreo;
  email: string;
}

export interface GestorTokens {
  /** Devuelve un access token vigente; lo renueva si venció o está dentro del margen previo. */
  obtenerTokenValido(
    cuentaId: string,
    opciones?: { forzarSiIgualA?: string },
  ): Promise<TokenCuentaResuelto>;

  /** Ejecuta una operación contra el adaptador y reintenta una vez tras renovar si responde 401. */
  ejecutarConToken<T>(
    cuentaId: string,
    operacion: (adaptador: AdaptadorCorreo, accessToken: string) => Promise<T>,
  ): Promise<T>;

  listarNuevosCuenta(cuentaId: string, desde: DesdeRevision): Promise<ResultadoListaMensajes>;

  leerMensajeCuenta(cuentaId: string, mensajeId: string): Promise<MensajeCorreo>;
}

export function crearGestorTokens(opciones: OpcionesGestorTokens): GestorTokens {
  const { pool, claveTokens, adaptadores, logger, margenRenovacionMs } = opciones;
  const ahora = opciones.ahora ?? Date.now;

  async function obtenerTokenValido(
    cuentaId: string,
    extra?: { forzarSiIgualA?: string },
  ): Promise<TokenCuentaResuelto> {
    const resultado = await enTransaccion<
      { ok: true; datos: TokenCuentaResuelto } | { ok: false; motivo: 'sin-permiso' | 'no-existe' }
    >(pool, async (db) => {
      // Bloqueamos solo esta fila para serializar renovaciones concurrentes (Outlook rota refresh_token).
      const cuenta = await repositorio.bloquearCuentaParaToken(db, cuentaId);
      if (!cuenta) return { ok: false, motivo: 'no-existe' };
      if (cuenta.estado === 'sin-permiso') return { ok: false, motivo: 'sin-permiso' };

      const adaptador = adaptadores.obtener(cuenta.proveedor);
      if (!adaptador) {
        throw new Error(`No hay adaptador registrado para el proveedor ${cuenta.proveedor}.`);
      }

      const accessActual = desencriptarTexto(
        claveTokens,
        cuenta.accessTokenCifrado,
        cuenta.usuarioId,
      );
      const ahoraMs = ahora();
      const porVencer = cuenta.tokenVenceEn.getTime() <= ahoraMs + margenRenovacionMs;
      const coincideConFallido =
        extra?.forzarSiIgualA !== undefined && accessActual === extra.forzarSiIgualA;

      if (!porVencer && !coincideConFallido) {
        return {
          ok: true,
          datos: { accessToken: accessActual, adaptador, email: cuenta.email },
        };
      }

      const refreshActual = desencriptarTexto(
        claveTokens,
        cuenta.refreshTokenCifrado,
        cuenta.usuarioId,
      );
      try {
        const nuevas = await adaptador.renovarToken(refreshActual);
        await repositorio.actualizarTokensCuenta(db, claveTokens, {
          cuentaId: cuenta.id,
          usuarioId: cuenta.usuarioId,
          credenciales: nuevas,
          ahora: new Date(ahoraMs),
        });
        logger.info({ cuentaId: cuenta.id, proveedor: cuenta.proveedor }, 'token OAuth renovado');
        return {
          ok: true,
          datos: { accessToken: nuevas.accessToken, adaptador, email: cuenta.email },
        };
      } catch (err) {
        if (
          err instanceof ErrorProveedorCorreo &&
          (err.codigo === 'permiso-revocado' || err.codigo === 'scope-insuficiente')
        ) {
          // Confirmamos el estado 'sin-permiso' antes de lanzar para que no lo revierta el rollback.
          await repositorio.marcarCuentaSinPermiso(db, cuenta.id, new Date(ahoraMs));
          logger.warn(
            { cuentaId: cuenta.id, proveedor: cuenta.proveedor, motivo: err.codigo },
            'cuenta marcada sin permiso tras rechazo de renovación',
          );
          return { ok: false, motivo: 'sin-permiso' };
        }
        throw err;
      }
    });

    if (!resultado.ok) {
      if (resultado.motivo === 'no-existe') throw new ErrorCuentaNoEncontrada(cuentaId);
      throw new ErrorCuentaSinPermiso(cuentaId);
    }
    return resultado.datos;
  }

  async function ejecutarConToken<T>(
    cuentaId: string,
    operacion: (adaptador: AdaptadorCorreo, accessToken: string) => Promise<T>,
  ): Promise<T> {
    const inicial = await obtenerTokenValido(cuentaId);
    try {
      return await operacion(inicial.adaptador, inicial.accessToken);
    } catch (err) {
      if (err instanceof ErrorProveedorCorreo && err.codigo === 'token-invalido') {
        const renovado = await obtenerTokenValido(cuentaId, {
          forzarSiIgualA: inicial.accessToken,
        });
        return operacion(renovado.adaptador, renovado.accessToken);
      }
      throw err;
    }
  }

  return {
    obtenerTokenValido,
    ejecutarConToken,
    listarNuevosCuenta: (cuentaId, desde) =>
      ejecutarConToken(cuentaId, (adaptador, token) => adaptador.listarNuevos(token, desde)),
    leerMensajeCuenta: (cuentaId, mensajeId) =>
      ejecutarConToken(cuentaId, (adaptador, token) => adaptador.leerMensaje(token, mensajeId)),
  };
}
