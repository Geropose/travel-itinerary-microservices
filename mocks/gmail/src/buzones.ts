// Buzones del mock, en memoria. Cada buzón guarda sus mensajes, su historial de cambios (para
// users.history.list) y su watch activo (para los avisos push).
import { armarPayload, fragmento, type Correo, type MessagePart } from './mime.ts';

/** Etiqueta que el generador pone en cada correo, para las pruebas (no la ve la Gmail API). */
export interface Etiqueta {
  tipo: string;
  reserva?: { tipoReserva: string; proveedor: string; numeroReserva: string; estado: string };
}

/** Recurso `Message` de Gmail (specs/externos/gmail.md, sección 3). */
export interface Mensaje {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  historyId: string;
  internalDate: string;
  sizeEstimate: number;
  payload: MessagePart;
}

export interface Guardado {
  mensaje: Mensaje;
  de: string;
  etiqueta?: Etiqueta;
}

export interface Watch {
  topicName: string;
  labelIds: string[];
  /** labelFilterBehavior=exclude: avisa por los cambios que no tienen esas etiquetas. */
  excluir: boolean;
  expiration: number;
}

export interface Buzon {
  email: string;
  /** historyId más viejo que se puede pedir en history.list (antes de eso, 404). */
  historyIdInicial: number;
  historyId: number;
  /** Del más viejo al más nuevo. */
  guardados: Guardado[];
  /** Un registro por correo agregado: historyId y el mensaje. */
  historial: { id: number; mensajeId: string }[];
  watch?: Watch;
}

/** Primer historyId de cada buzón nuevo. */
const HISTORY_ID_INICIAL = 1000;

export interface Almacen {
  buscar(email: string): Buzon | undefined;
  /** Devuelve el buzón; si no existe, lo crea vacío. */
  obtener(email: string): Buzon;
  todos(): Buzon[];
  agregar(email: string, correo: Correo, etiqueta?: Etiqueta): Mensaje;
}

/**
 * @param alAgregar se llama después de agregar cada correo (para el aviso push).
 */
export function crearAlmacen(alAgregar: (buzon: Buzon) => void = () => undefined): Almacen {
  const buzones = new Map<string, Buzon>();
  let secuencia = 0;

  const clave = (email: string) => email.trim().toLowerCase();

  /** Id de 16 dígitos hexadecimales, como los de Gmail, ordenable por fecha. */
  function nuevoId(fecha: Date): string {
    secuencia = (secuencia + 1) % 0x100000;
    return fecha.getTime().toString(16).padStart(11, '0') + secuencia.toString(16).padStart(5, '0');
  }

  function obtener(email: string): Buzon {
    const k = clave(email);
    let buzon = buzones.get(k);
    if (!buzon) {
      buzon = {
        email: k,
        historyIdInicial: HISTORY_ID_INICIAL,
        historyId: HISTORY_ID_INICIAL,
        guardados: [],
        historial: [],
      };
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
      const id = nuevoId(correo.fecha);
      buzon.historyId += 1;
      const payload = armarPayload(correo, id);
      const mensaje: Mensaje = {
        id,
        threadId: id,
        labelIds: ['INBOX', 'UNREAD'],
        snippet: fragmento(correo.texto),
        historyId: String(buzon.historyId),
        internalDate: String(correo.fecha.getTime()),
        sizeEstimate:
          Buffer.byteLength(correo.texto, 'utf8') +
          Buffer.byteLength(correo.html ?? '', 'utf8') +
          500,
        payload,
      };
      buzon.guardados.push({ mensaje, de: correo.de, ...(etiqueta ? { etiqueta } : {}) });
      buzon.historial.push({ id: buzon.historyId, mensajeId: id });
      alAgregar(buzon);
      return mensaje;
    },
  };
}
