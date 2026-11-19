// Rutas HTTP del Servicio de Analítica (specs/openapi/analitica.yaml, Iteración 6, UC-7, QA-5):
// - Consultas síncronas (GET /consultas/{destinos,cancelaciones,tendencias})
// - Consultas pesadas asíncronas con Map-Reduce (POST /consultas/{tipo}/ejecutar -> 202 + Location,
//   GET /consultas/ejecuciones/{consultaId})
// Todas las rutas salvo GET /health exigen rol analista (validado por el Validador de Intercepción).
import { randomUUID } from 'node:crypto';
import { errores, type Logger, type Pool, type Servidor } from '@trotamundos/comun';
import { ejecutarMapReduce, type ConsultaMapReduce } from './mapreduce.ts';
import type {
  AgrupacionCancelaciones,
  ConsultaLanzada,
  EjecucionPublica,
  ParametrosCancelaciones,
  ParametrosConsulta,
  ParametrosDestinos,
  ParametrosTendencias,
  ResultadoCancelaciones,
  ResultadoDestinos,
  ResultadoTendencias,
  TipoConsulta,
} from './modelo.ts';
import * as repositorio from './repositorio.ts';

export interface OpcionesNegocioAnalitica {
  poolAnalitica: Pool;
  /** URL de conexión PostgreSQL a la base global de analítica para los worker_threads Map-Reduce. */
  urlBaseAnalitica: string;
  logger: Logger;
  procesadoresDefecto?: number;
  ahora?: () => number;
}

export interface NegocioAnalitica {
  consultarDestinos(params: {
    desde: string;
    hasta: string;
    limite: number;
  }): Promise<ResultadoDestinos>;
  consultarCancelaciones(params: {
    desde: string;
    hasta: string;
    agruparPor: AgrupacionCancelaciones;
  }): Promise<ResultadoCancelaciones>;
  consultarTendencias(params: { anio: number }): Promise<ResultadoTendencias>;
  lanzarEjecucion(tipo: TipoConsulta, cuerpo: Record<string, unknown>): Promise<ConsultaLanzada>;
  obtenerEjecucion(consultaId: string): Promise<EjecucionPublica>;
  detener(): Promise<void>;
}

function validarRangoFechas(desde: string, hasta: string): void {
  if (hasta < desde) {
    throw errores.solicitudInvalida('La fecha hasta debe ser igual o posterior a desde.', [
      { campo: 'hasta', mensaje: 'tiene que ser igual o posterior a desde' },
    ]);
  }
}

function validarYNormalizarConsulta(
  tipo: TipoConsulta,
  cuerpo: Record<string, unknown>,
): { consulta: ConsultaMapReduce; parametros: ParametrosConsulta; claveDedup: string } {
  if (tipo === 'destinos') {
    if (
      typeof cuerpo.desde !== 'string' ||
      typeof cuerpo.hasta !== 'string' ||
      'agruparPor' in cuerpo ||
      'anio' in cuerpo
    ) {
      throw errores.solicitudInvalida(
        'El cuerpo no corresponde a una consulta de tipo destinos (se esperan desde, hasta y opcionalmente limite y procesadores).',
      );
    }
    validarRangoFechas(cuerpo.desde, cuerpo.hasta);
    const limite = typeof cuerpo.limite === 'number' ? cuerpo.limite : 10;
    const procesadores = typeof cuerpo.procesadores === 'number' ? cuerpo.procesadores : undefined;
    const parametros: ParametrosDestinos = {
      desde: cuerpo.desde,
      hasta: cuerpo.hasta,
      ...(typeof cuerpo.limite === 'number' ? { limite } : {}),
      ...(procesadores !== undefined ? { procesadores } : {}),
    };
    const claveDedup = JSON.stringify({
      tipo: 'destinos',
      desde: parametros.desde,
      hasta: parametros.hasta,
      limite,
    });
    return { consulta: { tipo: 'destinos', parametros }, parametros, claveDedup };
  }

  if (tipo === 'cancelaciones') {
    if (
      typeof cuerpo.desde !== 'string' ||
      typeof cuerpo.hasta !== 'string' ||
      (cuerpo.agruparPor !== 'proveedor' && cuerpo.agruparPor !== 'destino') ||
      'limite' in cuerpo ||
      'anio' in cuerpo
    ) {
      throw errores.solicitudInvalida(
        'El cuerpo no corresponde a una consulta de tipo cancelaciones (se esperan desde, hasta, agruparPor y opcionalmente procesadores).',
      );
    }
    validarRangoFechas(cuerpo.desde, cuerpo.hasta);
    const procesadores = typeof cuerpo.procesadores === 'number' ? cuerpo.procesadores : undefined;
    const parametros: ParametrosCancelaciones = {
      desde: cuerpo.desde,
      hasta: cuerpo.hasta,
      agruparPor: cuerpo.agruparPor,
      ...(procesadores !== undefined ? { procesadores } : {}),
    };
    const claveDedup = JSON.stringify({
      tipo: 'cancelaciones',
      desde: parametros.desde,
      hasta: parametros.hasta,
      agruparPor: parametros.agruparPor,
    });
    return { consulta: { tipo: 'cancelaciones', parametros }, parametros, claveDedup };
  }

  if (
    typeof cuerpo.anio !== 'number' ||
    'desde' in cuerpo ||
    'hasta' in cuerpo ||
    'limite' in cuerpo
  ) {
    throw errores.solicitudInvalida(
      'El cuerpo no corresponde a una consulta de tipo tendencias (se esperan anio y opcionalmente agruparPor y procesadores).',
    );
  }
  const procesadores = typeof cuerpo.procesadores === 'number' ? cuerpo.procesadores : undefined;
  const parametros: ParametrosTendencias = {
    anio: cuerpo.anio,
    agruparPor: 'mes',
    ...(procesadores !== undefined ? { procesadores } : {}),
  };
  const claveDedup = JSON.stringify({
    tipo: 'tendencias',
    anio: parametros.anio,
    agruparPor: 'mes',
  });
  return { consulta: { tipo: 'tendencias', parametros }, parametros, claveDedup };
}

export function crearNegocioAnalitica(opciones: OpcionesNegocioAnalitica): NegocioAnalitica {
  const { poolAnalitica, urlBaseAnalitica, logger } = opciones;
  const procesadoresDefecto = opciones.procesadoresDefecto ?? 4;
  const ahora = opciones.ahora ?? Date.now;
  const ejecucionesEnCurso = new Set<Promise<void>>();

  async function correrEnSegundoPlano(
    consultaId: string,
    consulta: ConsultaMapReduce,
  ): Promise<void> {
    const inicioReal = performance.now();
    try {
      const resultadoMr = await ejecutarMapReduce({
        urlBaseAnalitica,
        consulta,
        procesadoresDefecto,
        ahora,
        alIniciar: async (procesadoresUsados) => {
          await repositorio.marcarEjecucionEnCurso(
            poolAnalitica,
            consultaId,
            procesadoresUsados,
            new Date(ahora()),
          );
        },
        alProgresar: async (progreso) => {
          await repositorio.actualizarProgresoEjecucion(poolAnalitica, consultaId, progreso);
        },
      });

      await repositorio.marcarEjecucionTerminada(poolAnalitica, consultaId, {
        terminadaEn: new Date(ahora()),
        duracionMs: resultadoMr.duracionMs,
        resultado: resultadoMr.resultado,
      });
      logger.info(
        {
          consultaId,
          tipo: consulta.tipo,
          procesadores: resultadoMr.procesadores,
          bloques: resultadoMr.bloques,
          duracionMs: resultadoMr.duracionMs,
        },
        'consulta Map-Reduce finalizada',
      );
    } catch (err) {
      const duracionMs = Math.max(0, Math.round(performance.now() - inicioReal));
      const mensaje =
        err instanceof Error ? err.message : 'Error inesperado durante la ejecución Map-Reduce.';
      logger.error({ err, consultaId, tipo: consulta.tipo }, 'falló la consulta Map-Reduce');
      await repositorio
        .marcarEjecucionFallida(poolAnalitica, consultaId, {
          terminadaEn: new Date(ahora()),
          duracionMs,
          error: mensaje,
        })
        .catch((errDb: unknown) => {
          logger.warn({ err: errDb, consultaId }, 'no se pudo registrar el fallo de la consulta');
        });
    }
  }

  return {
    async consultarDestinos({ desde, hasta, limite }) {
      validarRangoFechas(desde, hasta);
      return await repositorio.consultarDestinosDirecto(poolAnalitica, {
        desde,
        hasta,
        limite,
        generadoEn: new Date(ahora()).toISOString(),
      });
    },

    async consultarCancelaciones({ desde, hasta, agruparPor }) {
      validarRangoFechas(desde, hasta);
      return await repositorio.consultarCancelacionesDirecto(poolAnalitica, {
        desde,
        hasta,
        agruparPor,
        generadoEn: new Date(ahora()).toISOString(),
      });
    },

    async consultarTendencias({ anio }) {
      return await repositorio.consultarTendenciasDirecto(poolAnalitica, {
        anio,
        generadoEn: new Date(ahora()).toISOString(),
      });
    },

    async lanzarEjecucion(tipo, cuerpo) {
      const { consulta, parametros, claveDedup } = validarYNormalizarConsulta(tipo, cuerpo);
      const consultaId = randomUUID();
      const creadaEn = new Date(ahora());

      const alta = await repositorio.crearEjecucion(poolAnalitica, {
        consultaId,
        tipo,
        parametros,
        claveDedup,
        creadaEn,
      });
      if (!alta.creada) {
        throw errores.conflicto(
          `Ya se está ejecutando la consulta ${alta.consultaIdExistente} con los mismos parámetros.`,
        );
      }

      const promesa = correrEnSegundoPlano(consultaId, consulta);
      ejecucionesEnCurso.add(promesa);
      void promesa.finally(() => {
        ejecucionesEnCurso.delete(promesa);
      });

      return {
        consultaId: alta.ejecucion.consultaId,
        tipo: alta.ejecucion.tipo,
        estado: alta.ejecucion.estado,
        creadaEn: alta.ejecucion.creadaEn,
      };
    },

    async obtenerEjecucion(consultaId) {
      const ejecucion = await repositorio.obtenerEjecucion(poolAnalitica, consultaId);
      if (!ejecucion) {
        throw errores.noEncontrado(`No existe la ejecución de consulta ${consultaId}.`);
      }
      return ejecucion;
    },

    async detener() {
      if (ejecucionesEnCurso.size > 0) {
        await Promise.allSettled([...ejecucionesEnCurso]);
      }
    },
  };
}

export function registrarRutas(servidor: Servidor, negocio: NegocioAnalitica): void {
  const { app } = servidor;

  app.get('/consultas/destinos', async (req, res) => {
    const desde = String(req.query.desde);
    const hasta = String(req.query.hasta);
    const limite = req.query.limite !== undefined ? Number(req.query.limite) : 10;
    const resultado = await negocio.consultarDestinos({ desde, hasta, limite });
    res.json(resultado);
  });

  app.get('/consultas/cancelaciones', async (req, res) => {
    const desde = String(req.query.desde);
    const hasta = String(req.query.hasta);
    const agruparPor = String(req.query.agruparPor) as AgrupacionCancelaciones;
    const resultado = await negocio.consultarCancelaciones({ desde, hasta, agruparPor });
    res.json(resultado);
  });

  app.get('/consultas/tendencias', async (req, res) => {
    const anio = Number(req.query.anio);
    const resultado = await negocio.consultarTendencias({ anio });
    res.json(resultado);
  });

  app.post('/consultas/:tipo/ejecutar', async (req, res) => {
    const tipo = String(req.params.tipo) as TipoConsulta;
    const lanzada = await negocio.lanzarEjecucion(tipo, req.body as Record<string, unknown>);
    res
      .status(202)
      .setHeader('Location', `/api/analitica/consultas/ejecuciones/${lanzada.consultaId}`)
      .json(lanzada);
  });

  app.get('/consultas/ejecuciones/:consultaId', async (req, res) => {
    const ejecucion = await negocio.obtenerEjecucion(String(req.params.consultaId));
    res.json(ejecucion);
  });
}
