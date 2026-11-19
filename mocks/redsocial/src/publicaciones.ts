// Almacén en memoria de publicaciones de la red social (specs/externos/redsocial.md) con soporte
// de Idempotency-Key por 1 hora, tal como Mastodon.

export type Visibilidad = 'public' | 'unlisted' | 'private' | 'direct';

export interface EstadoMastodon {
  id: string;
  created_at: string;
  visibility: Visibilidad;
  language: string;
  uri: string;
  url: string;
  content: string;
}

export interface PublicacionGuardada extends EstadoMastodon {
  textoOriginal: string;
  idempotencyKey?: string;
}

export interface AlmacenPublicaciones {
  publicar(datos: {
    status: string;
    visibility: Visibilidad;
    language: string;
    idempotencyKey?: string;
  }): EstadoMastodon;
  listar(): PublicacionGuardada[];
  limpiar(): void;
}

const TTL_IDEMPOTENCIA_MS = 60 * 60 * 1000;

function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function aHtml(texto: string): string {
  return `<p>${escaparHtml(texto).replace(/\r?\n/g, '<br />')}</p>`;
}

function aRespuestaPublica(p: PublicacionGuardada): EstadoMastodon {
  return {
    id: p.id,
    created_at: p.created_at,
    visibility: p.visibility,
    language: p.language,
    uri: p.uri,
    url: p.url,
    content: p.content,
  };
}

export function crearAlmacenPublicaciones(opciones: {
  urlPublica: string;
  cuenta: string;
  reloj?: () => number;
}): AlmacenPublicaciones {
  const { cuenta, reloj = Date.now } = opciones;
  const baseUrl = opciones.urlPublica.replace(/\/+$/, '');
  const publicaciones: PublicacionGuardada[] = [];
  const porClave = new Map<string, { venceEnMs: number; publicacion: PublicacionGuardada }>();
  let seqId = 103254962155278888n;

  return {
    publicar({ status, visibility, language, idempotencyKey }) {
      const ahoraMs = reloj();
      if (idempotencyKey) {
        const previa = porClave.get(idempotencyKey);
        if (previa && previa.venceEnMs > ahoraMs) {
          return aRespuestaPublica(previa.publicacion);
        }
      }

      const id = String(seqId++);
      const creada: PublicacionGuardada = {
        id,
        created_at: new Date(ahoraMs).toISOString(),
        visibility,
        language,
        uri: `${baseUrl}/users/${cuenta}/statuses/${id}`,
        url: `${baseUrl}/@${cuenta}/${id}`,
        content: aHtml(status),
        textoOriginal: status,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
      publicaciones.push(creada);
      if (idempotencyKey) {
        porClave.set(idempotencyKey, {
          venceEnMs: ahoraMs + TTL_IDEMPOTENCIA_MS,
          publicacion: creada,
        });
      }
      return aRespuestaPublica(creada);
    },

    listar() {
      return publicaciones.map((p) => ({ ...p }));
    },

    limpiar() {
      publicaciones.length = 0;
      porClave.clear();
      seqId = 103254962155278888n;
    },
  };
}
