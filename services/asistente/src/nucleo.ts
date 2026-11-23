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
import type { MetricasAsistente } from './metricas.ts';
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
  metricas?: MetricasAsistente;
  /** Umbral (ms) antes de responder 202 `consultando` en reprogramaciones lentas (QA-12: 3000 ms). */
  umbralRespuestaLentaMs?: number;
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
    zonaHoraria?: string,
  ): Promise<ResultadoTurno>;
  confirmarReprogramacion(
    conversacionId: string,
    auth: Autenticacion,
    opcionId: string,
    acceso: MetadatosAcceso,
    zonaHoraria?: string,
  ): Promise<ResultadoTurno>;
  /** Espera las consultas en segundo plano antes de cerrar la base (apagado limpio). */
  detener(): Promise<void>;
}

const MAX_INTENTOS_FALLIDOS = 2;
const MARCA_LENTA = Symbol('consulta-lenta');

function normalizarIdioma(idioma: string | undefined): IdiomaAsistente {
  return idioma?.toLowerCase().startsWith('en') ? 'en' : 'es';
}

/**
 * Núcleo de conversación del Asistente Virtual (Iteración 7, ADR-018, ADR-019, QA-12):
 * guarda el contexto por conversación, detecta intenciones con las reglas configuradas (~10 ms),
 * despacha al plug-in registrado, aplica degradación controlada, responde 202 `consultando` cuando
 * una reprogramación supera 3 s y registra métricas de latencia por mensaje.
 */
export function crearNucleoConversacion(opciones: OpcionesNucleoConversacion): NucleoConversacion {
  const {
    pool,
    region,
    reglas,
    plugins,
    logger,
    metricas,
    umbralRespuestaLentaMs = 3000,
    registrarRechazo,
    ahora = Date.now,
  } = opciones;

  const tareasSegundoPlano = new Set<Promise<void>>();
  let detenido = false;

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

  /**
   * Ejecuta una operación de reprogramación con umbral de respuesta lenta (QA-12: 3 s):
   * - Si termina antes del umbral, guarda y devuelve la respuesta definitiva (`200 respondido`).
   * - Si supera el umbral, guarda el aviso `consultando`, devuelve `202 consultando` y completa la
   *   operación en segundo plano dejando el resultado final en `mensajes` para polling.
   */
  async function ejecutarConUmbralLento(params: {
    conversacionId: string;
    promesa: Promise<RespuestaPlugin>;
    textoConsultando: string;
    textoNoDisponible: string;
    alCompletar?: (resp: RespuestaPlugin) => Promise<void>;
  }): Promise<{ estado: 'respondido' | 'consultando'; respuesta: MensajeHistorial }> {
    const { conversacionId, promesa, textoConsultando, textoNoDisponible, alCompletar } = params;

    let temporizador: NodeJS.Timeout | undefined;
    const carrera = await Promise.race([
      promesa.then(
        (valor) => ({ tipo: 'ok' as const, valor }),
        (error: unknown) => ({ tipo: 'error' as const, error }),
      ),
      new Promise<{ tipo: typeof MARCA_LENTA }>((resolve) => {
        temporizador = setTimeout(() => resolve({ tipo: MARCA_LENTA }), umbralRespuestaLentaMs);
      }),
    ]);
    clearTimeout(temporizador);

    if (carrera.tipo === 'ok') {
      if (alCompletar) await alCompletar(carrera.valor);
      const respuesta = await guardarRespuestaAsistente(
        conversacionId,
        'reprogramar',
        carrera.valor,
        {
          intentosFallidos: 0,
          consultando: false,
        },
      );
      return { estado: 'respondido', respuesta };
    }

    if (carrera.tipo === 'error') {
      logger.warn({ err: carrera.error, conversacionId }, 'Error en plug-in de reprogramación');
      const respuesta = await guardarRespuestaAsistente(
        conversacionId,
        'reprogramar',
        {
          texto: textoNoDisponible,
          resultado: 'noDisponible',
          noDisponible: { funcion: 'reprogramar', servicio: 'proveedor' },
          ofreceDerivar: true,
        },
        { intentosFallidos: 0, consultando: false },
      );
      return { estado: 'respondido', respuesta };
    }

    // Superó el umbral de 3 s: respondemos enseguida `consultando` y completamos en segundo plano
    // incluso si el proveedor terminó mientras guardábamos el aviso.
    const mensajeConsultando = await guardarRespuestaAsistente(
      conversacionId,
      'reprogramar',
      {
        texto: textoConsultando,
        resultado: 'consultando',
      },
      { intentosFallidos: 0, consultando: true },
    );

    const tarea = promesa
      .then(async (respFinal) => {
        if (detenido) return;
        if (alCompletar) await alCompletar(respFinal);
        await guardarRespuestaAsistente(conversacionId, 'reprogramar', respFinal, {
          intentosFallidos: 0,
          consultando: false,
        });
      })
      .catch(async (error: unknown) => {
        if (detenido) return;
        logger.warn(
          { err: error, conversacionId },
          'Falló la consulta lenta al proveedor en segundo plano',
        );
        await guardarRespuestaAsistente(
          conversacionId,
          'reprogramar',
          {
            texto: textoNoDisponible,
            resultado: 'noDisponible',
            noDisponible: { funcion: 'reprogramar', servicio: 'proveedor' },
            ofreceDerivar: true,
          },
          { intentosFallidos: 0, consultando: false },
        );
      })
      .finally(() => {
        tareasSegundoPlano.delete(tarea);
      });
    tareasSegundoPlano.add(tarea);

    return { estado: 'consultando', respuesta: mensajeConsultando };
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
    zonaHoraria?: string,
  ): Promise<ResultadoTurno> {
    const inicioTurno = performance.now();
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
        metricas?.registrar({
          conversacionId,
          intencion: 'desconocida',
          estado: 'respondido',
          resultado: 'repregunta',
          duracionMs: performance.now() - inicioTurno,
        });
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
        ...(zonaHoraria ? { zonaHoraria } : {}),
        motivoDerivacion: reglasIdioma.textos.derivacionAutomaticaMotivo,
      };
      const respDerivar = await pluginDerivar.atender(contexto, texto);
      const respuesta = await guardarRespuestaAsistente(conversacionId, 'derivar', respDerivar, {
        intentosFallidos: 0,
      });
      metricas?.registrar({
        conversacionId,
        intencion: 'derivar',
        estado: 'respondido',
        resultado: respDerivar.resultado,
        duracionMs: performance.now() - inicioTurno,
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
      ...(zonaHoraria ? { zonaHoraria } : {}),
    };

    if (detectada === 'reprogramar') {
      const { estado, respuesta } = await ejecutarConUmbralLento({
        conversacionId,
        promesa: plugin.atender(contexto, texto),
        textoConsultando: reglasIdioma.textos.consultandoOpciones,
        textoNoDisponible: reglasIdioma.textos.noDisponibleReprogramar,
      });
      metricas?.registrar({
        conversacionId,
        intencion: 'reprogramar',
        estado,
        resultado: respuesta.resultado ?? 'respondido',
        duracionMs: performance.now() - inicioTurno,
      });
      return { estado, mensajeUsuario, respuesta };
    }

    const respPlugin = await plugin.atender(contexto, texto);
    const respuesta = await guardarRespuestaAsistente(conversacionId, detectada, respPlugin, {
      intentosFallidos: 0,
    });
    metricas?.registrar({
      conversacionId,
      intencion: detectada,
      estado: 'respondido',
      resultado: respPlugin.resultado,
      duracionMs: performance.now() - inicioTurno,
    });
    return { estado: 'respondido', mensajeUsuario, respuesta };
  }

  async function confirmarReprogramacion(
    conversacionId: string,
    auth: Autenticacion,
    opcionId: string,
    acceso: MetadatosAcceso,
    zonaHoraria?: string,
  ): Promise<ResultadoTurno> {
    const inicioTurno = performance.now();
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
      ...(zonaHoraria ? { zonaHoraria } : {}),
    };

    const { estado, respuesta } = await ejecutarConUmbralLento({
      conversacionId,
      promesa: pluginReprogramar.confirmar(contexto, opcion),
      textoConsultando: reglasIdioma.textos.consultandoAplicar,
      textoNoDisponible: reglasIdioma.textos.noDisponibleReprogramar,
      alCompletar: async (resp) => {
        if (resp.resultado === 'reprogramado' || resp.resultado === 'opcionRechazada') {
          await repositorio.limpiarOpcionesPendientes(pool, conversacionId);
        }
      },
    });

    metricas?.registrar({
      conversacionId,
      intencion: 'reprogramar',
      estado,
      resultado: respuesta.resultado ?? 'respondido',
      duracionMs: performance.now() - inicioTurno,
    });

    return { estado, mensajeUsuario, respuesta };
  }

  async function detener(): Promise<void> {
    detenido = true;
    await Promise.allSettled([...tareasSegundoPlano]);
  }

  return {
    crearConversacion,
    obtenerConversacion,
    listarMensajes,
    enviarMensaje,
    confirmarReprogramacion,
    detener,
  };
}
