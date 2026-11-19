import {
  ErrorProveedorExterno,
  esCadenaNoVacia,
  esFechaIsoValida,
  esObjeto,
  llamarProveedorHttp,
} from './tipos.ts';

export interface ContactoUsuarioCaso {
  nombre: string;
  email: string;
}

export interface MensajeConversacionCaso {
  autor: 'usuario' | 'asistente';
  texto: string;
  enviadoEn: string;
}

export interface DatosCrearCaso {
  usuarioId: string;
  resumen: string;
  contacto?: ContactoUsuarioCaso;
  conversacion: MensajeConversacionCaso[];
}

export interface CasoCreado {
  agencia: string;
  numeroCaso: string;
  creadoEn: string;
}

/** Interfaz común de adaptadores de agencias de viajes (Iteración 3 y 7, ADR-003, UC-6). */
export interface AdaptadorAgencia {
  readonly nombre: string;
  readonly tipo: string;
  crearCaso(datos: DatosCrearCaso): Promise<CasoCreado>;
}

export interface OpcionesAdaptadorAgencia {
  nombre: string;
  url: string;
  claveApi: string;
  tiempoMaximoMs?: number;
  ahora?: () => number;
  fetch?: typeof fetch;
}

function formatearHoraMensaje(iso: string): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return iso.slice(0, 16);
  const y = fecha.getUTCFullYear();
  const m = String(fecha.getUTCMonth() + 1).padStart(2, '0');
  const d = String(fecha.getUTCDate()).padStart(2, '0');
  const hh = String(fecha.getUTCHours()).padStart(2, '0');
  const mm = String(fecha.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function armarAsunto(resumen: string): string {
  const limpio = resumen.replace(/\s+/g, ' ').trim();
  const recortado = limpio.length > 80 ? `${limpio.slice(0, 79).trimEnd()}…` : limpio;
  return `Trotamundos: ${recortado}`;
}

function armarCuerpo(resumen: string, conversacion: MensajeConversacionCaso[]): string {
  const partes = [`Resumen: ${resumen.trim()}`];
  if (conversacion.length > 0) {
    const lineas = conversacion.map((m) => {
      const etiqueta = m.autor === 'usuario' ? 'Usuario' : 'Asistente';
      return `[${formatearHoraMensaje(m.enviadoEn)}] ${etiqueta}: ${m.texto}`;
    });
    partes.push(`Conversación con el asistente:\n${lineas.join('\n')}`);
  }
  return partes.join('\n\n');
}

/**
 * Adaptador de agencia de viajes (inspirado en Zendesk Tickets, specs/externos/agencia.md).
 * Crea casos con resumen, historial de conversación y contacto opcional del usuario.
 */
export function crearAdaptadorAgencia(opciones: OpcionesAdaptadorAgencia): AdaptadorAgencia {
  const {
    nombre,
    url,
    claveApi,
    tiempoMaximoMs = 2000,
    ahora = Date.now,
    fetch: hacerFetch = fetch,
  } = opciones;

  const baseUrl = url.replace(/\/+$/, '');

  async function crearCaso(datos: DatosCrearCaso): Promise<CasoCreado> {
    const vieneDeAsistente = datos.conversacion.length > 0;
    const ticket: Record<string, unknown> = {
      subject: armarAsunto(datos.resumen),
      comment: { body: armarCuerpo(datos.resumen, datos.conversacion) },
      priority: vieneDeAsistente ? 'high' : 'normal',
      external_id: datos.usuarioId,
      tags: vieneDeAsistente ? ['trotamundos', 'asistente-virtual'] : ['trotamundos'],
      ...(datos.contacto
        ? { requester: { name: datos.contacto.nombre, email: datos.contacto.email } }
        : {}),
    };

    const respuesta = await llamarProveedorHttp(
      hacerFetch,
      `${baseUrl}/api/v2/tickets`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${claveApi}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ticket }),
      },
      tiempoMaximoMs,
      nombre,
    );

    if (respuesta.status === 503) {
      throw new ErrorProveedorExterno(
        503,
        'tercero-no-disponible',
        `La agencia ${nombre} no está disponible en este momento.`,
      );
    }
    if (!respuesta.ok) {
      throw new ErrorProveedorExterno(
        502,
        'error-tercero',
        `La agencia ${nombre} respondió ${respuesta.status} al crear el caso.`,
      );
    }

    let cuerpo: unknown;
    try {
      cuerpo = await respuesta.json();
    } catch (error) {
      throw new ErrorProveedorExterno(
        502,
        'error-tercero',
        `La agencia ${nombre} devolvió una respuesta inválida.`,
        error,
      );
    }

    const ticketResp = esObjeto(cuerpo) ? cuerpo.ticket : undefined;
    const idCrudo = esObjeto(ticketResp) ? ticketResp.id : undefined;
    const numeroCaso =
      typeof idCrudo === 'number' && Number.isFinite(idCrudo)
        ? String(idCrudo)
        : esCadenaNoVacia(idCrudo)
          ? idCrudo.trim()
          : undefined;
    if (!numeroCaso) {
      throw new ErrorProveedorExterno(
        502,
        'error-tercero',
        `La agencia ${nombre} no devolvió un número de caso válido.`,
      );
    }

    const creadoCrudo = esObjeto(ticketResp) ? ticketResp.created_at : undefined;
    const creadoEn = esFechaIsoValida(creadoCrudo) ? creadoCrudo : new Date(ahora()).toISOString();

    return {
      agencia: nombre,
      numeroCaso,
      creadoEn,
    };
  }

  return {
    nombre,
    tipo: 'agencia',
    crearCaso,
  };
}
