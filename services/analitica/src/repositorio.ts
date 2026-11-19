// Persistencia sobre la base global de analítica (tabla particionada por mes y ejecuciones Map-Reduce).
// Antes de escribir cualquier fila anonimizada, valida estrictamente contra specs/schemas/ViajeAnonimizado.json:
// si tiene un campo de más o es inválida, lanza ErrorFilaAnonimizadaInvalida y no guarda nada.
import { enTransaccion, type ClienteDb, type Pool } from '@trotamundos/comun';
import { validarViajeAnonimizado } from './anonimizador.ts';
import {
  reducirCancelaciones,
  reducirDestinos,
  reducirTendencias,
  type ParcialCancelaciones,
  type ParcialDestinos,
  type ParcialTendencias,
} from './mapreduce.ts';
import type {
  AgrupacionCancelaciones,
  EjecucionPublica,
  EstadoEjecucion,
  EstadoReserva,
  OrigenCambio,
  ParametrosConsulta,
  ResultadoCancelaciones,
  ResultadoConsulta,
  ResultadoDestinos,
  ResultadoTendencias,
  TipoConsulta,
  TipoReserva,
  ViajeAnonimizado,
} from './modelo.ts';

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

// --- Consultas analíticas directas (reutilizan las mismas funciones Reduce que Map-Reduce) ---

export async function consultarDestinosDirecto(
  db: Db,
  opciones: { desde: string; hasta: string; limite: number; generadoEn: string },
): Promise<ResultadoDestinos> {
  const res = await db.query<{ destino: string; total: string }>(
    `SELECT destino, COUNT(*)::bigint::text AS total
     FROM reservas_anonimizadas
     WHERE inicio >= $1::date
       AND inicio <= $2::date
       AND estado <> 'cancelada'
     GROUP BY destino`,
    [opciones.desde, opciones.hasta],
  );
  const porDestino: Record<string, number> = {};
  let totalReservas = 0;
  for (const fila of res.rows) {
    const cantidad = Number(fila.total);
    porDestino[fila.destino] = cantidad;
    totalReservas += cantidad;
  }
  const parcial: ParcialDestinos = { tipo: 'destinos', totalReservas, porDestino };
  return reducirDestinos([parcial], opciones);
}

export async function consultarCancelacionesDirecto(
  db: Db,
  opciones: {
    desde: string;
    hasta: string;
    agruparPor: AgrupacionCancelaciones;
    generadoEn: string;
  },
): Promise<ResultadoCancelaciones> {
  const columna = opciones.agruparPor === 'proveedor' ? 'proveedor' : 'destino';
  const res = await db.query<{ clave: string; reservas: string; canceladas: string }>(
    `SELECT ${columna} AS clave,
            COUNT(*)::bigint::text AS reservas,
            COUNT(*) FILTER (WHERE estado = 'cancelada')::bigint::text AS canceladas
     FROM reservas_anonimizadas
     WHERE inicio >= $1::date
       AND inicio <= $2::date
     GROUP BY ${columna}`,
    [opciones.desde, opciones.hasta],
  );
  const porClave: ParcialCancelaciones['porClave'] = {};
  let totalReservas = 0;
  let totalCanceladas = 0;
  for (const fila of res.rows) {
    const reservas = Number(fila.reservas);
    const canceladas = Number(fila.canceladas);
    porClave[fila.clave] = { reservas, canceladas };
    totalReservas += reservas;
    totalCanceladas += canceladas;
  }
  const parcial: ParcialCancelaciones = {
    tipo: 'cancelaciones',
    totalReservas,
    totalCanceladas,
    porClave,
  };
  return reducirCancelaciones([parcial], opciones);
}

export async function consultarTendenciasDirecto(
  db: Db,
  opciones: { anio: number; generadoEn: string },
): Promise<ResultadoTendencias> {
  const desde = `${opciones.anio}-01-01`;
  const hasta = `${opciones.anio}-12-31`;
  const res = await db.query<{
    mes: number;
    reservas: string;
    canceladas: string;
    vuelo: string;
    hotel: string;
    auto: string;
  }>(
    `SELECT EXTRACT(MONTH FROM inicio)::int AS mes,
            COUNT(*)::bigint::text AS reservas,
            COUNT(*) FILTER (WHERE estado = 'cancelada')::bigint::text AS canceladas,
            COUNT(*) FILTER (WHERE tipo_reserva = 'vuelo')::bigint::text AS vuelo,
            COUNT(*) FILTER (WHERE tipo_reserva = 'hotel')::bigint::text AS hotel,
            COUNT(*) FILTER (WHERE tipo_reserva = 'auto')::bigint::text AS auto
     FROM reservas_anonimizadas
     WHERE inicio >= $1::date
       AND inicio <= $2::date
     GROUP BY EXTRACT(MONTH FROM inicio)::int`,
    [desde, hasta],
  );
  const porMes: ParcialTendencias['porMes'] = {};
  for (const fila of res.rows) {
    porMes[fila.mes] = {
      reservas: Number(fila.reservas),
      canceladas: Number(fila.canceladas),
      vuelo: Number(fila.vuelo),
      hotel: Number(fila.hotel),
      auto: Number(fila.auto),
    };
  }
  const parcial: ParcialTendencias = { tipo: 'tendencias', porMes };
  return reducirTendencias([parcial], opciones);
}

// --- Ejecuciones asíncronas Map-Reduce (tabla ejecuciones_consultas) ---

interface FilaEjecucionSql {
  consulta_id: string;
  tipo: TipoConsulta;
  parametros: ParametrosConsulta;
  estado: EstadoEjecucion;
  procesadores: number;
  progreso: number;
  creada_en: Date;
  iniciada_en: Date | null;
  terminada_en: Date | null;
  duracion_ms: number | null;
  resultado: ResultadoConsulta | null;
  error: string | null;
}

function mapearEjecucion(f: FilaEjecucionSql): EjecucionPublica {
  return {
    consultaId: f.consulta_id,
    tipo: f.tipo,
    parametros: f.parametros,
    estado: f.estado,
    procesadores: f.procesadores,
    progreso: Number(f.progreso),
    creadaEn: f.creada_en.toISOString(),
    ...(f.iniciada_en !== null ? { iniciadaEn: f.iniciada_en.toISOString() } : {}),
    ...(f.terminada_en !== null ? { terminadaEn: f.terminada_en.toISOString() } : {}),
    ...(f.duracion_ms !== null ? { duracionMs: f.duracion_ms } : {}),
    ...(f.resultado !== null ? { resultado: f.resultado } : {}),
    ...(f.error !== null ? { error: f.error } : {}),
  };
}

function esDuplicadoPg(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

export async function crearEjecucion(
  db: Db,
  datos: {
    consultaId: string;
    tipo: TipoConsulta;
    parametros: ParametrosConsulta;
    claveDedup: string;
    creadaEn: Date;
  },
): Promise<
  { creada: true; ejecucion: EjecucionPublica } | { creada: false; consultaIdExistente: string }
> {
  try {
    const res = await db.query<FilaEjecucionSql>(
      `INSERT INTO ejecuciones_consultas (
         consulta_id, tipo, parametros, clave_dedup, estado, procesadores, progreso, creada_en
       )
       VALUES ($1, $2, $3::jsonb, $4, 'pendiente', 0, 0, $5)
       RETURNING consulta_id, tipo, parametros, estado, procesadores, progreso,
                 creada_en, iniciada_en, terminada_en, duracion_ms, resultado, error`,
      [
        datos.consultaId,
        datos.tipo,
        JSON.stringify(datos.parametros),
        datos.claveDedup,
        datos.creadaEn,
      ],
    );
    const fila = res.rows[0];
    if (!fila) throw new Error('No se pudo crear el registro de ejecución.');
    return { creada: true, ejecucion: mapearEjecucion(fila) };
  } catch (err) {
    if (!esDuplicadoPg(err)) throw err;
    const activa = await db.query<{ consulta_id: string }>(
      `SELECT consulta_id
       FROM ejecuciones_consultas
       WHERE clave_dedup = $1 AND estado IN ('pendiente', 'enCurso')
       LIMIT 1`,
      [datos.claveDedup],
    );
    return { creada: false, consultaIdExistente: activa.rows[0]?.consulta_id ?? '' };
  }
}

export async function marcarEjecucionEnCurso(
  db: Db,
  consultaId: string,
  procesadores: number,
  iniciadaEn: Date,
): Promise<void> {
  await db.query(
    `UPDATE ejecuciones_consultas
     SET estado = 'enCurso',
         procesadores = $2,
         iniciada_en = $3
     WHERE consulta_id = $1`,
    [consultaId, procesadores, iniciadaEn],
  );
}

export async function actualizarProgresoEjecucion(
  db: Db,
  consultaId: string,
  progreso: number,
): Promise<void> {
  const acotado = Math.min(1, Math.max(0, progreso));
  await db.query(
    `UPDATE ejecuciones_consultas
     SET progreso = GREATEST(progreso, $2)
     WHERE consulta_id = $1 AND estado = 'enCurso'`,
    [consultaId, acotado],
  );
}

export async function marcarEjecucionTerminada(
  db: Db,
  consultaId: string,
  datos: { terminadaEn: Date; duracionMs: number; resultado: ResultadoConsulta },
): Promise<void> {
  await db.query(
    `UPDATE ejecuciones_consultas
     SET estado = 'terminada',
         progreso = 1,
         terminada_en = $2,
         duracion_ms = $3,
         resultado = $4::jsonb
     WHERE consulta_id = $1`,
    [
      consultaId,
      datos.terminadaEn,
      Math.max(0, Math.round(datos.duracionMs)),
      JSON.stringify(datos.resultado),
    ],
  );
}

export async function marcarEjecucionFallida(
  db: Db,
  consultaId: string,
  datos: { terminadaEn: Date; duracionMs: number; error: string },
): Promise<void> {
  await db.query(
    `UPDATE ejecuciones_consultas
     SET estado = 'fallida',
         terminada_en = $2,
         duracion_ms = $3,
         error = $4
     WHERE consulta_id = $1`,
    [consultaId, datos.terminadaEn, Math.max(0, Math.round(datos.duracionMs)), datos.error],
  );
}

export async function obtenerEjecucion(
  db: Db,
  consultaId: string,
): Promise<EjecucionPublica | null> {
  const res = await db.query<FilaEjecucionSql>(
    `SELECT consulta_id, tipo, parametros, estado, procesadores, progreso,
            creada_en, iniciada_en, terminada_en, duracion_ms, resultado, error
     FROM ejecuciones_consultas
     WHERE consulta_id = $1`,
    [consultaId],
  );
  const fila = res.rows[0];
  return fila ? mapearEjecucion(fila) : null;
}
