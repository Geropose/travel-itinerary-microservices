// QA-5: consulta Map-Reduce con distintos números de procesadores (P4.1).
//
// Iteración 6, Paso 7: 180 millones de reservas anonimizadas (15 millones de cuentas, 4 por año,
// 3 años). Un procesador recorre 1 millón por minuto: con 50 procesadores la consulta completa tarda
// unos 4 minutos. Los procesadores se encienden solo para la consulta y se apagan al terminar.
//
// El prototipo corre en una sola computadora (los procesadores son hilos del Servicio de Analítica
// y todos leen la misma base). No cargamos 180 millones: generamos un histórico de 3 años con
// --filas filas (por defecto 5 millones) y medimos la misma consulta con 1, 2, 4, 8 y 16
// procesadores. De ahí sale cuántas filas por minuto recorre un procesador y cuánto mejora al sumar
// procesadores, para compararlo con la estimación de la wiki.
//
// Cómo mide:
// 1. Genera el histórico en los años 2019 a 2021 (vacíos en la base de analítica) con el generador
//    del servicio (services/analitica/scripts/generar-historico.ts), dentro del contenedor.
// 2. Como analista, lanza POST /api/analitica/consultas/cancelaciones/ejecutar con esos 3 años y
//    los procesadores pedidos, y sigue GET /consultas/ejecuciones/{consultaId} hasta que termina.
//    Usa la duración que informa el servicio (duracionMs) y comprueba que el resultado es el mismo
//    con cualquier cantidad de procesadores.
// 3. Al final borra el histórico generado.
//
// Uso: node tests/carga/mapreduce.ts [--filas 5000000] [--procesadores 1,2,4,8,16] [--veces 3]
import { execFileSync } from 'node:child_process';
import { duracion } from './calculos.ts';
import {
  argumento,
  CONFIG_E2E,
  escribir,
  esperar,
  loginAnalista,
  pedirJson,
  sistemaDisponible,
} from './comun.ts';

const FILAS = Number(argumento('filas', '5000000'));
const PROCESADORES = argumento('procesadores', '1,2,4,8,16').split(',').map(Number);
const VECES = Number(argumento('veces', '3'));
const DESDE = '2019-01-01';
const HASTA = '2021-12-31';

if (!(await sistemaDisponible())) {
  escribir('El sistema no está levantado: corré npm run infra:levantar.');
  process.exit(1);
}

const docker = (args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 10_000_000 });
const BASE_ANALITICA = docker([
  'ps',
  '--filter',
  'name=postgres-analitica',
  '--format',
  '{{.Names}}',
]).trim();
if (!BASE_ANALITICA) throw new Error('No encontré el contenedor de la base de analítica');
const sqlAnalitica = (sql: string) =>
  docker(['exec', BASE_ANALITICA, 'psql', '-U', 'admin', '-d', 'analitica', '-tAc', sql]).trim();
const filasDelPeriodo = () =>
  Number(
    sqlAnalitica(
      `SELECT count(*) FROM reservas_anonimizadas WHERE inicio BETWEEN '${DESDE}' AND '${HASTA}'`,
    ),
  );

if (filasDelPeriodo() !== 0) {
  escribir(`Ya hay filas entre ${DESDE} y ${HASTA} en la base de analítica: no se mide.`);
  process.exit(1);
}

interface Ejecucion {
  consultaId: string;
  estado: 'pendiente' | 'enCurso' | 'terminada' | 'fallida';
  procesadores: number;
  duracionMs?: number;
  resultado?: { total: { reservas: number; canceladas: number } };
  error?: unknown;
}

interface Corrida {
  procesadores: number;
  duracionMs: number;
  totalReservas: number;
  totalCanceladas: number;
}

const corridas: Corrida[] = [];
try {
  // --- 1. Histórico generado -------------------------------------------------------------
  const inicioGeneracion = Date.now();
  docker([
    'exec',
    'r1-analitica-1',
    'node',
    'services/analitica/scripts/generar-historico.ts',
    `--cantidad=${FILAS}`,
    '--desde-anio=2019',
    '--hasta-anio=2021',
  ]);
  sqlAnalitica('ANALYZE reservas_anonimizadas');
  const generadas = filasDelPeriodo();
  escribir(`${generadas} filas generadas en ${duracion(Date.now() - inicioGeneracion)}`);

  // --- 2. La misma consulta con distintos procesadores -----------------------------------
  let { jwt } = await loginAnalista();
  const cabeceras = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${jwt}`,
    'X-Region': 'region-1',
  });
  const URL_ANALITICA = `${CONFIG_E2E.urlEnrutador}/api/analitica/consultas`;
  // Una corrida de calentamiento (la base trae las páginas a memoria), que no se cuenta.
  for (const procesadores of [
    PROCESADORES.at(-1) ?? 1,
    ...PROCESADORES.flatMap((p) => Array<number>(VECES).fill(p)),
  ].map((p, i) => ({ p, calentamiento: i === 0 }))) {
    ({ jwt } = await loginAnalista());
    const lanzada = await pedirJson<{ consultaId: string }>(
      `${URL_ANALITICA}/cancelaciones/ejecutar`,
      {
        method: 'POST',
        headers: cabeceras(),
        body: JSON.stringify({
          desde: DESDE,
          hasta: HASTA,
          agruparPor: 'proveedor',
          procesadores: procesadores.p,
        }),
      },
    );
    if (lanzada.status !== 202 || !lanzada.datos) {
      throw new Error(`Ejecutar: HTTP ${lanzada.status} ${lanzada.texto}`);
    }
    let ejecucion: Ejecucion | undefined;
    for (;;) {
      const r = await pedirJson<Ejecucion>(
        `${URL_ANALITICA}/ejecuciones/${lanzada.datos.consultaId}`,
        { headers: cabeceras() },
      );
      ejecucion = r.datos;
      if (ejecucion?.estado === 'terminada' || ejecucion?.estado === 'fallida') break;
      await esperar(200);
    }
    if (ejecucion.estado === 'fallida' || !ejecucion.resultado) {
      throw new Error(`La consulta falló: ${JSON.stringify(ejecucion.error)}`);
    }
    const corrida = {
      procesadores: ejecucion.procesadores,
      duracionMs: ejecucion.duracionMs ?? NaN,
      totalReservas: ejecucion.resultado.total.reservas,
      totalCanceladas: ejecucion.resultado.total.canceladas,
    };
    escribir(
      `  ${procesadores.calentamiento ? '(calentamiento) ' : ''}${corrida.procesadores} procesadores: ${duracion(corrida.duracionMs)}`,
    );
    if (!procesadores.calentamiento) corridas.push(corrida);
  }

  const mediana = (valores: number[]) => {
    const v = [...valores].sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)] ?? NaN;
  };
  const totales = new Set(corridas.map((c) => `${c.totalReservas}/${c.totalCanceladas}`));
  escribir(
    `QA-5: consulta Map-Reduce de cancelaciones por proveedor, ${generadas} filas de 3 años`,
  );
  escribir(
    `  Mismo resultado con todas las cantidades de procesadores: ${totales.size === 1 ? 'sí' : 'no'} (${[...totales].join(', ')})`,
  );
  const base = mediana(
    corridas.filter((c) => c.procesadores === PROCESADORES[0]).map((c) => c.duracionMs),
  );
  escribir(
    '  Procesadores | Duración (mediana) | Filas por minuto por procesador | Mejora contra 1',
  );
  for (const p of PROCESADORES) {
    const ms = mediana(corridas.filter((c) => c.procesadores === p).map((c) => c.duracionMs));
    const porProcesador = Math.round(generadas / (ms / 60_000) / p);
    escribir(
      `  ${String(p).padStart(12)} | ${duracion(ms).padEnd(18)} | ${String(porProcesador).padEnd(31)} | ${(base / ms).toFixed(1)}x`,
    );
  }
  escribir(JSON.stringify({ filas: generadas, corridas }));
} finally {
  // --- 3. Se borra el histórico generado --------------------------------------------------
  sqlAnalitica(`DELETE FROM reservas_anonimizadas WHERE inicio BETWEEN '${DESDE}' AND '${HASTA}'`);
}
