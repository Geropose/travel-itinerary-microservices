import type { Logger, Pool } from '@trotamundos/comun';
import type { RegistroAdaptadoresProveedores } from './adaptadores/registro.ts';
import type { AdaptadorProveedorViaje } from './adaptadores/tipos.ts';
import type { ProcesadorProveedores } from './procesador.ts';
import * as repositorio from './repositorio.ts';

export interface ResultadoCicloConsulta {
  proveedor: string;
  ejecutado: boolean;
  recibidos: number;
  aceptados: number;
  repetidos: number;
  noTraducidos: number;
  error?: string;
}

export interface OpcionesConsultadorProveedores {
  pool: Pool;
  registro: RegistroAdaptadoresProveedores;
  procesador: ProcesadorProveedores;
  logger: Logger;
  /** Ventana hacia atrás al crear el primer cursor de un proveedor (ms; defecto 5 min). */
  ventanaInicialMs?: number;
  /** Espera antes del primer ciclo automático tras llamar a `iniciar()` (ms; defecto 2000). */
  demoraInicialMs?: number;
  ahora?: () => number;
}

export interface ConsultadorProveedores {
  iniciar(): void;
  detener(): Promise<void>;
  consultarProveedor(nombre: string): Promise<ResultadoCicloConsulta>;
  consultarTodos(): Promise<ResultadoCicloConsulta[]>;
}

/**
 * Consulta periódicamente los proveedores que no avisan (`modo === "consulta"`, como hotel y
 * rentadora) respetando el intervalo configurado (por defecto 2 min, Iteración 3).
 *
 * - Usa `pg_try_advisory_lock` por proveedor para coordinar varias instancias sin duplicar tráfico.
 * - Ante errores de red o 503 no avanza el cursor, así no se pierde ningún cambio en la siguiente
 *   vuelta (specs/externos/hotel.md, specs/externos/rentadora.md).
 */
export function crearConsultadorProveedores(
  opciones: OpcionesConsultadorProveedores,
): ConsultadorProveedores {
  const {
    pool,
    registro,
    procesador,
    logger,
    ventanaInicialMs = 5 * 60_000,
    demoraInicialMs = 2000,
    ahora = Date.now,
  } = opciones;

  const temporizadores = new Map<string, NodeJS.Timeout>();
  const vueltasActivas = new Set<Promise<unknown>>();
  let iniciado = false;
  let detenido = false;

  async function ejecutarConsulta(
    adaptador: AdaptadorProveedorViaje,
  ): Promise<ResultadoCicloConsulta> {
    const clienteLock = await pool.connect();
    let tieneLock = false;
    try {
      tieneLock = await repositorio.intentarLockConsulta(clienteLock, adaptador.nombre);
      if (!tieneLock) {
        return {
          proveedor: adaptador.nombre,
          ejecutado: false,
          recibidos: 0,
          aceptados: 0,
          repetidos: 0,
          noTraducidos: 0,
        };
      }

      const cursorPrevio = await repositorio.obtenerCursorConsulta(pool, adaptador.nombre);
      const desde = cursorPrevio ?? new Date(ahora() - ventanaInicialMs).toISOString();

      let respuesta: Awaited<ReturnType<AdaptadorProveedorViaje['consultarCambios']>>;
      try {
        respuesta = await adaptador.consultarCambios(desde);
      } catch (error) {
        logger.warn(
          { err: error, proveedor: adaptador.nombre, desde },
          'Falló la consulta periódica al proveedor; se reintentará con el mismo cursor',
        );
        return {
          proveedor: adaptador.nombre,
          ejecutado: true,
          recibidos: 0,
          aceptados: 0,
          repetidos: 0,
          noTraducidos: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      let aceptados = 0;
      let repetidos = 0;
      let noTraducidos = 0;

      for (const mensaje of respuesta.mensajes) {
        const estado = await procesador.procesarMensaje(adaptador, mensaje, 'consulta');
        if (estado === 'aceptado') aceptados++;
        else if (estado === 'repetido') repetidos++;
        else noTraducidos++;
      }

      if (respuesta.marcaMasAlta) {
        // Nunca avanzar el cursor al futuro si un proveedor devuelve un reloj adelantado.
        const topeMs = ahora();
        const marcaMs = Date.parse(respuesta.marcaMasAlta);
        const cursorNuevo =
          Number.isFinite(marcaMs) && marcaMs > topeMs
            ? new Date(topeMs).toISOString()
            : respuesta.marcaMasAlta;
        await repositorio.guardarCursorConsulta(pool, adaptador.nombre, cursorNuevo);
      } else if (!cursorPrevio) {
        await repositorio.guardarCursorConsulta(pool, adaptador.nombre, desde);
      }

      return {
        proveedor: adaptador.nombre,
        ejecutado: true,
        recibidos: respuesta.mensajes.length,
        aceptados,
        repetidos,
        noTraducidos,
      };
    } finally {
      let errorDesbloqueo: unknown;
      if (tieneLock) {
        try {
          await repositorio.liberarLockConsulta(clienteLock, adaptador.nombre);
        } catch (error) {
          errorDesbloqueo = error;
          logger.warn(
            { err: error, proveedor: adaptador.nombre },
            'No se pudo liberar el bloqueo de consulta periódica; se descarta la conexión del pool',
          );
        }
      }
      clienteLock.release(
        errorDesbloqueo !== undefined
          ? errorDesbloqueo instanceof Error
            ? errorDesbloqueo
            : true
          : undefined,
      );
    }
  }

  async function consultarProveedor(nombre: string): Promise<ResultadoCicloConsulta> {
    const adaptador = registro.obtener(nombre);
    if (!adaptador || adaptador.modo !== 'consulta') {
      throw new Error(`No existe un proveedor de consulta registrado con nombre "${nombre}".`);
    }
    return ejecutarConsulta(adaptador);
  }

  async function consultarTodos(): Promise<ResultadoCicloConsulta[]> {
    const adaptadores = registro.listarPorModo('consulta');
    const resultados: ResultadoCicloConsulta[] = [];
    for (const adaptador of adaptadores) {
      resultados.push(await ejecutarConsulta(adaptador));
    }
    return resultados;
  }

  function programar(adaptador: AdaptadorProveedorViaje, esperaMs: number): void {
    if (detenido) return;
    const temporizador = setTimeout(() => {
      if (detenido) return;
      const vuelta = ejecutarConsulta(adaptador)
        .catch((error: unknown) => {
          logger.warn({ err: error, proveedor: adaptador.nombre }, 'Error en ciclo de consulta');
        })
        .finally(() => {
          vueltasActivas.delete(vuelta);
          programar(adaptador, adaptador.intervaloConsultaMs);
        });
      vueltasActivas.add(vuelta);
    }, esperaMs);
    temporizador.unref();
    temporizadores.set(adaptador.nombre, temporizador);
  }

  function iniciar(): void {
    if (iniciado) return;
    iniciado = true;
    detenido = false;
    for (const adaptador of registro.listarPorModo('consulta')) {
      programar(adaptador, Math.min(demoraInicialMs, adaptador.intervaloConsultaMs));
    }
  }

  async function detener(): Promise<void> {
    detenido = true;
    for (const temporizador of temporizadores.values()) {
      clearTimeout(temporizador);
    }
    temporizadores.clear();
    await Promise.allSettled([...vueltasActivas]);
  }

  return {
    iniciar,
    detener,
    consultarProveedor,
    consultarTodos,
  };
}
