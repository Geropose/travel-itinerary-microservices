// Un correo tal como lo escribe el remitente, antes de que cada mock lo guarde con el formato de su
// proveedor (Gmail: árbol MIME en base64url; Outlook: mensaje de Graph con el cuerpo en texto).

export interface Correo {
  /** Header From, por ejemplo "Aerolínea Andina <reservas@aerolinea-andina.example>". */
  de: string;
  para: string;
  asunto: string;
  fecha: Date;
  texto: string;
  /** Si tiene HTML, el correo tiene texto y HTML; si no, solo texto. */
  html?: string;
}

/** Lo que el generador sabe de cada correo, para las pruebas (no lo ve la API del proveedor). */
export interface Etiqueta {
  tipo: string;
  reserva?: { tipoReserva: string; proveedor: string; numeroReserva: string; estado: string };
}

/** Nombre y dirección de un header From ("Nombre <dir>" o solo "dir"). */
export function remitente(header: string): { nombre: string; direccion: string } {
  const partes = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(header);
  const direccion = (partes?.[2] ?? header).trim().toLowerCase();
  const nombre = partes?.[1]?.replace(/^"|"$/g, '');
  return { nombre: nombre || direccion, direccion };
}

/** Dirección de correo dentro de un header From. */
export const direccion = (header: string) => remitente(header).direccion;
