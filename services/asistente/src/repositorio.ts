import { randomUUID } from 'node:crypto';
import { enTransaccion, type ClienteDb, type Pool, type Region } from '@trotamundos/comun';
import type {
  CasoDerivado,
  FuncionNoDisponible,
  MensajeHistorial,
  OpcionReprogramacion,
  ReservaResumen,
  ResultadoMensaje,
} from './plugins/tipos.ts';
import type { IdiomaAsistente, IntencionDetectada } from './reglas.ts';

type Ejecutor = Pool | ClienteDb;

export interface ConversacionCabecera {
  conversacionId: string;
  usuarioId: string;
  region: Region;
  idioma: IdiomaAsistente;
  intentosFallidos: number;
  ofreceDerivar: boolean;
  consultando: boolean;
  ultimaSecuencia: number;
  creadaEn: string;
  actualizadaEn: string;
}

export interface ConversacionCompleta {
  conversacionId: string;
  usuarioId: string;
  region: Region;
  idioma: IdiomaAsistente;
  creadaEn: string;
  actualizadaEn: string;
  consultando: boolean;
  mensajes: MensajeHistorial[];
}

interface FilaConversacion {
  conversacion_id: string;
  usuario_id: string;
  region: Region;
  idioma: IdiomaAsistente;
  intentos_fallidos: number;
  ofrece_derivar: boolean;
  consultando: boolean;
  ultima_secuencia: number;
  creada_en: Date | string;
  actualizada_en: Date | string;
}

interface DatosMensajeJson {
  confirmacion?: { opcionId: string };
  reservas?: ReservaResumen[];
  opciones?: OpcionReprogramacion[];
  caso?: CasoDerivado;
  noDisponible?: FuncionNoDisponible;
  ofreceDerivar?: boolean;
}

interface FilaMensaje {
  mensaje_id: string;
  secuencia: number;
  autor: 'usuario' | 'asistente';
  texto: string;
  enviado_en: Date | string;
  intencion: IntencionDetectada | null;
  resultado: ResultadoMensaje | null;
  datos: DatosMensajeJson | null;
}

interface FilaOpcionPendiente {
  opcion_id: string;
  proveedor: string;
  numero_reserva: string;
  tipo_reserva: 'vuelo' | 'hotel' | 'auto';
  inicio: string;
  fin: string;
  origen: string | null;
  destino: string;
  descripcion: string | null;
}

function aIso(valor: Date | string): string {
  return valor instanceof Date ? valor.toISOString() : new Date(valor).toISOString();
}

function mapearConversacion(fila: FilaConversacion): ConversacionCabecera {
  return {
    conversacionId: fila.conversacion_id,
    usuarioId: fila.usuario_id,
    region: fila.region,
    idioma: fila.idioma,
    intentosFallidos: fila.intentos_fallidos,
    ofreceDerivar: fila.ofrece_derivar,
    consultando: fila.consultando,
    ultimaSecuencia: fila.ultima_secuencia,
    creadaEn: aIso(fila.creada_en),
    actualizadaEn: aIso(fila.actualizada_en),
  };
}

function mapearMensaje(fila: FilaMensaje): MensajeHistorial {
  const datos = fila.datos ?? {};
  return {
    mensajeId: fila.mensaje_id,
    secuencia: fila.secuencia,
    autor: fila.autor,
    texto: fila.texto,
    enviadoEn: aIso(fila.enviado_en),
    ...(fila.intencion ? { intencion: fila.intencion } : {}),
    ...(fila.resultado ? { resultado: fila.resultado } : {}),
    ...(datos.confirmacion ? { confirmacion: datos.confirmacion } : {}),
    ...(datos.reservas ? { reservas: datos.reservas } : {}),
    ...(datos.opciones && datos.opciones.length > 0 ? { opciones: datos.opciones } : {}),
    ...(datos.caso ? { caso: datos.caso } : {}),
    ...(datos.noDisponible ? { noDisponible: datos.noDisponible } : {}),
    ...(datos.ofreceDerivar !== undefined ? { ofreceDerivar: datos.ofreceDerivar } : {}),
  };
}

export async function crearConversacion(
  pool: Pool,
  datos: {
    usuarioId: string;
    region: Region;
    idioma: IdiomaAsistente;
    saludo: string;
    ahora: Date;
  },
): Promise<ConversacionCompleta> {
  const conversacionId = randomUUID();
  const mensajeId = randomUUID();
  const fechaIso = datos.ahora.toISOString();

  return enTransaccion(pool, async (cliente) => {
    await cliente.query(
      `INSERT INTO conversaciones
         (conversacion_id, usuario_id, region, idioma, ultima_secuencia, creada_en, actualizada_en)
       VALUES ($1, $2, $3, $4, 1, $5::timestamptz, $5::timestamptz)`,
      [conversacionId, datos.usuarioId, datos.region, datos.idioma, fechaIso],
    );

    const { rows } = await cliente.query<FilaMensaje>(
      `INSERT INTO mensajes
         (mensaje_id, conversacion_id, secuencia, autor, texto, enviado_en, resultado, datos)
       VALUES ($1, $2, 1, 'asistente', $3, $4::timestamptz, 'respondido', '{}'::jsonb)
       RETURNING mensaje_id, secuencia, autor, texto, enviado_en, intencion, resultado, datos`,
      [mensajeId, conversacionId, datos.saludo, fechaIso],
    );

    const saludoFila = rows[0];
    if (!saludoFila) throw new Error('No se pudo crear el mensaje de saludo.');

    return {
      conversacionId,
      usuarioId: datos.usuarioId,
      region: datos.region,
      idioma: datos.idioma,
      creadaEn: fechaIso,
      actualizadaEn: fechaIso,
      consultando: false,
      mensajes: [mapearMensaje(saludoFila)],
    };
  });
}

export async function obtenerConversacionCabecera(
  db: Ejecutor,
  conversacionId: string,
): Promise<ConversacionCabecera | undefined> {
  const { rows } = await db.query<FilaConversacion>(
    `SELECT conversacion_id, usuario_id, region, idioma, intentos_fallidos, ofrece_derivar,
            consultando, ultima_secuencia, creada_en, actualizada_en
       FROM conversaciones
      WHERE conversacion_id = $1`,
    [conversacionId],
  );
  const fila = rows[0];
  return fila ? mapearConversacion(fila) : undefined;
}

export async function listarMensajes(
  db: Ejecutor,
  conversacionId: string,
  desde = 0,
): Promise<MensajeHistorial[]> {
  const { rows } = await db.query<FilaMensaje>(
    `SELECT mensaje_id, secuencia, autor, texto, enviado_en, intencion, resultado, datos
       FROM mensajes
      WHERE conversacion_id = $1 AND secuencia > $2
      ORDER BY secuencia ASC`,
    [conversacionId, desde],
  );
  return rows.map(mapearMensaje);
}

export interface NuevoMensajeDb {
  autor: 'usuario' | 'asistente';
  texto: string;
  enviadoEn: Date;
  intencion?: IntencionDetectada;
  resultado?: ResultadoMensaje;
  confirmacion?: { opcionId: string };
  reservas?: ReservaResumen[];
  opciones?: OpcionReprogramacion[];
  caso?: CasoDerivado;
  noDisponible?: FuncionNoDisponible;
  ofreceDerivar?: boolean;
}

export async function agregarMensaje(
  pool: Pool,
  conversacionId: string,
  datos: NuevoMensajeDb,
): Promise<MensajeHistorial> {
  const mensajeId = randomUUID();
  const fechaIso = datos.enviadoEn.toISOString();
  const extras: DatosMensajeJson = {
    ...(datos.confirmacion ? { confirmacion: datos.confirmacion } : {}),
    ...(datos.reservas ? { reservas: datos.reservas } : {}),
    ...(datos.opciones && datos.opciones.length > 0 ? { opciones: datos.opciones } : {}),
    ...(datos.caso ? { caso: datos.caso } : {}),
    ...(datos.noDisponible ? { noDisponible: datos.noDisponible } : {}),
    ...(datos.ofreceDerivar !== undefined ? { ofreceDerivar: datos.ofreceDerivar } : {}),
  };

  return enTransaccion(pool, async (cliente) => {
    const seqRes = await cliente.query<{ ultima_secuencia: number }>(
      `UPDATE conversaciones
          SET ultima_secuencia = ultima_secuencia + 1,
              actualizada_en = $2::timestamptz
        WHERE conversacion_id = $1
        RETURNING ultima_secuencia`,
      [conversacionId, fechaIso],
    );
    const secuencia = seqRes.rows[0]?.ultima_secuencia;
    if (secuencia === undefined) {
      throw new Error(`Conversación ${conversacionId} no encontrada al agregar mensaje.`);
    }

    const { rows } = await cliente.query<FilaMensaje>(
      `INSERT INTO mensajes
         (mensaje_id, conversacion_id, secuencia, autor, texto, enviado_en, intencion, resultado, datos)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::jsonb)
       RETURNING mensaje_id, secuencia, autor, texto, enviado_en, intencion, resultado, datos`,
      [
        mensajeId,
        conversacionId,
        secuencia,
        datos.autor,
        datos.texto,
        fechaIso,
        datos.intencion ?? null,
        datos.resultado ?? null,
        JSON.stringify(extras),
      ],
    );
    const fila = rows[0];
    if (!fila) throw new Error('No se pudo insertar el mensaje.');
    return mapearMensaje(fila);
  });
}

export async function actualizarEstadoConversacion(
  db: Ejecutor,
  conversacionId: string,
  cambios: {
    intentosFallidos?: number;
    ofreceDerivar?: boolean;
    consultando?: boolean;
    actualizadaEn?: Date;
  },
): Promise<void> {
  const asignaciones: string[] = [];
  const parametros: unknown[] = [conversacionId];

  if (cambios.intentosFallidos !== undefined) {
    parametros.push(cambios.intentosFallidos);
    asignaciones.push(`intentos_fallidos = $${parametros.length}`);
  }
  if (cambios.ofreceDerivar !== undefined) {
    parametros.push(cambios.ofreceDerivar);
    asignaciones.push(`ofrece_derivar = $${parametros.length}`);
  }
  if (cambios.consultando !== undefined) {
    parametros.push(cambios.consultando);
    asignaciones.push(`consultando = $${parametros.length}`);
  }
  if (cambios.actualizadaEn !== undefined) {
    parametros.push(cambios.actualizadaEn.toISOString());
    asignaciones.push(`actualizada_en = $${parametros.length}::timestamptz`);
  }
  if (asignaciones.length === 0) return;

  await db.query(
    `UPDATE conversaciones SET ${asignaciones.join(', ')} WHERE conversacion_id = $1`,
    parametros,
  );
}

export async function reemplazarOpcionesPendientes(
  pool: Pool,
  conversacionId: string,
  opciones: OpcionReprogramacion[],
): Promise<void> {
  await enTransaccion(pool, async (cliente) => {
    await cliente.query('DELETE FROM opciones_pendientes WHERE conversacion_id = $1', [
      conversacionId,
    ]);
    for (const op of opciones) {
      await cliente.query(
        `INSERT INTO opciones_pendientes
           (conversacion_id, opcion_id, proveedor, numero_reserva, tipo_reserva, inicio, fin, origen, destino, descripcion)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          conversacionId,
          op.opcionId,
          op.proveedor,
          op.numeroReserva,
          op.tipoReserva,
          op.inicio,
          op.fin,
          op.origen ?? null,
          op.destino,
          op.descripcion ?? null,
        ],
      );
    }
  });
}

export async function obtenerOpcionPendiente(
  db: Ejecutor,
  conversacionId: string,
  opcionId: string,
): Promise<OpcionReprogramacion | undefined> {
  const { rows } = await db.query<FilaOpcionPendiente>(
    `SELECT opcion_id, proveedor, numero_reserva, tipo_reserva, inicio, fin, origen, destino, descripcion
       FROM opciones_pendientes
      WHERE conversacion_id = $1 AND opcion_id = $2`,
    [conversacionId, opcionId],
  );
  const fila = rows[0];
  if (!fila) return undefined;
  return {
    opcionId: fila.opcion_id,
    proveedor: fila.proveedor,
    numeroReserva: fila.numero_reserva,
    tipoReserva: fila.tipo_reserva,
    inicio: fila.inicio,
    fin: fila.fin,
    ...(fila.origen !== null ? { origen: fila.origen } : {}),
    destino: fila.destino,
    ...(fila.descripcion !== null ? { descripcion: fila.descripcion } : {}),
  };
}

export async function limpiarOpcionesPendientes(
  db: Ejecutor,
  conversacionId: string,
): Promise<void> {
  await db.query('DELETE FROM opciones_pendientes WHERE conversacion_id = $1', [conversacionId]);
}
