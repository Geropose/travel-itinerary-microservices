import express, { type Express, type RequestHandler } from 'express';
import {
  autenticacion,
  ErrorHttp,
  errores,
  type Logger,
  type Pool,
  type ReglaRuta,
  type Servidor,
  type Validador,
} from '@trotamundos/comun';
import type { ContactoUsuarioCaso, MensajeConversacionCaso } from './adaptadores/agencia.ts';
import type { ItinerarioPublico } from './adaptadores/redsocial.ts';
import type {
  RegistroAdaptadoresAgencias,
  RegistroAdaptadoresProveedores,
  RegistroAdaptadoresRedes,
} from './adaptadores/registro.ts';
import {
  ErrorCuerpoNoJson,
  ErrorFirmaInvalida,
  ErrorModoNoSoportado,
  ErrorProveedorExterno,
} from './adaptadores/tipos.ts';
import type { ProcesadorProveedores } from './procesador.ts';
import * as repositorio from './repositorio.ts';
import type { ClienteUsuarios } from './usuarios.ts';

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
  agencias: RegistroAdaptadoresAgencias;
  redes: RegistroAdaptadoresRedes;
  procesador: ProcesadorProveedores;
  usuarios: ClienteUsuarios;
  logger: Logger;
  ahora?: () => number;
}

const PATRON_PROVEEDOR = /^[a-z0-9-]+$/;

function traducirErrorExterno(error: unknown): never {
  if (error instanceof ErrorHttp) throw error;
  if (error instanceof ErrorProveedorExterno) {
    if (error.status === 404) throw errores.noEncontrado(error.message);
    if (error.status === 422) {
      throw new ErrorHttp({
        status: 409,
        tipo: 'opcion-vencida',
        titulo: 'La opción ya no está disponible',
        detalle: error.message,
      });
    }
    if (error.status === 503) {
      throw new ErrorHttp({
        status: 503,
        tipo: 'tercero-no-disponible',
        titulo: 'Tercero no disponible',
        detalle: error.message,
      });
    }
    throw new ErrorHttp({
      status: 502,
      tipo: 'error-tercero',
      titulo: 'Error del tercero',
      detalle: error.message,
    });
  }
  if (error instanceof ErrorModoNoSoportado) {
    throw new ErrorHttp({
      status: 409,
      tipo: 'opcion-vencida',
      titulo: 'La opción ya no está disponible',
      detalle: error.message,
    });
  }
  throw error;
}

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
export function registrarRutas(
  servidor: Servidor,
  negocio: NegocioIntegraciones,
  validador?: Validador,
): void {
  const ahora = negocio.ahora ?? Date.now;

  // --- Reprogramaciones (Iteración 7, UC-8) ---

  servidor.app.post('/interna/reprogramaciones/opciones', async (req, res) => {
    const { proveedor, numeroReserva } = req.body as {
      proveedor: string;
      numeroReserva: string;
    };
    const adaptador = negocio.registro.obtener(proveedor);
    if (!adaptador) {
      throw errores.noEncontrado(`No hay un adaptador configurado para el proveedor ${proveedor}.`);
    }

    let opciones;
    try {
      opciones = await adaptador.pedirOpcionesReprogramacion(numeroReserva);
    } catch (error) {
      traducirErrorExterno(error);
    }

    if (opciones.length > 0) {
      await repositorio.guardarOpcionesReprogramacion(
        negocio.pool,
        proveedor,
        numeroReserva,
        opciones,
      );
    }

    res.status(200).json({ proveedor, numeroReserva, opciones });
  });

  servidor.app.post('/interna/reprogramaciones/aplicar', async (req, res) => {
    const { proveedor, numeroReserva, opcionId } = req.body as {
      proveedor: string;
      numeroReserva: string;
      opcionId: string;
    };
    const adaptador = negocio.registro.obtener(proveedor);
    if (!adaptador) {
      throw errores.noEncontrado(`No hay un adaptador configurado para el proveedor ${proveedor}.`);
    }

    // Nunca enviar una opción inventada ni duplicarla entre réplicas concurrentes.
    const limiteEsperaMs = 20_000;
    const inicioEspera = Date.now();

    for (;;) {
      const reservada = await repositorio.reservarOpcionParaAplicar(
        negocio.pool,
        proveedor,
        numeroReserva,
        opcionId,
        new Date(ahora()).toISOString(),
      );
      if (reservada) {
        let resultado;
        try {
          resultado = await adaptador.aplicarReprogramacion(numeroReserva, opcionId);
        } catch (error) {
          await repositorio
            .liberarOpcionEnCurso(negocio.pool, proveedor, numeroReserva, opcionId)
            .catch(() => undefined);
          traducirErrorExterno(error);
        }

        await repositorio.marcarOpcionAplicada(
          negocio.pool,
          proveedor,
          numeroReserva,
          opcionId,
          resultado.aplicadaEn,
        );

        res.status(200).json({
          proveedor,
          numeroReserva,
          opcionId,
          estado: 'aplicada',
          aplicadaEn: resultado.aplicadaEn,
        });
        return;
      }

      const guardada = await repositorio.obtenerOpcionReprogramacion(
        negocio.pool,
        proveedor,
        numeroReserva,
        opcionId,
      );
      if (!guardada) {
        throw errores.noEncontrado(
          `La opción ${opcionId} no se ofreció para la reserva ${numeroReserva}.`,
        );
      }
      if (guardada.aplicadaEn) {
        res.status(200).json({
          proveedor,
          numeroReserva,
          opcionId,
          estado: 'aplicada',
          aplicadaEn: guardada.aplicadaEn,
        });
        return;
      }
      if (Date.parse(guardada.venceEn) < ahora()) {
        throw new ErrorHttp({
          status: 409,
          tipo: 'opcion-vencida',
          titulo: 'La opción ya no está disponible',
          detalle: `La opción ${opcionId} venció. Pedí opciones de nuevo.`,
        });
      }
      if (Date.now() - inicioEspera >= limiteEsperaMs) {
        throw new ErrorHttp({
          status: 503,
          tipo: 'tercero-no-disponible',
          titulo: 'Reprogramación en curso',
          detalle: 'La reprogramación ya se está aplicando. Reintentá en unos segundos.',
        });
      }
      await new Promise((resolver) => setTimeout(resolver, 35));
    }
  });

  // --- Agencias (Iteración 3 y 7, UC-6, ADR-019) ---

  const verificarMismoUsuario: RequestHandler = validador
    ? validador.soloDueno((req) => (req.body as { usuarioId?: string })?.usuarioId)
    : (req, _res, next) => {
        const auth = autenticacion(req);
        const { usuarioId } = req.body as { usuarioId: string };
        if (auth.esServicio || auth.sub !== usuarioId) {
          throw errores.prohibido('No se puede derivar un caso a nombre de otro usuario.');
        }
        next();
      };

  servidor.app.post('/interna/agencias/casos', verificarMismoUsuario, async (req, res) => {
    const { agencia, usuarioId, resumen, contacto, conversacion } = req.body as {
      agencia: string;
      usuarioId: string;
      resumen: string;
      contacto?: ContactoUsuarioCaso;
      conversacion: MensajeConversacionCaso[];
    };

    const adaptador = negocio.agencias.obtener(agencia);
    if (!adaptador) {
      throw errores.noEncontrado(`No hay un adaptador para la agencia ${agencia}.`);
    }

    let caso;
    try {
      caso = await adaptador.crearCaso({
        usuarioId,
        resumen,
        ...(contacto ? { contacto } : {}),
        conversacion,
      });
    } catch (error) {
      traducirErrorExterno(error);
    }

    res.status(201).json(caso);
  });

  servidor.app.post('/agencias/casos', async (req, res) => {
    const auth = autenticacion(req);
    const { resumen } = req.body as { resumen: string };

    const perfil = await negocio.usuarios.obtenerPerfil(auth.token);
    if (!perfil.agenciaPreferida) {
      throw new ErrorHttp({
        status: 409,
        tipo: 'conflicto',
        titulo: 'Sin agencia preferida',
        detalle: 'Elegí una agencia en tu perfil para poder contactarla.',
      });
    }

    const adaptador = negocio.agencias.obtener(perfil.agenciaPreferida);
    if (!adaptador) {
      throw new ErrorHttp({
        status: 502,
        tipo: 'error-tercero',
        titulo: 'Error del tercero',
        detalle: `No hay un adaptador configurado para la agencia ${perfil.agenciaPreferida}.`,
      });
    }

    let caso;
    try {
      caso = await adaptador.crearCaso({
        usuarioId: auth.sub,
        resumen,
        contacto: { nombre: perfil.nombre, email: perfil.email },
        conversacion: [],
      });
    } catch (error) {
      traducirErrorExterno(error);
    }

    res.status(201).json(caso);
  });

  // --- Redes sociales (Iteración 3, QA-7) ---

  servidor.app.post('/interna/redes/publicar', async (req, res) => {
    const auth = autenticacion(req);
    const { red, itinerario } = req.body as {
      red: string;
      itinerario: ItinerarioPublico;
    };

    const adaptador = negocio.redes.obtener(red);
    if (!adaptador) {
      throw errores.noEncontrado(`No hay un adaptador para la red ${red}.`);
    }

    let publicacion;
    try {
      publicacion = await adaptador.publicarItinerario(itinerario, auth.idioma);
    } catch (error) {
      traducirErrorExterno(error);
    }

    res.status(201).json(publicacion);
  });

  // --- Mensajes no traducidos (QA-6) ---

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
