// Rutas de specs/openapi/autenticacion.yaml (salvo /health y /.well-known/jwks.json, en app.ts).
// El servidor ya validó el cuerpo contra el contrato y, en las rutas protegidas, el token.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  autenticacion,
  contextoActual,
  enTransaccion,
  ErrorHttp,
  errores,
  type Logger,
  type Pool,
  type Region,
  type RegistrarRechazo,
  type Servidor,
} from '@trotamundos/comun';
import type { Request, Response } from 'express';
import type { ClavesJwt } from './claves.ts';
import { statusDe, type OtraRegion, type Usuarios } from './clientes.ts';
import { HASH_FALSO, hashContrasena, verificarContrasena } from './contrasenas.ts';
import * as repositorio from './repositorio.ts';
import {
  DURACION_RENOVACION_SEG,
  DURACION_TOKEN_SERVICIO_SEG,
  firmarJwtUsuario,
  firmarTokenDeServicio,
  hashToken,
  nuevoTokenRenovacion,
} from './tokens.ts';

/** Lo que necesitan las rutas: base, claves, los otros servicios y la configuración. */
export interface Negocio {
  pool: Pool;
  claves: ClavesJwt;
  usuarios: Usuarios;
  otraRegion: OtraRegion;
  /** URL pública de la otra región (Location de los 307). */
  urlPublicaOtraRegion: string;
  /** SECRETO_SERVICIO_<SERVICIO> por servicio (config.ts secretosDeServicios). */
  secretos: Map<string, string>;
  /** Registro de accesos rechazados (evento AccesoRechazado). */
  registrar: RegistrarRechazo;
  limiteLogin: { maxIntentos: number; ventanaMinutos: number };
  /** Duración del token de renovación (7 días; las pruebas la acortan). */
  duracionRenovacionSeg?: number;
}

interface SolicitudRegistro {
  email: string;
  contrasena: string;
  nombre: string;
  region: Region;
  idioma: string;
}

const emailRegistrado = () =>
  new ErrorHttp({
    status: 409,
    tipo: 'conflicto',
    titulo: 'El email ya está registrado',
    detalle: 'Ya existe una cuenta con ese email.',
  });

const credencialesIncorrectas = () =>
  new ErrorHttp({
    status: 401,
    tipo: 'credenciales-incorrectas',
    titulo: 'Credenciales incorrectas',
    detalle: 'El email o la contraseña no son correctos.',
  });

/** Compara secretos sin que el tiempo dependa de cuántos caracteres coinciden. */
function mismoSecreto(a: string, b: string): boolean {
  const huella = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(huella(a), huella(b));
}

export function registrarRutas(
  servidor: Servidor,
  region: Region,
  servicio: string,
  negocio: Negocio,
  logger: Logger,
): void {
  const { app } = servidor;
  const { pool, claves, usuarios, otraRegion, limiteLogin } = negocio;
  const duracionRenovacion = negocio.duracionRenovacionSeg ?? DURACION_RENOVACION_SEG;

  /** 307 hacia la misma operación en la otra región (Iteración 6, ADR-017). */
  function haciaOtraRegion(res: Response, operacion: string): void {
    res
      .status(307)
      .location(`${negocio.urlPublicaOtraRegion}/api/autenticacion${operacion}`)
      .json({ region: otraRegion.region });
  }

  /** ¿La cuenta está en la otra región? Si no responde, 503: no se puede saber. */
  async function enLaOtraRegion(email: string): Promise<boolean> {
    try {
      return await otraRegion.existeCuenta(email);
    } catch (error) {
      logger.warn({ err: error }, 'La otra región no respondió si existe la cuenta');
      throw errores.noDisponible('No se pudo consultar la otra región. Probá de nuevo.');
    }
  }

  function rechazo(req: Request, status: 401 | 403, usuarioId?: string): void {
    negocio.registrar({
      servicio,
      metodo: req.method,
      ruta: req.path,
      status,
      motivo: status === 401 ? 'token-invalido' : 'sin-permiso',
      ...(usuarioId ? { usuarioId } : {}),
      ...(req.ip ? { ip: req.ip } : {}),
      requestId: contextoActual()?.requestId ?? '',
    });
  }

  app.post('/registro', async (req, res) => {
    const cuerpo = req.body as SolicitudRegistro;
    // La cuenta se guarda en la región que eligió el usuario (CONST-6).
    if (cuerpo.region !== region) {
      haciaOtraRegion(res, '/registro');
      return;
    }
    if (await repositorio.existeEmail(pool, cuerpo.email)) throw emailRegistrado();
    if (await enLaOtraRegion(cuerpo.email)) throw emailRegistrado();

    const usuarioId = randomUUID();
    const hashContrasenaNueva = await hashContrasena(cuerpo.contrasena);
    try {
      // Si Usuarios no crea la cuenta, la transacción se deshace y no queda la credencial.
      await enTransaccion(pool, async (db) => {
        await repositorio.crearCredencial(db, {
          usuarioId,
          email: cuerpo.email,
          hashContrasena: hashContrasenaNueva,
          roles: ['usuario'],
          idioma: cuerpo.idioma,
        });
        await usuarios.crearCuenta({
          usuarioId,
          email: repositorio.normalizarEmail(cuerpo.email),
          nombre: cuerpo.nombre,
          region,
          idioma: cuerpo.idioma,
        });
      });
    } catch (error) {
      // Dos registros a la vez con el mismo email: el segundo choca con el UNIQUE.
      if ((error as { code?: string }).code === '23505' || statusDe(error) === 409) {
        throw emailRegistrado();
      }
      logger.warn({ err: error }, 'Usuarios no creó la cuenta: se deshizo el registro');
      throw errores.noDisponible('No se pudo crear la cuenta. Probá de nuevo.');
    }
    logger.info({ usuarioId }, 'Cuenta registrada');
    res.status(201).json({ usuarioId });
  });

  app.post('/login', async (req, res) => {
    const { email, contrasena } = req.body as { email: string; contrasena: string };
    const { maxIntentos, ventanaMinutos } = limiteLogin;

    const intentos = await repositorio.intentosRecientes(pool, email, ventanaMinutos);
    if (intentos.cantidad >= maxIntentos) {
      throw new ErrorHttp({
        status: 429,
        tipo: 'demasiados-intentos',
        titulo: 'Demasiados intentos',
        detalle: `Hubo ${maxIntentos} intentos fallidos con ese email. Probá de nuevo en ${Math.ceil(intentos.liberaEnSeg / 60)} minutos.`,
        encabezados: { 'Retry-After': String(intentos.liberaEnSeg) },
      });
    }

    const credencial = await repositorio.buscarPorEmail(pool, email);
    if (!credencial) {
      // Se verifica igual contra un hash falso para que tarde lo mismo que con una cuenta real.
      await verificarContrasena(await HASH_FALSO, contrasena);
      // Dispositivo nuevo: la cuenta puede ser de la otra región. Se responde 307 sin guardar
      // nada en esta región (ADR-017).
      if (await enLaOtraRegion(email)) {
        haciaOtraRegion(res, '/login');
        return;
      }
      await repositorio.registrarIntentoFallido(pool, email, ventanaMinutos);
      throw credencialesIncorrectas();
    }
    if (!(await verificarContrasena(credencial.hashContrasena, contrasena))) {
      await repositorio.registrarIntentoFallido(pool, email, ventanaMinutos);
      throw credencialesIncorrectas();
    }

    await repositorio.borrarIntentos(pool, email);
    const jwt = await firmarJwtUsuario(claves, { ...credencial, region });
    const tokenRenovacion = nuevoTokenRenovacion();
    await repositorio.guardarTokenRenovacion(
      pool,
      hashToken(tokenRenovacion),
      credencial.usuarioId,
      duracionRenovacion,
    );
    res.json({ jwt, tokenRenovacion, region });
  });

  app.post('/renovar', async (req, res) => {
    const { tokenRenovacion } = req.body as { tokenRenovacion: string };
    const credencial = await repositorio.credencialDeTokenVigente(pool, hashToken(tokenRenovacion));
    if (!credencial) {
      throw new ErrorHttp({
        status: 401,
        tipo: 'token-renovacion-invalido',
        titulo: 'Token de renovación inválido',
        detalle:
          'El token de renovación venció o se cerró la sesión. Hay que iniciar sesión de nuevo.',
      });
    }
    res.json({ jwt: await firmarJwtUsuario(claves, { ...credencial, region }) });
  });

  app.post('/logout', async (req, res) => {
    const { tokenRenovacion } = req.body as { tokenRenovacion: string };
    const { sub } = autenticacion(req);
    const hash = hashToken(tokenRenovacion);
    const dueno = await repositorio.duenoDeToken(pool, hash);
    // Idempotente: un token que no existe (o ya revocado) también responde 204.
    if (dueno && dueno !== sub) {
      rechazo(req, 403, sub);
      throw errores.prohibido('El token de renovación es de otro usuario.');
    }
    if (dueno) await repositorio.revocarToken(pool, hash);
    res.status(204).end();
  });

  app.get('/interna/cuentas/existe', async (req, res) => {
    const email = String(req.query.email);
    res.json({ existe: await repositorio.existeEmail(pool, email), region });
  });

  app.post('/interna/tokens-servicio', async (req, res) => {
    const { servicio: quien, secreto } = req.body as { servicio: string; secreto: string };
    const esperado = negocio.secretos.get(quien);
    if (!esperado || !mismoSecreto(esperado, secreto)) {
      rechazo(req, 401);
      throw errores.noAutenticado('El servicio o el secreto no son correctos.');
    }
    res.json({
      tokenServicio: await firmarTokenDeServicio(claves, quien, region),
      expiraEn: DURACION_TOKEN_SERVICIO_SEG,
    });
  });
}
