// Coordinador Map-Reduce del Servicio de Analítica (Iteración 6, Táctica 3, QA-5, P2.C5):
// - Divide el rango de fechas en bloques alineados a las particiones mensuales de PostgreSQL
//   (y subdivide bloques en días si hay más procesadores que meses).
// - Enciende N procesos trabajadores en paralelo (worker_threads, 1..50), reparte bloques
//   dinámicamente y apaga todos los trabajadores al finalizar.
// - Combina resultados parciales (fase Reduce) de forma determinística (asociativa y conmutativa),
//   garantizando resultados idénticos con 1, 8 o 50 procesadores.
import { Worker } from 'node:worker_threads';
import type {
  AgrupacionCancelaciones,
  DestinoReservado,
  GrupoCancelaciones,
  ParametrosCancelaciones,
  ParametrosDestinos,
  ParametrosTendencias,
  ResultadoCancelaciones,
  ResultadoConsulta,
  ResultadoDestinos,
  ResultadoTendencias,
  TendenciaMes,
} from './modelo.ts';

export const MAX_PROCESADORES_MAPREDUCE = 50;

export interface BloqueParticion {
  id: number;
  desde: string;
  hasta: string;
}

export type TareaMap =
  | { tipo: 'destinos' }
  | { tipo: 'cancelaciones'; agruparPor: AgrupacionCancelaciones }
  | { tipo: 'tendencias' };

export type ConsultaMapReduce =
  | { tipo: 'destinos'; parametros: ParametrosDestinos }
  | { tipo: 'cancelaciones'; parametros: ParametrosCancelaciones }
  | { tipo: 'tendencias'; parametros: ParametrosTendencias };

export interface ParcialDestinos {
  tipo: 'destinos';
  totalReservas: number;
  porDestino: Record<string, number>;
}

export interface ParcialCancelaciones {
  tipo: 'cancelaciones';
  totalReservas: number;
  totalCanceladas: number;
  porClave: Record<string, { reservas: number; canceladas: number }>;
}

export interface ParcialTendencias {
  tipo: 'tendencias';
  porMes: Record<
    number,
    { reservas: number; canceladas: number; vuelo: number; hotel: number; auto: number }
  >;
}

export type ParcialMap = ParcialDestinos | ParcialCancelaciones | ParcialTendencias;

export type MensajeAlTrabajador = { tipo: 'bloque'; bloque: BloqueParticion } | { tipo: 'fin' };

export type MensajeDelTrabajador =
  | { tipo: 'listo' }
  | { tipo: 'resultado'; bloqueId: number; parcial: ParcialMap }
  | { tipo: 'error'; mensaje: string };

const MS_DIA = 24 * 60 * 60 * 1000;

function fechaUtc(isoFecha: string): Date {
  return new Date(`${isoFecha}T00:00:00Z`);
}

function formatearFechaUtc(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

function sumarDias(isoFecha: string, dias: number): string {
  return formatearFechaUtc(new Date(fechaUtc(isoFecha).getTime() + dias * MS_DIA));
}

function diasInclusivos(desde: string, hasta: string): number {
  return Math.floor((fechaUtc(hasta).getTime() - fechaUtc(desde).getTime()) / MS_DIA) + 1;
}

/**
 * Divide [desde, hasta] primero por límites exactos de partición mensual (YYYY-MM) y, si se piden
 * más procesadores que meses, subdivide iterativamente el bloque más ancho por la mitad (en días).
 */
export function dividirEnBloques(
  desde: string,
  hasta: string,
  objetivoBloques = 1,
): BloqueParticion[] {
  const inicioDate = fechaUtc(desde);
  const finDate = fechaUtc(hasta);
  if (
    Number.isNaN(inicioDate.getTime()) ||
    Number.isNaN(finDate.getTime()) ||
    finDate < inicioDate
  ) {
    throw new Error(`Rango de fechas inválido para Map-Reduce: ${desde} .. ${hasta}`);
  }

  const rangos: { desde: string; hasta: string }[] = [];
  let anio = inicioDate.getUTCFullYear();
  let mes = inicioDate.getUTCMonth();

  while (true) {
    const primeroMes = new Date(Date.UTC(anio, mes, 1));
    if (primeroMes > finDate) break;
    const ultimoMes = new Date(Date.UTC(anio, mes + 1, 0));

    const inicioBloque = primeroMes < inicioDate ? desde : formatearFechaUtc(primeroMes);
    const finBloque = ultimoMes > finDate ? hasta : formatearFechaUtc(ultimoMes);
    rangos.push({ desde: inicioBloque, hasta: finBloque });

    mes += 1;
    if (mes === 12) {
      mes = 0;
      anio += 1;
    }
  }

  const meta = Math.max(1, Math.min(Math.trunc(objetivoBloques), MAX_PROCESADORES_MAPREDUCE * 4));
  while (rangos.length < meta) {
    let idxMasAncho = -1;
    let maxDias = 1;
    for (let i = 0; i < rangos.length; i++) {
      const r = rangos[i];
      if (!r) continue;
      const d = diasInclusivos(r.desde, r.hasta);
      if (d > maxDias) {
        maxDias = d;
        idxMasAncho = i;
      }
    }
    if (idxMasAncho === -1) break;
    const actual = rangos[idxMasAncho];
    if (!actual) break;
    const mitad = Math.floor(maxDias / 2);
    const finPrimera = sumarDias(actual.desde, mitad - 1);
    const inicioSegunda = sumarDias(actual.desde, mitad);
    rangos.splice(
      idxMasAncho,
      1,
      { desde: actual.desde, hasta: finPrimera },
      { desde: inicioSegunda, hasta: actual.hasta },
    );
  }

  return rangos.map((r, id) => ({ id, desde: r.desde, hasta: r.hasta }));
}

export function redondearProporcion(numerador: number, denominador: number): number {
  if (denominador <= 0 || numerador <= 0) return 0;
  const valor = numerador / denominador;
  return Math.min(1, Math.max(0, Number(valor.toFixed(6))));
}

/** Fase Reduce determinística para destinos más reservados. */
export function reducirDestinos(
  parciales: readonly ParcialDestinos[],
  opciones: { desde: string; hasta: string; limite: number; generadoEn: string },
): ResultadoDestinos {
  let totalReservas = 0;
  const acumulado = new Map<string, number>();

  for (const parcial of parciales) {
    totalReservas += parcial.totalReservas;
    for (const [destino, cantidad] of Object.entries(parcial.porDestino)) {
      acumulado.set(destino, (acumulado.get(destino) ?? 0) + cantidad);
    }
  }

  const destinos: DestinoReservado[] = [...acumulado.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, opciones.limite)
    .map(([destino, reservas]) => ({
      destino,
      reservas,
      proporcion: redondearProporcion(reservas, totalReservas),
    }));

  return {
    desde: opciones.desde,
    hasta: opciones.hasta,
    totalReservas,
    destinos,
    generadoEn: opciones.generadoEn,
  };
}

/** Fase Reduce determinística para tasa de cancelación por proveedor o destino. */
export function reducirCancelaciones(
  parciales: readonly ParcialCancelaciones[],
  opciones: {
    desde: string;
    hasta: string;
    agruparPor: AgrupacionCancelaciones;
    generadoEn: string;
  },
): ResultadoCancelaciones {
  let totalReservas = 0;
  let totalCanceladas = 0;
  const acumulado = new Map<string, { reservas: number; canceladas: number }>();

  for (const parcial of parciales) {
    totalReservas += parcial.totalReservas;
    totalCanceladas += parcial.totalCanceladas;
    for (const [clave, datos] of Object.entries(parcial.porClave)) {
      const previo = acumulado.get(clave) ?? { reservas: 0, canceladas: 0 };
      previo.reservas += datos.reservas;
      previo.canceladas += datos.canceladas;
      acumulado.set(clave, previo);
    }
  }

  const grupos: GrupoCancelaciones[] = [...acumulado.entries()]
    .map(([clave, datos]) => ({
      clave,
      reservas: datos.reservas,
      canceladas: datos.canceladas,
      tasaCancelacion: redondearProporcion(datos.canceladas, datos.reservas),
    }))
    .sort(
      (a, b) =>
        b.tasaCancelacion - a.tasaCancelacion ||
        b.canceladas - a.canceladas ||
        b.reservas - a.reservas ||
        a.clave.localeCompare(b.clave),
    );

  return {
    desde: opciones.desde,
    hasta: opciones.hasta,
    agruparPor: opciones.agruparPor,
    total: {
      reservas: totalReservas,
      canceladas: totalCanceladas,
      tasaCancelacion: redondearProporcion(totalCanceladas, totalReservas),
    },
    grupos,
    generadoEn: opciones.generadoEn,
  };
}

/** Fase Reduce determinística para tendencias mensuales (siempre los 12 meses del año). */
export function reducirTendencias(
  parciales: readonly ParcialTendencias[],
  opciones: { anio: number; generadoEn: string },
): ResultadoTendencias {
  const porMes = new Map<
    number,
    { reservas: number; canceladas: number; vuelo: number; hotel: number; auto: number }
  >();
  for (let mes = 1; mes <= 12; mes++) {
    porMes.set(mes, { reservas: 0, canceladas: 0, vuelo: 0, hotel: 0, auto: 0 });
  }

  for (const parcial of parciales) {
    for (const [mesTexto, datos] of Object.entries(parcial.porMes)) {
      const mes = Number(mesTexto);
      const acumulado = porMes.get(mes);
      if (!acumulado) continue;
      acumulado.reservas += datos.reservas;
      acumulado.canceladas += datos.canceladas;
      acumulado.vuelo += datos.vuelo;
      acumulado.hotel += datos.hotel;
      acumulado.auto += datos.auto;
    }
  }

  const periodos: TendenciaMes[] = [];
  for (let mes = 1; mes <= 12; mes++) {
    const datos = porMes.get(mes) ?? { reservas: 0, canceladas: 0, vuelo: 0, hotel: 0, auto: 0 };
    periodos.push({
      mes,
      reservas: datos.reservas,
      canceladas: datos.canceladas,
      porTipoReserva: {
        vuelo: datos.vuelo,
        hotel: datos.hotel,
        auto: datos.auto,
      },
    });
  }

  return {
    anio: opciones.anio,
    agruparPor: 'mes',
    periodos,
    generadoEn: opciones.generadoEn,
  };
}

export interface OpcionesMapReduce {
  urlBaseAnalitica: string;
  consulta: ConsultaMapReduce;
  /** Procesadores pedidos (1..50). Si se omite, el coordinador elige según cantidad de bloques. */
  procesadores?: number;
  /** Tope por defecto cuando el cliente no indica `procesadores`. */
  procesadoresDefecto?: number;
  alIniciar?: (procesadoresUsados: number, totalBloques: number) => void | Promise<void>;
  alProgresar?: (progreso: number, completados: number, total: number) => void | Promise<void>;
  ahora?: () => number;
  /** Tiempo máximo para que todos los worker_threads se conecten y reporten 'listo'. */
  timeoutArranqueMs?: number;
  /** Tiempo máximo total de ejecución de la consulta Map-Reduce. */
  timeoutTotalMs?: number;
  /** Espera de gracia para apagado limpio de workers antes de llamar terminate(). */
  graciaApagadoMs?: number;
  /** Override opcional de la ruta del trabajador (útil en pruebas unitarias). */
  rutaTrabajador?: URL;
}

export interface ResultadoEjecucionMapReduce {
  resultado: ResultadoConsulta;
  procesadores: number;
  bloques: number;
  /** Tiempo total de pared (incluyendo encendido y apagado de worker_threads). */
  duracionMs: number;
  /** Tiempo neto de la fase Map-Reduce una vez que los trabajadores están listos. */
  duracionProcesamientoMs: number;
}

function rangoYTareaDe(consulta: ConsultaMapReduce): {
  desde: string;
  hasta: string;
  tarea: TareaMap;
} {
  if (consulta.tipo === 'destinos') {
    return {
      desde: consulta.parametros.desde,
      hasta: consulta.parametros.hasta,
      tarea: { tipo: 'destinos' },
    };
  }
  if (consulta.tipo === 'cancelaciones') {
    return {
      desde: consulta.parametros.desde,
      hasta: consulta.parametros.hasta,
      tarea: { tipo: 'cancelaciones', agruparPor: consulta.parametros.agruparPor },
    };
  }
  return {
    desde: `${consulta.parametros.anio}-01-01`,
    hasta: `${consulta.parametros.anio}-12-31`,
    tarea: { tipo: 'tendencias' },
  };
}

/**
 * Ejecuta una consulta pesada encendiendo `N` worker_threads paralelos sobre los bloques de
 * partición de la base de analítica, recolecta resultados parciales (Map), los reduce y apaga
 * todos los trabajadores al finalizar.
 */
export async function ejecutarMapReduce(
  opciones: OpcionesMapReduce,
): Promise<ResultadoEjecucionMapReduce> {
  const { urlBaseAnalitica, consulta } = opciones;
  const ahora = opciones.ahora ?? Date.now;
  const inicioMs = performance.now();

  const { desde, hasta, tarea } = rangoYTareaDe(consulta);
  const solicitados =
    opciones.procesadores ?? consulta.parametros.procesadores ?? opciones.procesadoresDefecto ?? 4;
  const topeProcesadores = Math.max(
    1,
    Math.min(Math.trunc(solicitados), MAX_PROCESADORES_MAPREDUCE),
  );

  const bloques = dividirEnBloques(desde, hasta, topeProcesadores);
  const cantidadTrabajadores = Math.max(1, Math.min(topeProcesadores, bloques.length));

  await opciones.alIniciar?.(cantidadTrabajadores, bloques.length);

  const rutaTrabajador = opciones.rutaTrabajador ?? new URL('./trabajador-mr.ts', import.meta.url);
  const timeoutArranqueMs = Math.max(10, opciones.timeoutArranqueMs ?? 30_000);
  const timeoutTotalMs = Math.max(10, opciones.timeoutTotalMs ?? 10 * 60_000);
  const graciaApagadoMs = Math.max(0, opciones.graciaApagadoMs ?? 1_000);
  const trabajadores: Worker[] = [];
  const salidos = new Set<Worker>();
  const esperandoFin = new Set<Worker>();
  const parciales: ParcialMap[] = [];
  let inicioProcesamientoMs = 0;

  try {
    await new Promise<void>((resolver, rechazar) => {
      let siguienteBloque = 0;
      let completados = 0;
      let listos = 0;
      let terminado = false;
      let timerArranque: NodeJS.Timeout | undefined;
      let timerTotal: NodeJS.Timeout | undefined;

      const limpiarTemporizadores = () => {
        if (timerArranque) {
          clearTimeout(timerArranque);
          timerArranque = undefined;
        }
        if (timerTotal) {
          clearTimeout(timerTotal);
          timerTotal = undefined;
        }
      };

      const fallar = (err: Error) => {
        if (terminado) return;
        terminado = true;
        limpiarTemporizadores();
        rechazar(err);
      };

      timerArranque = setTimeout(() => {
        fallar(new Error('Tiempo agotado esperando inicio de trabajadores Map-Reduce.'));
      }, timeoutArranqueMs);
      timerArranque.unref();

      timerTotal = setTimeout(() => {
        fallar(new Error('Tiempo máximo de ejecución Map-Reduce excedido.'));
      }, timeoutTotalMs);
      timerTotal.unref();

      const asignarSiguiente = (trabajador: Worker) => {
        if (terminado) return;
        const bloque = bloques[siguienteBloque++];
        if (!bloque) {
          esperandoFin.add(trabajador);
          const fin: MensajeAlTrabajador = { tipo: 'fin' };
          trabajador.postMessage(fin);
          return;
        }
        const envio: MensajeAlTrabajador = { tipo: 'bloque', bloque };
        trabajador.postMessage(envio);
      };

      for (let i = 0; i < cantidadTrabajadores; i++) {
        const trabajador = new Worker(rutaTrabajador, {
          workerData: {
            urlBaseAnalitica,
            tarea,
            connectionTimeoutMs: Math.min(timeoutArranqueMs, 10_000),
          },
        });
        trabajadores.push(trabajador);

        trabajador.on('message', (msg: MensajeDelTrabajador) => {
          if (terminado) return;
          if (msg.tipo === 'listo') {
            listos += 1;
            if (listos === cantidadTrabajadores) {
              if (timerArranque) {
                clearTimeout(timerArranque);
                timerArranque = undefined;
              }
              // Arrancamos los N trabajadores simultáneamente cuando todos conectaron.
              inicioProcesamientoMs = performance.now();
              for (const t of trabajadores) {
                asignarSiguiente(t);
              }
            }
            return;
          }
          if (msg.tipo === 'error') {
            fallar(new Error(msg.mensaje));
            return;
          }
          parciales.push(msg.parcial);
          completados += 1;
          const progreso = Number((completados / bloques.length).toFixed(4));
          void Promise.resolve(opciones.alProgresar?.(progreso, completados, bloques.length)).catch(
            () => undefined,
          );

          if (completados === bloques.length) {
            terminado = true;
            limpiarTemporizadores();
            resolver();
            return;
          }
          asignarSiguiente(trabajador);
        });

        trabajador.on('error', (err: Error) => {
          fallar(err);
        });

        trabajador.on('exit', (codigo) => {
          salidos.add(trabajador);
          if (!terminado && (!esperandoFin.has(trabajador) || codigo !== 0)) {
            fallar(
              new Error(`Trabajador Map-Reduce finalizó inesperadamente con código ${codigo}`),
            );
          }
        });
      }
    });
  } finally {
    // Pedimos cierre ordenado y damos una breve ventana antes de forzar terminate().
    await Promise.allSettled(
      trabajadores.map(async (trabajador) => {
        if (salidos.has(trabajador)) return;
        try {
          const fin: MensajeAlTrabajador = { tipo: 'fin' };
          trabajador.postMessage(fin);
        } catch {
          // El trabajador ya se cerró.
        }
        if (graciaApagadoMs > 0 && !salidos.has(trabajador)) {
          await new Promise<void>((res) => {
            const alSalir = () => {
              clearTimeout(timer);
              res();
            };
            const timer = setTimeout(() => {
              trabajador.off('exit', alSalir);
              res();
            }, graciaApagadoMs);
            timer.unref();
            trabajador.once('exit', alSalir);
          });
        }
        if (!salidos.has(trabajador)) {
          await trabajador.terminate();
        }
      }),
    );
  }

  const finProcesamientoMs = performance.now();
  const generadoEn = new Date(ahora()).toISOString();
  let resultado: ResultadoConsulta;
  if (consulta.tipo === 'destinos') {
    resultado = reducirDestinos(parciales as ParcialDestinos[], {
      desde,
      hasta,
      limite: consulta.parametros.limite ?? 10,
      generadoEn,
    });
  } else if (consulta.tipo === 'cancelaciones') {
    resultado = reducirCancelaciones(parciales as ParcialCancelaciones[], {
      desde,
      hasta,
      agruparPor: consulta.parametros.agruparPor,
      generadoEn,
    });
  } else {
    resultado = reducirTendencias(parciales as ParcialTendencias[], {
      anio: consulta.parametros.anio,
      generadoEn,
    });
  }

  const finTotalMs = performance.now();
  return {
    resultado,
    procesadores: cantidadTrabajadores,
    bloques: bloques.length,
    duracionMs: Math.max(0, Math.round(finTotalMs - inicioMs)),
    duracionProcesamientoMs:
      inicioProcesamientoMs > 0
        ? Math.max(0, Math.round(finProcesamientoMs - inicioProcesamientoMs))
        : Math.max(0, Math.round(finTotalMs - inicioMs)),
  };
}
