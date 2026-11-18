// Persistencia PostgreSQL de viajes y reservas (ADR-001, P2.C1).
import { randomUUID } from 'node:crypto';
import type { ClienteDb, Pool } from '@trotamundos/comun';
import type { ResumenViaje } from './agrupacion.ts';
import type {
  EstadoReserva,
  EstadoViaje,
  OrigenCambio,
  Reserva,
  TipoReserva,
  Viaje,
  ViajeConReservas,
} from './modelo.ts';

export type Db = Pool | ClienteDb;

interface FilaViaje {
  id: string;
  usuario_id: string;
  nombre: string;
  destino: string;
  inicio: Date;
  fin: Date;
  estado: EstadoViaje;
}

interface FilaReserva {
  id: string;
  viaje_id: string;
  usuario_id: string;
  proveedor: string;
  tipo_reserva: TipoReserva;
  numero_reserva: string;
  inicio: Date;
  fin: Date;
  origen: string | null;
  destino: string;
  detalle: Record<string, unknown>;
  estado: EstadoReserva;
  origen_cambio: OrigenCambio;
  correo_id: string | null;
  actualizado_en: Date;
}

function mapearViaje(f: FilaViaje): Viaje {
  return {
    viajeId: f.id,
    usuarioId: f.usuario_id,
    nombre: f.nombre,
    destino: f.destino,
    inicio: f.inicio.toISOString(),
    fin: f.fin.toISOString(),
    estado: f.estado,
  };
}

function mapearReserva(f: FilaReserva): Reserva {
  return {
    reservaId: f.id,
    viajeId: f.viaje_id,
    usuarioId: f.usuario_id,
    proveedor: f.proveedor,
    tipoReserva: f.tipo_reserva,
    numeroReserva: f.numero_reserva,
    inicio: f.inicio.toISOString(),
    fin: f.fin.toISOString(),
    ...(f.origen !== null ? { origen: f.origen } : {}),
    destino: f.destino,
    estado: f.estado,
    detalle: f.detalle ?? {},
    origenCambio: f.origen_cambio,
    ...(f.correo_id !== null ? { correoId: f.correo_id } : {}),
    actualizadoEn: f.actualizado_en.toISOString(),
  };
}

/**
 * Serializa escrituras sobre viajes y reservas de un mismo usuario dentro de la transacción actual.
 * Evita condiciones de carrera al agrupar reservas concurrentes sin bloquear a otros usuarios.
 */
export async function bloquearUsuarioParaAgrupacion(
  db: ClienteDb,
  usuarioId: string,
): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [usuarioId]);
}

export async function buscarReservaPorClave(
  db: Db,
  proveedor: string,
  numeroReserva: string,
  opciones: { paraActualizar?: boolean } = {},
): Promise<Reserva | null> {
  const sufijo = opciones.paraActualizar ? ' FOR UPDATE' : '';
  const res = await db.query<FilaReserva>(
    `SELECT id, viaje_id, usuario_id, proveedor, tipo_reserva, numero_reserva,
            inicio, fin, origen, destino, detalle, estado, origen_cambio, correo_id, actualizado_en
     FROM reservas
     WHERE proveedor = $1 AND numero_reserva = $2${sufijo}`,
    [proveedor, numeroReserva],
  );
  const fila = res.rows[0];
  return fila ? mapearReserva(fila) : null;
}

export async function listarViajesActivosDeUsuario(db: Db, usuarioId: string): Promise<Viaje[]> {
  const res = await db.query<FilaViaje>(
    `SELECT id, usuario_id, nombre, destino, inicio, fin, estado
     FROM viajes
     WHERE usuario_id = $1 AND estado = 'activo'
     ORDER BY inicio ASC`,
    [usuarioId],
  );
  return res.rows.map(mapearViaje);
}

export async function listarReservasDeViaje(db: Db, viajeId: string): Promise<Reserva[]> {
  const res = await db.query<FilaReserva>(
    `SELECT id, viaje_id, usuario_id, proveedor, tipo_reserva, numero_reserva,
            inicio, fin, origen, destino, detalle, estado, origen_cambio, correo_id, actualizado_en
     FROM reservas
     WHERE viaje_id = $1
     ORDER BY inicio ASC, id ASC`,
    [viajeId],
  );
  return res.rows.map(mapearReserva);
}

export async function crearViaje(
  db: ClienteDb,
  datos: {
    usuarioId: string;
    resumen: ResumenViaje;
    estado?: EstadoViaje;
    ahora: Date;
  },
): Promise<Viaje> {
  const id = randomUUID();
  const res = await db.query<FilaViaje>(
    `INSERT INTO viajes (id, usuario_id, nombre, destino, inicio, fin, estado, creado_en, actualizado_en)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     RETURNING id, usuario_id, nombre, destino, inicio, fin, estado`,
    [
      id,
      datos.usuarioId,
      datos.resumen.nombre,
      datos.resumen.destino,
      datos.resumen.inicio,
      datos.resumen.fin,
      datos.estado ?? 'activo',
      datos.ahora,
    ],
  );
  const fila = res.rows[0];
  if (!fila) throw new Error('No se pudo crear el viaje.');
  return mapearViaje(fila);
}

export async function actualizarResumenViaje(
  db: ClienteDb,
  viajeId: string,
  resumen: ResumenViaje,
  ahora: Date,
): Promise<Viaje | null> {
  const res = await db.query<FilaViaje>(
    `UPDATE viajes
     SET nombre = $2,
         destino = $3,
         inicio = $4,
         fin = $5,
         actualizado_en = $6
     WHERE id = $1
     RETURNING id, usuario_id, nombre, destino, inicio, fin, estado`,
    [viajeId, resumen.nombre, resumen.destino, resumen.inicio, resumen.fin, ahora],
  );
  const fila = res.rows[0];
  return fila ? mapearViaje(fila) : null;
}

export async function insertarReserva(
  db: ClienteDb,
  datos: {
    viajeId: string;
    usuarioId: string;
    proveedor: string;
    tipoReserva: TipoReserva;
    numeroReserva: string;
    inicio: string;
    fin: string;
    origen?: string;
    destino: string;
    detalle: Record<string, unknown>;
    estado: EstadoReserva;
    origenCambio: OrigenCambio;
    correoId?: string;
    ahora: Date;
  },
): Promise<Reserva> {
  const id = randomUUID();
  const res = await db.query<FilaReserva>(
    `INSERT INTO reservas (
       id, viaje_id, usuario_id, proveedor, tipo_reserva, numero_reserva,
       inicio, fin, origen, destino, detalle, estado, origen_cambio, correo_id,
       creado_en, actualizado_en
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $15)
     RETURNING id, viaje_id, usuario_id, proveedor, tipo_reserva, numero_reserva,
               inicio, fin, origen, destino, detalle, estado, origen_cambio, correo_id, actualizado_en`,
    [
      id,
      datos.viajeId,
      datos.usuarioId,
      datos.proveedor,
      datos.tipoReserva,
      datos.numeroReserva,
      datos.inicio,
      datos.fin,
      datos.origen ?? null,
      datos.destino,
      JSON.stringify(datos.detalle),
      datos.estado,
      datos.origenCambio,
      datos.correoId ?? null,
      datos.ahora,
    ],
  );
  const fila = res.rows[0];
  if (!fila) throw new Error('No se pudo insertar la reserva.');
  return mapearReserva(fila);
}

export async function actualizarReserva(
  db: ClienteDb,
  reservaId: string,
  datos: {
    inicio: string;
    fin: string;
    origen?: string;
    destino: string;
    detalle: Record<string, unknown>;
    estado: EstadoReserva;
    origenCambio: OrigenCambio;
    correoId?: string;
    ahora: Date;
  },
): Promise<Reserva> {
  const res = await db.query<FilaReserva>(
    `UPDATE reservas
     SET inicio = $2,
         fin = $3,
         origen = $4,
         destino = $5,
         detalle = $6::jsonb,
         estado = $7,
         origen_cambio = $8,
         correo_id = COALESCE($9, correo_id),
         actualizado_en = $10
     WHERE id = $1
     RETURNING id, viaje_id, usuario_id, proveedor, tipo_reserva, numero_reserva,
               inicio, fin, origen, destino, detalle, estado, origen_cambio, correo_id, actualizado_en`,
    [
      reservaId,
      datos.inicio,
      datos.fin,
      datos.origen ?? null,
      datos.destino,
      JSON.stringify(datos.detalle),
      datos.estado,
      datos.origenCambio,
      datos.correoId ?? null,
      datos.ahora,
    ],
  );
  const fila = res.rows[0];
  if (!fila) throw new Error(`Reserva ${reservaId} no encontrada al actualizar.`);
  return mapearReserva(fila);
}

export async function listarViajesConReservas(
  db: Db,
  usuarioId: string,
  estado?: EstadoViaje,
): Promise<ViajeConReservas[]> {
  const params: unknown[] = [usuarioId];
  let filtroEstado = '';
  if (estado) {
    params.push(estado);
    filtroEstado = ` AND estado = $${params.length}`;
  }
  const orden = estado === 'archivado' ? 'DESC' : 'ASC';
  const viajesRes = await db.query<FilaViaje>(
    `SELECT id, usuario_id, nombre, destino, inicio, fin, estado
     FROM viajes
     WHERE usuario_id = $1${filtroEstado}
     ORDER BY inicio ${orden}, id ASC`,
    params,
  );
  if (viajesRes.rows.length === 0) return [];

  const viajeIds = viajesRes.rows.map((v) => v.id);
  const reservasRes = await db.query<FilaReserva>(
    `SELECT id, viaje_id, usuario_id, proveedor, tipo_reserva, numero_reserva,
            inicio, fin, origen, destino, detalle, estado, origen_cambio, correo_id, actualizado_en
     FROM reservas
     WHERE viaje_id = ANY($1::uuid[])
     ORDER BY inicio ASC, id ASC`,
    [viajeIds],
  );

  const porViaje = new Map<string, Reserva[]>();
  for (const fila of reservasRes.rows) {
    const lista = porViaje.get(fila.viaje_id) ?? [];
    lista.push(mapearReserva(fila));
    porViaje.set(fila.viaje_id, lista);
  }

  return viajesRes.rows.map((v) => ({
    ...mapearViaje(v),
    reservas: porViaje.get(v.id) ?? [],
  }));
}
