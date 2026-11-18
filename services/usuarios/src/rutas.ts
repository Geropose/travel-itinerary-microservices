// Rutas de specs/openapi/usuarios.yaml (salvo /health, manejado por crearServidor).
// El servidor ya validó el cuerpo contra el contrato y, en las rutas protegidas, el token.
import {
  autenticacion,
  contextoActual,
  crearEvento,
  enTransaccion,
  errores,
  guardarEnOutbox,
  type Pool,
  type Region,
  type RegistrarRechazo,
  type Servidor,
} from '@trotamundos/comun';
import type { Request } from 'express';
import type { Viajes } from './clientes.ts';
import * as repositorio from './repositorio.ts';

/** Lo que necesitan las rutas de usuarios: base, cliente de viajes, agencias válidas y registro. */
export interface Negocio {
  pool: Pool;
  viajes: Viajes;
  /** Identificadores de agencias configuradas en Integraciones (para validar PATCH /perfil). */
  agencias: ReadonlySet<string>;
  /** Registro de accesos rechazados (evento AccesoRechazado). */
  registrar: RegistrarRechazo;
}

function esDuplicadoPg(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

export function registrarRutas(
  servidor: Servidor,
  region: Region,
  servicio: string,
  negocio: Negocio,
): void {
  const { app } = servidor;
  const { pool, viajes, agencias } = negocio;

  function rechazo(req: Request, status: 401 | 403, usuarioId?: string): void {
    negocio.registrar({
      servicio,
      metodo: req.method,
      ruta: req.baseUrl + req.path,
      status,
      motivo: status === 401 ? 'token-invalido' : 'sin-permiso',
      ...(usuarioId ? { usuarioId } : {}),
      ...(req.ip ? { ip: req.ip } : {}),
      requestId: contextoActual()?.requestId ?? '',
    });
  }

  /** Verifica contra Viajes que quien llama es el dueño del viaje; si no, registra 403. */
  async function exigirDuenoViaje(req: Request, viajeId: string): Promise<string> {
    const auth = autenticacion(req);
    const esDueno = await viajes.esDueno(viajeId, auth.token);
    if (!esDueno) {
      rechazo(req, 403, auth.sub);
      throw errores.prohibido('Solo el dueño del viaje puede gestionar los designados.');
    }
    return auth.sub;
  }

  // --- Cuentas y preferencias -------------------------------------------------------------

  app.post('/interna/cuentas', async (req, res) => {
    const cuerpo = req.body as repositorio.CuentaNueva;
    if (cuerpo.region !== region) {
      throw errores.solicitudInvalida('La cuenta no pertenece a esta región.', [
        { campo: 'region', mensaje: `Debe ser ${region}.` },
      ]);
    }
    try {
      const perfil = await enTransaccion(pool, (db) => repositorio.crearCuenta(db, cuerpo));
      res.status(201).json(perfil);
    } catch (error) {
      if (esDuplicadoPg(error)) {
        throw errores.conflicto('Ya existe una cuenta con ese usuario o email.');
      }
      throw error;
    }
  });

  app.get('/perfil', async (req, res) => {
    const { sub } = autenticacion(req);
    const perfil = await repositorio.buscarPerfil(pool, sub);
    if (!perfil) throw errores.noEncontrado('La cuenta no existe.');
    res.json(perfil);
  });

  app.patch('/perfil', async (req, res) => {
    const { sub } = autenticacion(req);
    const cuerpo = req.body as repositorio.CambiosPerfil;
    if (
      cuerpo.agenciaPreferida !== undefined &&
      cuerpo.agenciaPreferida !== null &&
      !agencias.has(cuerpo.agenciaPreferida)
    ) {
      throw errores.solicitudInvalida('La agencia preferida no está configurada.', [
        { campo: 'agenciaPreferida', mensaje: 'Agencia desconocida.' },
      ]);
    }
    const perfil = await repositorio.actualizarPerfil(pool, sub, cuerpo);
    if (!perfil) throw errores.noEncontrado('La cuenta no existe.');
    res.json(perfil);
  });

  app.get('/interna/usuarios/:usuarioId/agencia', async (req, res) => {
    const auth = autenticacion(req);
    const usuarioId = String(req.params.usuarioId);
    if (usuarioId !== auth.sub) {
      rechazo(req, 403, auth.sub);
      throw errores.prohibido('Solo podés consultar tu propia agencia preferida.');
    }
    const resultado = await repositorio.obtenerAgenciaPreferida(pool, usuarioId);
    if (!resultado) throw errores.noEncontrado('La cuenta no existe.');
    res.json(resultado);
  });

  // --- Filtros y whitelist ----------------------------------------------------------------

  app.get('/whitelist', async (req, res) => {
    const { sub } = autenticacion(req);
    const whitelist = await repositorio.obtenerWhitelist(pool, sub);
    if (!whitelist) throw errores.noEncontrado('La cuenta no existe.');
    res.json(whitelist);
  });

  app.put('/whitelist', async (req, res) => {
    const { sub } = autenticacion(req);
    const cuerpo = req.body as { remitentesPermitidos: string[]; filtrosActivos: boolean };
    const remitentes = [
      ...new Set(cuerpo.remitentesPermitidos.map((r) => repositorio.normalizarEmail(r))),
    ];

    const guardada = await enTransaccion(pool, async (db) => {
      if (!(await repositorio.existeCuenta(db, sub))) {
        throw errores.noEncontrado('La cuenta no existe.');
      }
      const whitelist = await repositorio.guardarWhitelist(
        db,
        sub,
        remitentes,
        cuerpo.filtrosActivos,
      );
      await guardarEnOutbox(
        db,
        crearEvento(
          'FiltrosActualizados',
          {
            usuarioId: sub,
            remitentesPermitidos: whitelist.remitentesPermitidos,
            filtrosActivos: whitelist.filtrosActivos,
          },
          region,
        ),
      );
      return whitelist;
    });
    res.json(guardada);
  });

  // --- Permisos de itinerarios ------------------------------------------------------------

  app.get('/itinerarios/:viajeId/designados', async (req, res) => {
    const viajeId = String(req.params.viajeId);
    await exigirDuenoViaje(req, viajeId);
    const designados = await repositorio.listarDesignados(pool, viajeId);
    res.json({ viajeId, designados });
  });

  app.post('/itinerarios/:viajeId/designados', async (req, res) => {
    const viajeId = String(req.params.viajeId);
    const sub = await exigirDuenoViaje(req, viajeId);
    const cuerpo = req.body as { email: string };
    const email = repositorio.normalizarEmail(cuerpo.email);

    const dueno = await repositorio.buscarPerfil(pool, sub);
    if (dueno && dueno.email === email) {
      throw errores.solicitudInvalida('No podés designarte a vos mismo para ver tu itinerario.', [
        { campo: 'email', mensaje: 'Debe ser el email de otra persona.' },
      ]);
    }

    const cuentaDesignada = await repositorio.buscarPorEmail(pool, email);
    try {
      const designado = await repositorio.designarPersona(
        pool,
        viajeId,
        email,
        cuentaDesignada?.usuarioId ?? null,
      );
      res.status(201).json(designado);
    } catch (error) {
      if (esDuplicadoPg(error)) {
        throw errores.conflicto('La persona ya está designada para ver este itinerario.');
      }
      throw error;
    }
  });

  app.delete('/itinerarios/:viajeId/designados/:email', async (req, res) => {
    const viajeId = String(req.params.viajeId);
    await exigirDuenoViaje(req, viajeId);
    const quitado = await repositorio.quitarDesignado(pool, viajeId, String(req.params.email));
    if (!quitado) throw errores.noEncontrado('La persona no está designada en este itinerario.');
    res.status(204).end();
  });

  app.get('/interna/permisos/itinerarios/:viajeId', async (req, res) => {
    const auth = autenticacion(req);
    const viajeId = String(req.params.viajeId);
    const usuarioId = String(req.query.usuarioId);
    if (usuarioId !== auth.sub) {
      rechazo(req, 403, auth.sub);
      throw errores.prohibido('Solo podés consultar tus propios permisos.');
    }
    const designado = await repositorio.esDesignado(pool, viajeId, usuarioId);
    res.json({
      viajeId,
      usuarioId,
      puedeVer: designado,
      motivo: designado ? 'designado' : 'ninguno',
    });
  });
}
