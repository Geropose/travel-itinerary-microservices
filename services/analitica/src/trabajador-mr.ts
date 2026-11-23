// Proceso trabajador Map-Reduce (worker_threads) del Servicio de Analítica (Iteración 6, QA-5):
// Se enciende al iniciar una consulta pesada, abre su propia conexión PostgreSQL a la base global
// de analítica, ejecuta la fase Map sobre cada bloque de partición asignado y se apaga al terminar.
import { parentPort, workerData } from 'node:worker_threads';
import pg from 'pg';
import type {
  BloqueParticion,
  MensajeAlTrabajador,
  MensajeDelTrabajador,
  ParcialCancelaciones,
  ParcialDestinos,
  ParcialMap,
  ParcialTendencias,
  TareaMap,
} from './mapreduce.ts';

interface DatosInicioTrabajador {
  urlBaseAnalitica: string;
  tarea: TareaMap;
  connectionTimeoutMs?: number;
}

async function ejecutarMapDestinos(
  cliente: pg.Client,
  bloque: BloqueParticion,
): Promise<ParcialDestinos> {
  const res = await cliente.query<{ destino: string; total: string }>(
    `SELECT destino, COUNT(*)::bigint::text AS total
     FROM reservas_anonimizadas
     WHERE inicio >= $1::date
       AND inicio <= $2::date
       AND estado <> 'cancelada'
     GROUP BY destino`,
    [bloque.desde, bloque.hasta],
  );
  const porDestino: Record<string, number> = {};
  let totalReservas = 0;
  for (const fila of res.rows) {
    const cantidad = Number(fila.total);
    porDestino[fila.destino] = (porDestino[fila.destino] ?? 0) + cantidad;
    totalReservas += cantidad;
  }
  return { tipo: 'destinos', totalReservas, porDestino };
}

async function ejecutarMapCancelaciones(
  cliente: pg.Client,
  bloque: BloqueParticion,
  agruparPor: 'proveedor' | 'destino',
): Promise<ParcialCancelaciones> {
  const columna = agruparPor === 'proveedor' ? 'proveedor' : 'destino';
  const res = await cliente.query<{ clave: string; reservas: string; canceladas: string }>(
    `SELECT ${columna} AS clave,
            COUNT(*)::bigint::text AS reservas,
            COUNT(*) FILTER (WHERE estado = 'cancelada')::bigint::text AS canceladas
     FROM reservas_anonimizadas
     WHERE inicio >= $1::date
       AND inicio <= $2::date
     GROUP BY ${columna}`,
    [bloque.desde, bloque.hasta],
  );
  const porClave: Record<string, { reservas: number; canceladas: number }> = {};
  let totalReservas = 0;
  let totalCanceladas = 0;
  for (const fila of res.rows) {
    const reservas = Number(fila.reservas);
    const canceladas = Number(fila.canceladas);
    porClave[fila.clave] = { reservas, canceladas };
    totalReservas += reservas;
    totalCanceladas += canceladas;
  }
  return { tipo: 'cancelaciones', totalReservas, totalCanceladas, porClave };
}

async function ejecutarMapTendencias(
  cliente: pg.Client,
  bloque: BloqueParticion,
): Promise<ParcialTendencias> {
  const res = await cliente.query<{
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
    [bloque.desde, bloque.hasta],
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
  return { tipo: 'tendencias', porMes };
}

async function ejecutarBloque(
  cliente: pg.Client,
  tarea: TareaMap,
  bloque: BloqueParticion,
): Promise<ParcialMap> {
  switch (tarea.tipo) {
    case 'destinos':
      return await ejecutarMapDestinos(cliente, bloque);
    case 'cancelaciones':
      return await ejecutarMapCancelaciones(cliente, bloque, tarea.agruparPor);
    case 'tendencias':
      return await ejecutarMapTendencias(cliente, bloque);
  }
}

async function iniciarTrabajador(): Promise<void> {
  const puerto = parentPort;
  if (!puerto) return;

  const { urlBaseAnalitica, tarea, connectionTimeoutMs } = workerData as DatosInicioTrabajador;
  const cliente = new pg.Client({
    connectionString: urlBaseAnalitica,
    connectionTimeoutMillis: connectionTimeoutMs ?? 10_000,
  });
  let cerrando = false;

  cliente.on('error', (err: Error) => {
    if (cerrando) return;
    cerrando = true;
    try {
      const respuesta: MensajeDelTrabajador = {
        tipo: 'error',
        mensaje: err.message || 'Error inesperado en conexión PostgreSQL del trabajador.',
      };
      puerto.postMessage(respuesta);
    } catch {
      // Puerto ya cerrado.
    }
    void cliente.end().catch(() => undefined);
  });

  try {
    await cliente.connect();
  } catch (err) {
    cerrando = true;
    const mensaje: MensajeDelTrabajador = {
      tipo: 'error',
      mensaje: err instanceof Error ? err.message : 'No se pudo conectar a la base de analítica.',
    };
    puerto.postMessage(mensaje);
    return;
  }

  puerto.on('message', (msg: MensajeAlTrabajador) => {
    if (msg.tipo === 'fin') {
      cerrando = true;
      void cliente
        .end()
        .catch(() => undefined)
        .finally(() => {
          puerto.close();
        });
      return;
    }

    void ejecutarBloque(cliente, tarea, msg.bloque)
      .then((parcial) => {
        const respuesta: MensajeDelTrabajador = {
          tipo: 'resultado',
          bloqueId: msg.bloque.id,
          parcial,
        };
        puerto.postMessage(respuesta);
      })
      .catch((err: unknown) => {
        const respuesta: MensajeDelTrabajador = {
          tipo: 'error',
          mensaje: err instanceof Error ? err.message : 'Error ejecutando fase map.',
        };
        puerto.postMessage(respuesta);
        void cliente.end().catch(() => undefined);
      });
  });

  const listo: MensajeDelTrabajador = { tipo: 'listo' };
  puerto.postMessage(listo);
}

void iniciarTrabajador();
