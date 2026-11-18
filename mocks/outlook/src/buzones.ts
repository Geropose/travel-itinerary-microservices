// Buzones del mock de Outlook, en memoria: el usuario de cada buzón y sus mensajes con el formato del
// recurso `message` de Graph (specs/externos/outlook.md, sección 2).
import { createHash, randomBytes } from 'node:crypto';
import { remitente, type Correo, type Etiqueta } from '@trotamundos/mocks-comun';

export interface Guardado {
  id: string;
  etag: string;
  correo: Correo;
  etiqueta?: Etiqueta;
}

export interface Buzon {
  email: string;
  /** id del usuario en Microsoft Entra (un GUID). */
  id: string;
  /** Cuenta personal: Graph devuelve `mail` en null y hay que usar userPrincipalName (1.6). */
  personal: boolean;
  /** Del más viejo al más nuevo. */
  guardados: Guardado[];
}

export interface Almacen {
  buscar(email: string): Buzon | undefined;
  /** Devuelve el buzón; si no existe, lo crea vacío. */
  obtener(email: string): Buzon;
  todos(): Buzon[];
  agregar(email: string, correo: Correo, etiqueta?: Etiqueta): Guardado;
}

/** GUID fijo para cada dirección, así el id del usuario no cambia al reiniciar el mock. */
function guid(texto: string): string {
  const h = createHash('sha256').update(texto).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Id con la forma de los de Exchange (AAMkAG...), seguro para usar en la URL. */
const nuevoId = () => `AAMkAG${randomBytes(105).toString('base64url')}AAA=`;

/** ETag con la forma de los de Exchange. */
const nuevoEtag = () => `W/"CQAAABYAAAD${randomBytes(15).toString('base64url')}"`;

/** Fecha como la manda Graph: sin milisegundos y en UTC (2026-11-28T12:12:30Z). */
export const fechaGraph = (fecha: Date | number) =>
  `${new Date(fecha).toISOString().slice(0, 19)}Z`;

/**
 * @param alAgregar se llama después de agregar cada correo (para las change notifications).
 */
export function crearAlmacen(
  alAgregar: (buzon: Buzon, guardado: Guardado) => void = () => undefined,
): Almacen {
  const buzones = new Map<string, Buzon>();
  const clave = (email: string) => email.trim().toLowerCase();

  function obtener(email: string): Buzon {
    const k = clave(email);
    let buzon = buzones.get(k);
    if (!buzon) {
      buzon = { email: k, id: guid(k), personal: false, guardados: [] };
      buzones.set(k, buzon);
    }
    return buzon;
  }

  return {
    buscar: (email) => buzones.get(clave(email)),
    obtener,
    todos: () => [...buzones.values()],
    agregar(email, correo, etiqueta) {
      const buzon = obtener(email);
      const guardado: Guardado = {
        id: nuevoId(),
        etag: nuevoEtag(),
        correo,
        ...(etiqueta ? { etiqueta } : {}),
      };
      buzon.guardados.push(guardado);
      alAgregar(buzon, guardado);
      return guardado;
    },
  };
}

const escapar = (texto: string) =>
  texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Graph convierte a HTML un correo de solo texto cuando se pide el cuerpo en HTML. */
const textoAHtml = (texto: string) =>
  `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body><div>${escapar(texto).replace(/\n/g, '<br>')}</div></body></html>`;

/** Recurso `message` de Graph con todas las propiedades que imita el mock. */
export function aMensaje(buzon: Buzon, g: Guardado, cuerpo: 'html' | 'text') {
  const fecha = fechaGraph(g.correo.fecha);
  const de = remitente(g.correo.de);
  const direccion = { emailAddress: { name: de.nombre, address: de.direccion } };
  const preview = g.correo.texto.replace(/\s+/g, ' ').trim().slice(0, 255);
  return {
    '@odata.etag': g.etag,
    id: g.id,
    createdDateTime: fecha,
    lastModifiedDateTime: fecha,
    receivedDateTime: fecha,
    sentDateTime: fecha,
    hasAttachments: false,
    internetMessageId: `<${g.id.slice(6, 22)}@${de.direccion.split('@')[1] ?? 'mock'}>`,
    subject: g.correo.asunto,
    bodyPreview: preview,
    importance: 'normal',
    parentFolderId: `AAMkAG${buzon.id.replace(/-/g, '')}AAEMAAA=`,
    conversationId: `AAQkAG${g.id.slice(6, 40)}=`,
    isRead: false,
    body:
      cuerpo === 'text'
        ? { contentType: 'text', content: g.correo.texto }
        : { contentType: 'html', content: g.correo.html ?? textoAHtml(g.correo.texto) },
    sender: direccion,
    from: direccion,
    toRecipients: [{ emailAddress: { name: buzon.email, address: buzon.email } }],
  };
}

export type Mensaje = ReturnType<typeof aMensaje>;

/** Propiedades que se pueden pedir en $select. */
export const PROPIEDADES = [
  'id',
  'createdDateTime',
  'lastModifiedDateTime',
  'receivedDateTime',
  'sentDateTime',
  'hasAttachments',
  'internetMessageId',
  'subject',
  'bodyPreview',
  'importance',
  'parentFolderId',
  'conversationId',
  'isRead',
  'body',
  'sender',
  'from',
  'toRecipients',
] as const;
