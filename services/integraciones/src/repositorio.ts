import { randomUUID } from 'node:crypto';
import type { ClienteDb, Pool } from '@trotamundos/comun';
import type { EstadoReservaProveedor, EstadoReservaTraducido } from './adaptadores/tipos.ts';

type Ejecutor = Pool | ClienteDb;

export type ViaNoTraducido = 'webhook' | 'consulta';

export interface MensajeNoTraducido {
  id: string;
  proveedor: string;
  via: ViaNoTraducido;
  recibidoEn: string;
  motivo: string;
  cuerpo: string;
}

export interface FiltrosNoTraducidos {
  proveedor?: string;
  desde?: string;
  limite?: number;
}

/**
 * Inserta la clave de deduplicación `(proveedor, numeroReserva, versionCambio)`.
 * Devuelve `true` si es un cambio nuevo y `false` si ya fue procesado antes.
 */
export async function registrarCambioSiNuevo(
  db: Ejecutor,
  proveedor: string,
  numeroReserva: string,
  versionCambio: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO cambios_procesados (proveedor, numero_reserva, version_cambio)
     VALUES ($1, $2, $3)
     ON CONFLICT (proveedor, numero_reserva, version_cambio) DO NOTHING`,
    [proveedor, numeroReserva, versionCambio],
  );
  return (rowCount ?? 0) > 0;
}

interface FilaEstadoReserva {
  estado: EstadoReservaTraducido;
  inicio: string | null;
  fin: string | null;
  origen: string | null;
  destino: string | null;
  detalle: Record<string, unknown> | null;
  version_cambio: string;
}

export async function obtenerEstadoReserva(
  db: Ejecutor,
  proveedor: string,
  numeroReserva: string,
  opciones: { paraActualizar?: boolean } = {},
): Promise<EstadoReservaProveedor | undefined> {
  const clausulaLock = opciones.paraActualizar ? ' FOR UPDATE' : '';
  const { rows } = await db.query<FilaEstadoReserva>(
    `SELECT estado, inicio, fin, origen, destino, detalle, version_cambio
       FROM estado_reservas_proveedor
      WHERE proveedor = $1 AND numero_reserva = $2${clausulaLock}`,
    [proveedor, numeroReserva],
  );
  const fila = rows[0];
  if (!fila) return undefined;
  return {
    estado: fila.estado,
    ...(fila.inicio !== null ? { inicio: fila.inicio } : {}),
    ...(fila.fin !== null ? { fin: fila.fin } : {}),
    ...(fila.origen !== null ? { origen: fila.origen } : {}),
    ...(fila.destino !== null ? { destino: fila.destino } : {}),
    detalle: fila.detalle ?? {},
    versionCambio: fila.version_cambio,
  };
}

export async function guardarEstadoReserva(
  db: Ejecutor,
  proveedor: string,
  numeroReserva: string,
  estado: EstadoReservaProveedor,
): Promise<void> {
  await db.query(
    `INSERT INTO estado_reservas_proveedor
       (proveedor, numero_reserva, estado, inicio, fin, origen, destino, detalle, version_cambio, actualizado_en)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, now())
     ON CONFLICT (proveedor, numero_reserva) DO UPDATE SET
       estado = EXCLUDED.estado,
       inicio = EXCLUDED.inicio,
       fin = EXCLUDED.fin,
       origen = EXCLUDED.origen,
       destino = EXCLUDED.destino,
       detalle = EXCLUDED.detalle,
       version_cambio = EXCLUDED.version_cambio,
       actualizado_en = now()`,
    [
      proveedor,
      numeroReserva,
      estado.estado,
      estado.inicio ?? null,
      estado.fin ?? null,
      estado.origen ?? null,
      estado.destino ?? null,
      JSON.stringify(estado.detalle),
      estado.versionCambio,
    ],
  );
}

export async function obtenerCursorConsulta(
  db: Ejecutor,
  proveedor: string,
): Promise<string | undefined> {
  const { rows } = await db.query<{ ultimo_desde: Date | string }>(
    'SELECT ultimo_desde FROM cursores_consulta WHERE proveedor = $1',
    [proveedor],
  );
  const valor = rows[0]?.ultimo_desde;
  if (!valor) return undefined;
  return valor instanceof Date ? valor.toISOString() : new Date(valor).toISOString();
}

export async function guardarCursorConsulta(
  db: Ejecutor,
  proveedor: string,
  ultimoDesde: string,
): Promise<void> {
  await db.query(
    `INSERT INTO cursores_consulta (proveedor, ultimo_desde, actualizado_en)
     VALUES ($1, $2::timestamptz, now())
     ON CONFLICT (proveedor) DO UPDATE SET
       ultimo_desde = GREATEST(cursores_consulta.ultimo_desde, EXCLUDED.ultimo_desde),
       actualizado_en = now()`,
    [proveedor, ultimoDesde],
  );
}

export interface DatosNuevoNoTraducido {
  proveedor: string;
  via: ViaNoTraducido;
  motivo: string;
  cuerpo: string;
  recibidoEn?: Date;
}

interface FilaNoTraducido {
  id: string;
  proveedor: string;
  via: ViaNoTraducido;
  recibido_en: Date | string;
  motivo: string;
  cuerpo: string;
}

function mapearNoTraducido(fila: FilaNoTraducido): MensajeNoTraducido {
  const fecha =
    fila.recibido_en instanceof Date
      ? fila.recibido_en.toISOString()
      : new Date(fila.recibido_en).toISOString();
  return {
    id: fila.id,
    proveedor: fila.proveedor,
    via: fila.via,
    recibidoEn: fecha,
    motivo: fila.motivo,
    cuerpo: fila.cuerpo,
  };
}

export async function registrarNoTraducido(
  db: Ejecutor,
  datos: DatosNuevoNoTraducido,
): Promise<MensajeNoTraducido> {
  const id = randomUUID();
  const recibidoEn = datos.recibidoEn ?? new Date();
  const { rows } = await db.query<FilaNoTraducido>(
    `INSERT INTO no_traducidos (id, proveedor, via, recibido_en, motivo, cuerpo)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6)
     RETURNING id, proveedor, via, recibido_en, motivo, cuerpo`,
    [id, datos.proveedor, datos.via, recibidoEn.toISOString(), datos.motivo, datos.cuerpo],
  );
  const fila = rows[0];
  if (!fila) throw new Error('No se pudo insertar el mensaje no traducido.');
  return mapearNoTraducido(fila);
}

export async function listarNoTraducidos(
  db: Ejecutor,
  filtros: FiltrosNoTraducidos = {},
): Promise<MensajeNoTraducido[]> {
  const condiciones: string[] = [];
  const parametros: unknown[] = [];

  if (filtros.proveedor) {
    parametros.push(filtros.proveedor);
    condiciones.push(`proveedor = $${parametros.length}`);
  }
  if (filtros.desde) {
    parametros.push(filtros.desde);
    condiciones.push(`recibido_en >= $${parametros.length}::timestamptz`);
  }

  const limite = Math.min(200, Math.max(1, filtros.limite ?? 50));
  parametros.push(limite);
  const where = condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';

  const { rows } = await db.query<FilaNoTraducido>(
    `SELECT id, proveedor, via, recibido_en, motivo, cuerpo
       FROM no_traducidos
       ${where}
      ORDER BY recibido_en DESC, id DESC
      LIMIT $${parametros.length}`,
    parametros,
  );
  return rows.map(mapearNoTraducido);
}

const PREFIJO_LOCK_CONSULTA = 'integraciones:consulta:';

/** Lock consultivo por proveedor para evitar consultas simultáneas entre réplicas. */
export async function intentarLockConsulta(
  cliente: ClienteDb,
  proveedor: string,
): Promise<boolean> {
  const { rows } = await cliente.query<{ adquirido: boolean }>(
    'SELECT pg_try_advisory_lock(hashtext($1)) AS adquirido',
    [`${PREFIJO_LOCK_CONSULTA}${proveedor}`],
  );
  return rows[0]?.adquirido === true;
}

export async function liberarLockConsulta(cliente: ClienteDb, proveedor: string): Promise<void> {
  await cliente
    .query('SELECT pg_advisory_unlock(hashtext($1))', [`${PREFIJO_LOCK_CONSULTA}${proveedor}`])
    .catch(() => undefined);
}

export interface OpcionReprogramacionGuardada {
  proveedor: string;
  numeroReserva: string;
  opcionId: string;
  venceEn: string;
  aplicadaEn?: string;
}

interface FilaOpcionReprogramacion {
  proveedor: string;
  numero_reserva: string;
  opcion_id: string;
  vence_en: Date | string;
  aplicada_en: Date | string | null;
}

function aIso(valor: Date | string): string {
  return valor instanceof Date ? valor.toISOString() : new Date(valor).toISOString();
}

export async function guardarOpcionesReprogramacion(
  db: Ejecutor,
  proveedor: string,
  numeroReserva: string,
  opciones: Array<{ opcionId: string; venceEn: string }>,
): Promise<void> {
  for (const opcion of opciones) {
    await db.query(
      `INSERT INTO opciones_reprogramacion_ofrecidas
         (proveedor, numero_reserva, opcion_id, vence_en, ofrecida_en)
       VALUES ($1, $2, $3, $4::timestamptz, now())
       ON CONFLICT (proveedor, numero_reserva, opcion_id) DO UPDATE SET
         vence_en = EXCLUDED.vence_en`,
      [proveedor, numeroReserva, opcion.opcionId, opcion.venceEn],
    );
  }
}

export async function obtenerOpcionReprogramacion(
  db: Ejecutor,
  proveedor: string,
  numeroReserva: string,
  opcionId: string,
): Promise<OpcionReprogramacionGuardada | undefined> {
  const { rows } = await db.query<FilaOpcionReprogramacion>(
    `SELECT proveedor, numero_reserva, opcion_id, vence_en, aplicada_en
       FROM opciones_reprogramacion_ofrecidas
      WHERE proveedor = $1 AND numero_reserva = $2 AND opcion_id = $3`,
    [proveedor, numeroReserva, opcionId],
  );
  const fila = rows[0];
  if (!fila) return undefined;
  return {
    proveedor: fila.proveedor,
    numeroReserva: fila.numero_reserva,
    opcionId: fila.opcion_id,
    venceEn: aIso(fila.vence_en),
    ...(fila.aplicada_en !== null ? { aplicadaEn: aIso(fila.aplicada_en) } : {}),
  };
}

export async function marcarOpcionAplicada(
  db: Ejecutor,
  proveedor: string,
  numeroReserva: string,
  opcionId: string,
  aplicadaEn: string,
): Promise<void> {
  await db.query(
    `UPDATE opciones_reprogramacion_ofrecidas
        SET aplicada_en = COALESCE(aplicada_en, $4::timestamptz)
      WHERE proveedor = $1 AND numero_reserva = $2 AND opcion_id = $3`,
    [proveedor, numeroReserva, opcionId, aplicadaEn],
  );
}
