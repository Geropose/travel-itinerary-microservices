// Persistencia sobre la base global de analítica (tabla particionada por mes).
// Antes de escribir cualquier fila, valida estrictamente contra specs/schemas/ViajeAnonimizado.json:
// si tiene un campo de más o es inválida, lanza ErrorFilaAnonimizadaInvalida y no guarda nada.
import { enTransaccion, type ClienteDb, type Pool } from '@trotamundos/comun';
import { validarViajeAnonimizado } from './anonimizador.ts';
import type { EstadoReserva, OrigenCambio, TipoReserva, ViajeAnonimizado } from './modelo.ts';

export type Db = Pool | ClienteDb;

export interface FilaAnonimizadaGuardada extends ViajeAnonimizado {
  actualizadoEn: string;
}

interface FilaSql {
  codigo_reserva: string;
  region: 'region-1' | 'region-2';
  proveedor: string;
  tipo_reserva: TipoReserva;
  origen: string | null;
  destino: string;
  inicio: string;
  fin: string;
  estado: EstadoReserva;
  origen_cambio: OrigenCambio;
  actualizado_en: Date;
}

function mapearFila(f: FilaSql): FilaAnonimizadaGuardada {
  return {
    codigoReserva: f.codigo_reserva,
    region: f.region,
    proveedor: f.proveedor,
    tipoReserva: f.tipo_reserva,
    ...(f.origen !== null ? { origen: f.origen } : {}),
    destino: f.destino,
    inicio: f.inicio,
    fin: f.fin,
    estado: f.estado,
    origenCambio: f.origen_cambio,
    actualizadoEn: f.actualizado_en.toISOString(),
  };
}

async function ejecutarGuardarEnCliente(
  db: ClienteDb,
  fila: ViajeAnonimizado,
  ahora: Date,
): Promise<{ accion: 'insertada' | 'actualizada' | 'movida'; fila: FilaAnonimizadaGuardada }> {
  // Serializa cambios concurrentes sobre la misma reserva anonimizada para garantizar una única fila.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
    `${fila.region}:${fila.proveedor}:${fila.codigoReserva}`,
  ]);

  // Garantiza la existencia de la partición mensual de destino.
  await db.query('SELECT asegurar_particion_mes($1::date)', [fila.inicio]);

  const existente = await db.query<{ inicio: string }>(
    `SELECT to_char(inicio, 'YYYY-MM-DD') AS inicio
     FROM reservas_anonimizadas
     WHERE region = $1 AND proveedor = $2 AND codigo_reserva = $3
     LIMIT 1`,
    [fila.region, fila.proveedor, fila.codigoReserva],
  );
  const inicioAnterior = existente.rows[0]?.inicio;

  if (inicioAnterior === undefined) {
    const ins = await db.query<FilaSql>(
      `INSERT INTO reservas_anonimizadas (
         codigo_reserva, region, proveedor, tipo_reserva, origen, destino,
         inicio, fin, estado, origen_cambio, actualizado_en
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11)
       RETURNING codigo_reserva, region, proveedor, tipo_reserva, origen, destino,
                 to_char(inicio, 'YYYY-MM-DD') AS inicio, to_char(fin, 'YYYY-MM-DD') AS fin,
                 estado, origen_cambio, actualizado_en`,
      [
        fila.codigoReserva,
        fila.region,
        fila.proveedor,
        fila.tipoReserva,
        fila.origen ?? null,
        fila.destino,
        fila.inicio,
        fila.fin,
        fila.estado,
        fila.origenCambio,
        ahora,
      ],
    );
    const guardada = ins.rows[0];
    if (!guardada) throw new Error('No se pudo insertar la fila anonimizada.');
    return { accion: 'insertada', fila: mapearFila(guardada) };
  }

  if (inicioAnterior === fila.inicio) {
    const upd = await db.query<FilaSql>(
      `UPDATE reservas_anonimizadas
       SET tipo_reserva = $4,
           origen = $5,
           destino = $6,
           fin = $7::date,
           estado = $8,
           origen_cambio = $9,
           actualizado_en = $10
       WHERE region = $1 AND proveedor = $2 AND codigo_reserva = $3 AND inicio = $11::date
       RETURNING codigo_reserva, region, proveedor, tipo_reserva, origen, destino,
                 to_char(inicio, 'YYYY-MM-DD') AS inicio, to_char(fin, 'YYYY-MM-DD') AS fin,
                 estado, origen_cambio, actualizado_en`,
      [
        fila.region,
        fila.proveedor,
        fila.codigoReserva,
        fila.tipoReserva,
        fila.origen ?? null,
        fila.destino,
        fila.fin,
        fila.estado,
        fila.origenCambio,
        ahora,
        inicioAnterior,
      ],
    );
    const guardada = upd.rows[0];
    if (!guardada) throw new Error('No se pudo actualizar la fila anonimizada.');
    return { accion: 'actualizada', fila: mapearFila(guardada) };
  }

  // Si cambió la fecha de inicio (dentro del mes o hacia otro mes/partición), reemplazamos
  // atómicamente para que nunca queden dos filas con el mismo codigo_reserva.
  await db.query(
    `DELETE FROM reservas_anonimizadas
     WHERE region = $1 AND proveedor = $2 AND codigo_reserva = $3`,
    [fila.region, fila.proveedor, fila.codigoReserva],
  );
  const movida = await db.query<FilaSql>(
    `INSERT INTO reservas_anonimizadas (
       codigo_reserva, region, proveedor, tipo_reserva, origen, destino,
       inicio, fin, estado, origen_cambio, actualizado_en
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11)
     RETURNING codigo_reserva, region, proveedor, tipo_reserva, origen, destino,
               to_char(inicio, 'YYYY-MM-DD') AS inicio, to_char(fin, 'YYYY-MM-DD') AS fin,
               estado, origen_cambio, actualizado_en`,
    [
      fila.codigoReserva,
      fila.region,
      fila.proveedor,
      fila.tipoReserva,
      fila.origen ?? null,
      fila.destino,
      fila.inicio,
      fila.fin,
      fila.estado,
      fila.origenCambio,
      ahora,
    ],
  );
  const guardada = movida.rows[0];
  if (!guardada) throw new Error('No se pudo mover la fila anonimizada de partición.');
  return { accion: 'movida', fila: mapearFila(guardada) };
}

/**
 * Valida estrictamente `fila` contra ViajeAnonimizado.json y realiza un upsert en la tabla
 * particionada `reservas_anonimizadas` manteniendo siempre una sola fila por reserva.
 */
export async function guardarFilaAnonimizada(
  pool: Pool,
  fila: unknown,
  ahora: Date = new Date(),
): Promise<{ accion: 'insertada' | 'actualizada' | 'movida'; fila: FilaAnonimizadaGuardada }> {
  const validada = validarViajeAnonimizado(fila);
  return await enTransaccion(pool, (db) => ejecutarGuardarEnCliente(db, validada, ahora));
}

export async function buscarFilaAnonimizada(
  db: Db,
  region: 'region-1' | 'region-2',
  proveedor: string,
  codigoReserva: string,
): Promise<FilaAnonimizadaGuardada | null> {
  const res = await db.query<FilaSql>(
    `SELECT codigo_reserva, region, proveedor, tipo_reserva, origen, destino,
            to_char(inicio, 'YYYY-MM-DD') AS inicio, to_char(fin, 'YYYY-MM-DD') AS fin,
            estado, origen_cambio, actualizado_en
     FROM reservas_anonimizadas
     WHERE region = $1 AND proveedor = $2 AND codigo_reserva = $3
     LIMIT 1`,
    [region, proveedor, codigoReserva],
  );
  const fila = res.rows[0];
  return fila ? mapearFila(fila) : null;
}

export async function listarParticionesMensuales(db: Db): Promise<string[]> {
  const res = await db.query<{ nombre: string }>(
    `SELECT c.relname AS nombre
     FROM pg_inherits i
     INNER JOIN pg_class c ON c.oid = i.inhrelid
     INNER JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'reservas_anonimizadas'
     ORDER BY c.relname ASC`,
  );
  return res.rows.map((r) => r.nombre);
}
