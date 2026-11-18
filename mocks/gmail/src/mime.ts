// Arma el árbol MIME de un correo con el formato de Gmail (`MessagePart`, specs/externos/gmail.md,
// sección 3): headers en la parte de arriba y en cada parte, y `body.data` en base64url.
import { direccion, type Correo } from '@trotamundos/mocks-comun';

export interface Header {
  name: string;
  value: string;
}

export interface MessagePart {
  partId: string;
  mimeType: string;
  filename: string;
  headers: Header[];
  body: { size: number; data?: string };
  parts?: MessagePart[];
}

/** base64url (RFC 4648, sección 5): alfabeto `-` y `_`, sin relleno. */
export const aBase64url = (texto: string) => Buffer.from(texto, 'utf8').toString('base64url');

export const deBase64url = (datos: string) => Buffer.from(datos, 'base64url').toString('utf8');

/** Fecha con el formato del header Date (RFC 5322), en UTC. */
export const fechaRfc5322 = (fecha: Date) => fecha.toUTCString().replace('GMT', '+0000');

function parte(partId: string, mimeType: string, contenido: string): MessagePart {
  return {
    partId,
    mimeType,
    filename: '',
    headers: [{ name: 'Content-Type', value: `${mimeType}; charset=UTF-8` }],
    body: { size: Buffer.byteLength(contenido, 'utf8'), data: aBase64url(contenido) },
  };
}

export function armarPayload(correo: Correo, messageId: string): MessagePart {
  const headers: Header[] = [
    { name: 'MIME-Version', value: '1.0' },
    { name: 'From', value: correo.de },
    { name: 'To', value: correo.para },
    { name: 'Subject', value: correo.asunto },
    { name: 'Date', value: fechaRfc5322(correo.fecha) },
    { name: 'Message-ID', value: `<${messageId}@${direccion(correo.de).split('@')[1] ?? 'mock'}>` },
  ];
  if (!correo.html) {
    // Correo de una sola parte: el cuerpo va directo en la parte de arriba.
    const unica = parte('', 'text/plain', correo.texto);
    return { ...unica, headers: [...headers, ...unica.headers] };
  }
  const limite = `limite-${messageId}`;
  return {
    partId: '',
    mimeType: 'multipart/alternative',
    filename: '',
    headers: [
      ...headers,
      { name: 'Content-Type', value: `multipart/alternative; boundary="${limite}"` },
    ],
    // Las partes contenedoras multipart/* no tienen datos.
    body: { size: 0 },
    parts: [parte('0', 'text/plain', correo.texto), parte('1', 'text/html', correo.html)],
  };
}

/** Primeros caracteres del texto, como el `snippet` de Gmail. */
export function fragmento(texto: string, largo = 120): string {
  const plano = texto.replace(/\s+/g, ' ').trim();
  return plano.length > largo ? `${plano.slice(0, largo - 1)}…` : plano;
}
