import {
  contextoActual,
  ErrorHttp,
  errores,
  type Autenticacion,
  type Logger,
  type Pool,
  type Region,
  type RegistrarRechazo,
} from '@trotamundos/comun';
import type { RegistroPlugins } from './plugins/registro.ts';
import type { ContextoPlugin, MensajeHistorial, RespuestaPlugin } from './plugins/tipos.ts';
import {
  detectarIntencionConReglas,
  interpolarTexto,
  type GestorReglas,
  type IdiomaAsistente,
  type IntencionDetectada,
} from './reglas.ts';
import * as repositorio from './repositorio.ts';
import type { ConversacionCabecera, ConversacionCompleta } from './repositorio.ts';

export interface MetadatosAcceso {
  metodo: string;
  ruta: string;
  ip?: string;
}

export interface ResultadoTurno {
  estado: 'respondido' | 'consultando';
  mensajeUsuario: MensajeHistorial;
  respuesta: MensajeHistorial;
}

export interface ListaMensajesNuevos {
  mensajes: MensajeHistorial[];
  consultando: boolean;
  ultimaSecuencia: number;
}

export interface OpcionesNucleoConversacion {
  pool: Pool;
  region: Region;
  reglas: GestorReglas;
  plugins: RegistroPlugins;
  logger: Logger;
  registrarRechazo?: RegistrarRechazo;
  ahora?: () => number;
}

export interface NucleoConversacion {
  crearConversacion(usuarioId: string, idioma?: string): Promise<ConversacionCompleta>;
  obtenerConversacion(
    conversacionId: string,
    usuarioId: string,
    acceso: MetadatosAcceso,
  ): Promise<ConversacionCompleta>;
  listarMensajes(
    conversacionId: string,
    usuarioId: string,
    desde: number,
    acceso: MetadatosAcceso,
  ): Promise<ListaMensajesNuevos>;
  enviarMensaje(
    conversacionId: string,
    auth: Autenticacion,
    texto: string,
    acceso: MetadatosAcceso,
  ): Promise<ResultadoTurno>;
  confirmarReprogramacion(
    conversacionId: string,
    auth: Autenticacion,
    opcionId: string,
    acceso: MetadatosAcceso,
  ): Promise<ResultadoTurno>;
}

const MAX_INTENTOS_FALLIDOS = 2;

function normalizarIdioma(idioma: string | undefined): IdiomaAsistente {
  return idioma?.toLowerCase().startsWith('en') ? 'en' : 'es';
}

/**
 * Núcleo de conversación del Asistente Virtual (Iteración 7, ADR-018):
 * guarda el contexto por conversación, detecta intenciones con las reglas configuradas (~10 ms),
 * despacha al plug-in registrado, maneja repreguntas/derivación tras 2 intentos fallidos y exige
 * confirmación explícita para aplicar reprogramaciones.
 */
export function crearNucleoConversacion(opciones: OpcionesNucleoConversacion): NucleoConversacion {
  const { pool, region, reglas, plugins, logger, registrarRechazo, ahora = Date.now } = opciones;

  async function exigirConversacionPropia(
    conversacionId: string,
    usuarioId: string,
    acceso: MetadatosAcceso,
  ): Promise<ConversacionCabecera> {
    const conv = await repositorio.obtenerConversacionCabecera(pool, conversacionId);
    if (!conv) {
      throw errores.noEncontrado('La conversación no existe.');
    }
    if (conv.usuarioId !== usuarioId) {
      // QA-9: respondemos 404 para no revelar existencia, pero registramos el intento rechazado.
      registrarRechazo?.({
        servicio: 'asistente',
        metodo: acceso.metodo,
        ruta: acceso.ruta,
        status: 403,
        motivo: 'sin-permiso',
        usuarioId,
        ...(acceso.ip ? { ip: acceso.ip } : {}),
        requestId: contextoActual()?.requestId ?? '',
      });
      logger.info(
        { conversacionId, usuarioId, ruta: acceso.ruta },
        'Acceso rechazado a conversación ajena (respondido 404)',
      );
      throw errores.noEncontrado('La conversación no existe.');
    }
    return conv;
  }

  async function guardarRespuestaAsistente(
    conversacionId: string,
    intencion: IntencionDetectada,
    resp: RespuestaPlugin,
    estadoExtra: { intentosFallidos?: number; consultando?: boolean } = {},
  ): Promise<MensajeHistorial> {
    if (resp.opciones && resp.opciones.length > 0) {
      await repositorio.reemplazarOpcionesPendientes(pool, conversacionId, resp.opciones);
    }

    const fecha = new Date(ahora());
    const mensajeAsistente = await repositorio.agregarMensaje(pool, conversacionId, {
      autor: 'asistente',
      texto: resp.texto,
      enviadoEn: fecha,
      intencion,
      resultado: resp.resultado,
      ...(resp.reservas ? { reservas: resp.reservas } : {}),
      ...(resp.opciones && resp.opciones.length > 0 ? { opciones: resp.opciones } : {}),
      ...(resp.caso ? { caso: resp.caso } : {}),
      ...(resp.noDisponible ? { noDisponible: resp.noDisponible } : {}),
      ...(resp.ofreceDerivar !== undefined ? { ofreceDerivar: resp.ofreceDerivar } : {}),
    });

    await repositorio.actualizarEstadoConversacion(pool, conversacionId, {
      ofreceDerivar: resp.ofreceDerivar === true,
      ...(estadoExtra.intentosFallidos !== undefined
        ? { intentosFallidos: estadoExtra.intentosFallidos }
        : {}),
      ...(estadoExtra.consultando !== undefined ? { consultando: estadoExtra.consultando } : {}),
      actualizadaEn: fecha,
    });

    return mensajeAsistente;
  }

  async function crearConversacion(
    usuarioId: string,
    idiomaCrudo?: string,
  ): Promise<ConversacionCompleta> {
    const idioma = normalizarIdioma(idiomaCrudo);
    const reglasIdioma = reglas.obtener(idioma);
    return repositorio.crearConversacion(pool, {
      usuarioId,
      region,
      idioma,
      saludo: reglasIdioma.textos.saludo,
      ahora: new Date(ahora()),
    });
  }

  async function obtenerConversacion(
    conversacionId: string,
    usuarioId: string,
    acceso: MetadatosAcceso,
  ): Promise<ConversacionCompleta> {
    const conv = await exigirConversacionPropia(conversacionId, usuarioId, acceso);
    const mensajes = await repositorio.listarMensajes(pool, conversacionId, 0);
    return {
      conversacionId: conv.conversacionId,
      usuarioId: conv.usuarioId,
      region: conv.region,
      idioma: conv.idioma,
      creadaEn: conv.creadaEn,
      actualizadaEn: conv.actualizadaEn,
      consultando: conv.consultando,
      mensajes,
    };
  }

  async function listarMensajes(
    conversacionId: string,
    usuarioId: string,
    desde: number,
    acceso: MetadatosAcceso,
  ): Promise<ListaMensajesNuevos> {
    const conv = await exigirConversacionPropia(conversacionId, usuarioId, acceso);
    const mensajes = await repositorio.listarMensajes(pool, conversacionId, desde);
    return {
      mensajes,
      consultando: conv.consultando,
      ultimaSecuencia: conv.ultimaSecuencia,
    };
  }

  async function enviarMensaje(
    conversacionId: string,
    auth: Autenticacion,
    texto: string,
    acceso: MetadatosAcceso,
  ): Promise<ResultadoTurno> {
    const conv = await exigirConversacionPropia(conversacionId, auth.sub, acceso);
    const reglasIdioma = reglas.obtener(conv.idioma);

    const mensajeUsuario = await repositorio.agregarMensaje(pool, conversacionId, {
      autor: 'usuario',
      texto,
      enviadoEn: new Date(ahora()),
    });

    const inicioDeteccion = performance.now();
    const detectada = detectarIntencionConReglas(texto, reglasIdioma, conv.ofreceDerivar);
    const duracionDeteccionMs = Math.round((performance.now() - inicioDeteccion) * 100) / 100;
    logger.debug(
      { conversacionId, intencion: detectada, duracionDeteccionMs },
      'Intención detectada',
    );

    if (detectada === 'desconocida') {
      const intentosFallidos = conv.intentosFallidos + 1;
      if (intentosFallidos < MAX_INTENTOS_FALLIDOS) {
        const respuesta = await guardarRespuestaAsistente(
          conversacionId,
          'desconocida',
          {
            texto: reglasIdioma.textos.repregunta,
            resultado: 'repregunta',
          },
          { intentosFallidos },
        );
        return { estado: 'respondido', mensajeUsuario, respuesta };
      }

      // Al segundo intento fallido consecutivo, derivamos automáticamente a la agencia preferida.
      const pluginDerivar = plugins.obtener('derivar');
      if (!pluginDerivar) {
        throw new Error('No hay plug-in registrado para derivar.');
      }
      const historial = await repositorio.listarMensajes(pool, conversacionId, 0);
      const contexto: ContextoPlugin = {
        conversacionId,
        usuarioId: auth.sub,
        region,
        idioma: conv.idioma,
        token: auth.token,
        reglas: reglasIdioma,
        historial,
        motivoDerivacion: reglasIdioma.textos.derivacionAutomaticaMotivo,
      };
      const respDerivar = await pluginDerivar.atender(contexto, texto);
      const respuesta = await guardarRespuestaAsistente(conversacionId, 'derivar', respDerivar, {
        intentosFallidos: 0,
      });
      return { estado: 'respondido', mensajeUsuario, respuesta };
    }

    const plugin = plugins.obtener(detectada);
    if (!plugin) {
      throw new Error(`No hay plug-in registrado para la intención "${detectada}".`);
    }

    const historial = await repositorio.listarMensajes(pool, conversacionId, 0);
    const contexto: ContextoPlugin = {
      conversacionId,
      usuarioId: auth.sub,
      region,
      idioma: conv.idioma,
      token: auth.token,
      reglas: reglasIdioma,
      historial,
    };

    const respPlugin = await plugin.atender(contexto, texto);
    const respuesta = await guardarRespuestaAsistente(conversacionId, detectada, respPlugin, {
      intentosFallidos: 0,
    });
    return { estado: 'respondido', mensajeUsuario, respuesta };
  }

  async function confirmarReprogramacion(
    conversacionId: string,
    auth: Autenticacion,
    opcionId: string,
    acceso: MetadatosAcceso,
  ): Promise<ResultadoTurno> {
    const conv = await exigirConversacionPropia(conversacionId, auth.sub, acceso);
    const reglasIdioma = reglas.obtener(conv.idioma);

    if (conv.consultando) {
      throw new ErrorHttp({
        status: 409,
        tipo: 'opcion-no-pendiente',
        titulo: 'La opción no está pendiente',
        detalle: 'Todavía se está consultando al proveedor en esta conversación.',
      });
    }

    const opcion = await repositorio.obtenerOpcionPendiente(pool, conversacionId, opcionId);
    if (!opcion) {
      throw new ErrorHttp({
        status: 409,
        tipo: 'opcion-no-pendiente',
        titulo: 'La opción no está pendiente',
        detalle: `La opción ${opcionId} no está entre las opciones ofrecidas en esta conversación.`,
      });
    }

    const textoUsuario = interpolarTexto(reglasIdioma.textos.confirmacionUsuario, {
      descripcion: opcion.descripcion ?? opcion.opcionId,
    });
    const mensajeUsuario = await repositorio.agregarMensaje(pool, conversacionId, {
      autor: 'usuario',
      texto: textoUsuario,
      enviadoEn: new Date(ahora()),
      confirmacion: { opcionId },
    });

    const pluginReprogramar = plugins.obtener('reprogramar');
    if (!pluginReprogramar?.confirmar) {
      throw new Error('El plug-in de reprogramación no soporta confirmación.');
    }

    const historial = await repositorio.listarMensajes(pool, conversacionId, 0);
    const contexto: ContextoPlugin = {
      conversacionId,
      usuarioId: auth.sub,
      region,
      idioma: conv.idioma,
      token: auth.token,
      reglas: reglasIdioma,
      historial,
    };

    const respConfirmacion = await pluginReprogramar.confirmar(contexto, opcion);
    if (
      respConfirmacion.resultado === 'reprogramado' ||
      respConfirmacion.resultado === 'opcionRechazada'
    ) {
      await repositorio.limpiarOpcionesPendientes(pool, conversacionId);
    }

    const respuesta = await guardarRespuestaAsistente(
      conversacionId,
      'reprogramar',
      respConfirmacion,
      { intentosFallidos: 0 },
    );
    return { estado: 'respondido', mensajeUsuario, respuesta };
  }

  return {
    crearConversacion,
    obtenerConversacion,
    listarMensajes,
    enviarMensaje,
    confirmarReprogramacion,
  };
}
