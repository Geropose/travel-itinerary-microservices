import { randomUUID } from 'node:crypto';
import {
  ErrorProveedorExterno,
  esCadenaNoVacia,
  esFechaIsoValida,
  esObjeto,
  llamarProveedorHttp,
} from './tipos.ts';

export interface ReservaItinerarioPublico {
  tipoReserva: 'vuelo' | 'hotel' | 'auto';
  descripcion: string;
  inicio: string;
  fin?: string;
  origen?: string;
  destino?: string;
}

export interface ItinerarioPublico {
  viajeId: string;
  destino: string;
  inicio: string;
  fin: string;
  reservas: ReservaItinerarioPublico[];
}

export interface PublicacionCreada {
  red: string;
  url: string;
  publicadaEn: string;
}

/** Interfaz común de adaptadores de redes sociales (Iteración 3, ADR-003, QA-7). */
export interface AdaptadorRedSocial {
  readonly nombre: string;
  readonly tipo: string;
  publicarItinerario(itinerario: ItinerarioPublico, idioma?: string): Promise<PublicacionCreada>;
}

export interface OpcionesAdaptadorRedSocial {
  nombre: string;
  url: string;
  token: string;
  tiempoMaximoMs?: number;
  ahora?: () => number;
  fetch?: typeof fetch;
}

const MAX_CARACTERES_ESTADO = 500;

function normalizarIdioma(idioma: string | undefined): 'es' | 'en' {
  return idioma?.toLowerCase().startsWith('en') ? 'en' : 'es';
}

function formatearFechaCorta(iso: string, idioma: 'es' | 'en'): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat(idioma === 'en' ? 'en-US' : 'es-AR', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(fecha);
}

function formatearFechaHoraReserva(iso: string): string {
  // Conservamos la hora local que trae la reserva ISO (DD/MM HH:mm) sin perder el huso del evento.
  const match = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(iso);
  if (match?.[1] && match[2] && match[3]) {
    return `${match[2]}/${match[1]} ${match[3]}`;
  }
  return iso.slice(0, 16);
}

/**
 * Arma el texto público del itinerario (máx. 500 caracteres, sin números de reserva ni PII,
 * specs/externos/redsocial.md). Si excede 500 caracteres recorta las últimas reservas y añade `…`.
 */
export function formatearTextoItinerario(
  itinerario: ItinerarioPublico,
  idiomaCrudo?: string,
): string {
  const idioma = normalizarIdioma(idiomaCrudo);
  const desde = formatearFechaCorta(itinerario.inicio, idioma);
  const hasta = formatearFechaCorta(itinerario.fin, idioma);
  const tituloBase =
    idioma === 'en'
      ? `Heading to ${itinerario.destino} (${desde} – ${hasta})`
      : `Me voy de viaje a ${itinerario.destino} (${desde} – ${hasta})`;

  const titulo =
    tituloBase.length > MAX_CARACTERES_ESTADO
      ? `${tituloBase.slice(0, MAX_CARACTERES_ESTADO - 1).trimEnd()}…`
      : tituloBase;

  const lineasReservas = itinerario.reservas.map((r) => {
    const fecha = formatearFechaHoraReserva(r.inicio);
    const tramo = r.origen && r.destino ? ` ${r.origen} → ${r.destino}` : '';
    return `${fecha} ${r.descripcion}${tramo}`.trim();
  });

  const lineas: string[] = [titulo];
  let recortado = false;

  for (const linea of lineasReservas) {
    const candidato = [...lineas, linea].join('\n');
    // Reservamos 2 caracteres ("\n…") si todavía quedan reservas detrás.
    if (candidato.length <= MAX_CARACTERES_ESTADO) {
      lineas.push(linea);
    } else {
      recortado = true;
      break;
    }
  }

  let resultado = lineas.join('\n');
  if (recortado) {
    while (resultado.length + 2 > MAX_CARACTERES_ESTADO && lineas.length > 1) {
      lineas.pop();
      resultado = lineas.join('\n');
    }
    resultado =
      resultado.length + 2 <= MAX_CARACTERES_ESTADO
        ? `${resultado}\n…`
        : `${resultado.slice(0, MAX_CARACTERES_ESTADO - 1).trimEnd()}…`;
  }

  return resultado;
}

/**
 * Adaptador de red social (inspirado en Mastodon, specs/externos/redsocial.md).
 * Publica itinerarios con `Idempotency-Key` en menos de 3 s (QA-7).
 */
export function crearAdaptadorRedSocial(opciones: OpcionesAdaptadorRedSocial): AdaptadorRedSocial {
  const {
    nombre,
    url,
    token,
    tiempoMaximoMs = 2500,
    ahora = Date.now,
    fetch: hacerFetch = fetch,
  } = opciones;

  const baseUrl = url.replace(/\/+$/, '');

  async function publicarItinerario(
    itinerario: ItinerarioPublico,
    idiomaCrudo?: string,
  ): Promise<PublicacionCreada> {
    const idioma = normalizarIdioma(idiomaCrudo);
    const status = formatearTextoItinerario(itinerario, idioma);

    const respuesta = await llamarProveedorHttp(
      hacerFetch,
      `${baseUrl}/api/v1/statuses`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          status,
          visibility: 'public',
          language: idioma,
        }),
      },
      tiempoMaximoMs,
      nombre,
    );

    if (respuesta.status === 503) {
      throw new ErrorProveedorExterno(
        503,
        'tercero-no-disponible',
        `La red social ${nombre} no está disponible en este momento.`,
      );
    }
    if (!respuesta.ok) {
      throw new ErrorProveedorExterno(
        502,
        'error-tercero',
        `La red social ${nombre} respondió ${respuesta.status} al publicar el itinerario.`,
      );
    }

    let cuerpo: unknown;
    try {
      cuerpo = await respuesta.json();
    } catch (error) {
      throw new ErrorProveedorExterno(
        502,
        'error-tercero',
        `La red social ${nombre} devolvió una respuesta inválida.`,
        error,
      );
    }

    const urlPublicacion = esObjeto(cuerpo) ? cuerpo.url : undefined;
    if (!esCadenaNoVacia(urlPublicacion)) {
      throw new ErrorProveedorExterno(
        502,
        'error-tercero',
        `La red social ${nombre} no devolvió la URL de la publicación.`,
      );
    }
    const creadaCruda = esObjeto(cuerpo) ? cuerpo.created_at : undefined;
    const publicadaEn = esFechaIsoValida(creadaCruda)
      ? creadaCruda
      : new Date(ahora()).toISOString();

    return {
      red: nombre,
      url: urlPublicacion.trim(),
      publicadaEn,
    };
  }

  return {
    nombre,
    tipo: 'redsocial',
    publicarItinerario,
  };
}
