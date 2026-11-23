// Consola del equipo de datos en /analitica (rol analista, analitica.yaml, Iteración 6, UC-7,
// QA-5): permite elegir consulta (destinos, cancelaciones o tendencias), lanzar ejecuciones
// pesadas asíncronas con Map-Reduce (202 + seguimiento de estado/progreso/procesadores/duración)
// o consultas directas rápidas, y visualizar resultados con formatos Intl.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { components } from '../api/generado/analitica.ts';
import { claveErrorHttp, useIdioma } from '../componentes.tsx';
import { useApp } from '../contexto.tsx';
import {
  formatearDuracion,
  formatearFecha,
  formatearFechaSolo,
  formatearMes,
  formatearNumero,
  formatearPorcentaje,
} from '../idiomas/formatos.ts';

type TipoConsulta = components['schemas']['TipoConsulta'];
type AgrupacionCancelaciones = components['schemas']['AgrupacionCancelaciones'];
type Ejecucion = components['schemas']['Ejecucion'];
type ParametrosConsulta = components['schemas']['ParametrosConsulta'];
type ResultadoDestinos = components['schemas']['ResultadoDestinos'];
type ResultadoCancelaciones = components['schemas']['ResultadoCancelaciones'];
type ResultadoTendencias = components['schemas']['ResultadoTendencias'];
type Problema = components['schemas']['Problema'];

const TIPOS_CONSULTA: readonly TipoConsulta[] = ['destinos', 'cancelaciones', 'tendencias'];
const AGRUPACIONES_CANCELACIONES: readonly AgrupacionCancelaciones[] = ['proveedor', 'destino'];
export const INTERVALO_SONDEO_ANALITICA_MS = 400;

type ResultadoMostrado =
  | { tipo: 'destinos'; modo: 'mapreduce' | 'rapido'; datos: ResultadoDestinos }
  | { tipo: 'cancelaciones'; modo: 'mapreduce' | 'rapido'; datos: ResultadoCancelaciones }
  | { tipo: 'tendencias'; modo: 'mapreduce' | 'rapido'; datos: ResultadoTendencias };

function extraerUuid(texto: string | undefined): string | undefined {
  if (!texto) return undefined;
  const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(texto);
  return match?.[0];
}

function esResultadoDestinos(resultado: Ejecucion['resultado']): resultado is ResultadoDestinos {
  return Boolean(resultado && 'destinos' in resultado);
}

function esResultadoCancelaciones(
  resultado: Ejecucion['resultado'],
): resultado is ResultadoCancelaciones {
  return Boolean(resultado && 'grupos' in resultado);
}

function esResultadoTendencias(
  resultado: Ejecucion['resultado'],
): resultado is ResultadoTendencias {
  return Boolean(resultado && 'periodos' in resultado);
}

function aResultadoMostrado(ejecucion: Ejecucion): ResultadoMostrado | undefined {
  const { resultado } = ejecucion;
  if (!resultado) return undefined;
  if (ejecucion.tipo === 'destinos' && esResultadoDestinos(resultado)) {
    return { tipo: 'destinos', modo: 'mapreduce', datos: resultado };
  }
  if (ejecucion.tipo === 'cancelaciones' && esResultadoCancelaciones(resultado)) {
    return { tipo: 'cancelaciones', modo: 'mapreduce', datos: resultado };
  }
  if (ejecucion.tipo === 'tendencias' && esResultadoTendencias(resultado)) {
    return { tipo: 'tendencias', modo: 'mapreduce', datos: resultado };
  }
  return undefined;
}

export function Analitica() {
  const { t } = useTranslation();
  const { api } = useApp();
  const idioma = useIdioma();

  const [tipo, setTipo] = useState<TipoConsulta>('destinos');
  const [desde, setDesde] = useState('2025-01-01');
  const [hasta, setHasta] = useState('2025-12-31');
  const [limite, setLimite] = useState('10');
  const [agruparPor, setAgruparPor] = useState<AgrupacionCancelaciones>('proveedor');
  const [anio, setAnio] = useState('2025');
  const [procesadores, setProcesadores] = useState('');

  const [enviando, setEnviando] = useState(false);
  const [consultandoRapido, setConsultandoRapido] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: 'error' | 'exito'; clave: string }>();

  const [ejecucionActiva, setEjecucionActiva] = useState<Ejecucion>();
  const [historial, setHistorial] = useState<Ejecucion[]>([]);
  const [resultadoDirecto, setResultadoDirecto] = useState<ResultadoMostrado>();

  const sondeoRef = useRef<number | undefined>(undefined);
  const sondeoSecuenciaRef = useRef(0);
  const montadoRef = useRef(true);

  const detenerSondeo = useCallback(() => {
    sondeoSecuenciaRef.current += 1;
    if (sondeoRef.current !== undefined) {
      window.clearTimeout(sondeoRef.current);
      sondeoRef.current = undefined;
    }
  }, []);

  const actualizarHistorial = useCallback((ejecucion: Ejecucion) => {
    setHistorial((prev) => {
      const sinDuplicado = prev.filter((item) => item.consultaId !== ejecucion.consultaId);
      return [ejecucion, ...sinDuplicado].slice(0, 8);
    });
  }, []);

  const consultarEstadoEjecucion = useCallback(
    async (consultaId: string) => {
      detenerSondeo();
      const secuencia = sondeoSecuenciaRef.current;
      const sigueVigente = () => montadoRef.current && secuencia === sondeoSecuenciaRef.current;
      try {
        const { data, response } = await api.analitica.GET('/consultas/ejecuciones/{consultaId}', {
          params: { path: { consultaId } },
        });
        if (!sigueVigente()) return;
        if (!data) {
          setAviso({ tipo: 'error', clave: claveErrorHttp(response.status) });
          return;
        }
        setEjecucionActiva(data);
        actualizarHistorial(data);

        if (data.estado === 'pendiente' || data.estado === 'enCurso') {
          sondeoRef.current = window.setTimeout(() => {
            if (!sigueVigente()) return;
            void consultarEstadoEjecucion(consultaId);
          }, INTERVALO_SONDEO_ANALITICA_MS);
        }
      } catch {
        if (sigueVigente()) {
          setAviso({ tipo: 'error', clave: 'errores.noDisponible' });
        }
      }
    },
    [actualizarHistorial, api, detenerSondeo],
  );

  useEffect(() => {
    montadoRef.current = true;
    return () => {
      montadoRef.current = false;
      detenerSondeo();
    };
  }, [detenerSondeo]);

  const validarParametros = (
    incluirProcesadores: boolean,
  ):
    | { ok: false; claveError: string }
    | {
        ok: true;
        limiteNum: number;
        anioNum: number;
        procesadoresNum?: number;
      } => {
    if (tipo !== 'tendencias') {
      if (!desde || !hasta || hasta < desde) {
        return { ok: false, claveError: 'analitica.errorRangoFechas' };
      }
    }

    const limiteNum = Number.parseInt(limite, 10);
    if (tipo === 'destinos' && (!Number.isInteger(limiteNum) || limiteNum < 1 || limiteNum > 100)) {
      return { ok: false, claveError: 'analitica.errorLimite' };
    }

    const anioNum = Number.parseInt(anio, 10);
    if (tipo === 'tendencias' && (!Number.isInteger(anioNum) || anioNum < 2000 || anioNum > 2100)) {
      return { ok: false, claveError: 'analitica.errorAnio' };
    }

    let procesadoresNum: number | undefined;
    if (incluirProcesadores && procesadores.trim().length > 0) {
      const parsed = Number.parseInt(procesadores.trim(), 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
        return { ok: false, claveError: 'analitica.errorProcesadores' };
      }
      procesadoresNum = parsed;
    }

    return {
      ok: true,
      limiteNum,
      anioNum,
      ...(procesadoresNum !== undefined ? { procesadoresNum } : {}),
    };
  };

  const lanzarMapReduce = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setAviso(undefined);

    const validacion = validarParametros(true);
    if (!validacion.ok) {
      setAviso({ tipo: 'error', clave: validacion.claveError });
      return;
    }

    const cuerpo: ParametrosConsulta =
      tipo === 'destinos'
        ? {
            desde,
            hasta,
            limite: validacion.limiteNum,
            ...(validacion.procesadoresNum !== undefined
              ? { procesadores: validacion.procesadoresNum }
              : {}),
          }
        : tipo === 'cancelaciones'
          ? {
              desde,
              hasta,
              agruparPor,
              ...(validacion.procesadoresNum !== undefined
                ? { procesadores: validacion.procesadoresNum }
                : {}),
            }
          : {
              anio: validacion.anioNum,
              agruparPor: 'mes',
              ...(validacion.procesadoresNum !== undefined
                ? { procesadores: validacion.procesadoresNum }
                : {}),
            };

    detenerSondeo();
    setResultadoDirecto(undefined);
    setEnviando(true);
    try {
      const { data, error, response } = await api.analitica.POST('/consultas/{tipo}/ejecutar', {
        params: { path: { tipo } },
        body: cuerpo,
      });

      if (response.status === 409) {
        const problema = error as Problema | undefined;
        const idExistente = extraerUuid(problema?.detail);
        setAviso({ tipo: 'error', clave: 'analitica.errorConflicto' });
        if (idExistente) {
          await consultarEstadoEjecucion(idExistente);
        }
        return;
      }

      if (!data) {
        setAviso({ tipo: 'error', clave: claveErrorHttp(response.status) });
        return;
      }

      const inicial: Ejecucion = {
        consultaId: data.consultaId,
        tipo: data.tipo,
        parametros: cuerpo,
        estado: data.estado,
        procesadores: 0,
        progreso: 0,
        creadaEn: data.creadaEn,
      };
      setEjecucionActiva(inicial);
      actualizarHistorial(inicial);
      await consultarEstadoEjecucion(data.consultaId);
    } catch {
      setAviso({ tipo: 'error', clave: 'errores.noDisponible' });
    } finally {
      if (montadoRef.current) setEnviando(false);
    }
  };

  const ejecutarConsultaRapida = async () => {
    setAviso(undefined);
    const validacion = validarParametros(false);
    if (!validacion.ok) {
      setAviso({ tipo: 'error', clave: validacion.claveError });
      return;
    }

    detenerSondeo();
    setConsultandoRapido(true);
    try {
      if (tipo === 'destinos') {
        const { data, response } = await api.analitica.GET('/consultas/destinos', {
          params: { query: { desde, hasta, limite: validacion.limiteNum } },
        });
        if (!data) {
          setAviso({ tipo: 'error', clave: claveErrorHttp(response.status) });
          return;
        }
        setEjecucionActiva(undefined);
        setResultadoDirecto({ tipo: 'destinos', modo: 'rapido', datos: data });
      } else if (tipo === 'cancelaciones') {
        const { data, response } = await api.analitica.GET('/consultas/cancelaciones', {
          params: { query: { desde, hasta, agruparPor } },
        });
        if (!data) {
          setAviso({ tipo: 'error', clave: claveErrorHttp(response.status) });
          return;
        }
        setEjecucionActiva(undefined);
        setResultadoDirecto({ tipo: 'cancelaciones', modo: 'rapido', datos: data });
      } else {
        const { data, response } = await api.analitica.GET('/consultas/tendencias', {
          params: { query: { anio: validacion.anioNum, agruparPor: 'mes' } },
        });
        if (!data) {
          setAviso({ tipo: 'error', clave: claveErrorHttp(response.status) });
          return;
        }
        setEjecucionActiva(undefined);
        setResultadoDirecto({ tipo: 'tendencias', modo: 'rapido', datos: data });
      }
    } catch {
      setAviso({ tipo: 'error', clave: 'errores.noDisponible' });
    } finally {
      if (montadoRef.current) setConsultandoRapido(false);
    }
  };

  const resultadoMostrado =
    resultadoDirecto ?? (ejecucionActiva ? aResultadoMostrado(ejecucionActiva) : undefined);

  const ocupado = enviando || consultandoRapido;

  return (
    <div className="pila">
      <section className="tarjeta" aria-labelledby="titulo-analitica">
        <h1 id="titulo-analitica">{t('analitica.titulo')}</h1>
        <p className="nota">{t('analitica.descripcion')}</p>

        <form className="formulario" onSubmit={(e) => void lanzarMapReduce(e)}>
          <label>
            <span>{t('analitica.tipoLabel')}</span>
            <select
              name="tipo"
              value={tipo}
              disabled={ocupado}
              onChange={(e) => {
                setTipo(e.target.value as TipoConsulta);
                setAviso(undefined);
              }}
            >
              {TIPOS_CONSULTA.map((opcion) => (
                <option key={opcion} value={opcion}>
                  {t(`analitica.tipos.${opcion}`)}
                </option>
              ))}
            </select>
          </label>

          {tipo !== 'tendencias' ? (
            <div className="formulario-grid">
              <label>
                <span>{t('analitica.desde')}</span>
                <input
                  name="desde"
                  type="date"
                  required
                  value={desde}
                  disabled={ocupado}
                  onChange={(e) => setDesde(e.target.value)}
                />
              </label>

              <label>
                <span>{t('analitica.hasta')}</span>
                <input
                  name="hasta"
                  type="date"
                  required
                  value={hasta}
                  disabled={ocupado}
                  onChange={(e) => setHasta(e.target.value)}
                />
              </label>
            </div>
          ) : (
            <div className="formulario-grid">
              <label>
                <span>{t('analitica.anio')}</span>
                <input
                  name="anio"
                  type="number"
                  min={2000}
                  max={2100}
                  required
                  value={anio}
                  disabled={ocupado}
                  onChange={(e) => setAnio(e.target.value)}
                />
              </label>

              <label>
                <span>{t('analitica.agruparPor')}</span>
                <input type="text" value={t('analitica.agrupaciones.mes')} disabled />
              </label>
            </div>
          )}

          <div className="formulario-grid">
            {tipo === 'destinos' && (
              <label>
                <span>{t('analitica.limite')}</span>
                <input
                  name="limite"
                  type="number"
                  min={1}
                  max={100}
                  required
                  value={limite}
                  disabled={ocupado}
                  onChange={(e) => setLimite(e.target.value)}
                />
              </label>
            )}

            {tipo === 'cancelaciones' && (
              <label>
                <span>{t('analitica.agruparPor')}</span>
                <select
                  name="agruparPor"
                  value={agruparPor}
                  disabled={ocupado}
                  onChange={(e) => setAgruparPor(e.target.value as AgrupacionCancelaciones)}
                >
                  {AGRUPACIONES_CANCELACIONES.map((opcion) => (
                    <option key={opcion} value={opcion}>
                      {t(`analitica.agrupaciones.${opcion}`)}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label>
              <span>{t('analitica.procesadores')}</span>
              <input
                name="procesadores"
                type="number"
                min={1}
                max={50}
                value={procesadores}
                placeholder={t('analitica.procesadoresPlaceholder')}
                disabled={ocupado}
                aria-describedby="ayuda-procesadores"
                onChange={(e) => setProcesadores(e.target.value)}
              />
              <small id="ayuda-procesadores">{t('analitica.procesadoresAyuda')}</small>
            </label>
          </div>

          {aviso && (
            <p
              role={aviso.tipo === 'error' ? 'alert' : 'status'}
              className={`mensaje ${aviso.tipo}`}
            >
              {t(aviso.clave)}
            </p>
          )}

          <div className="acciones-fila">
            <button type="submit" disabled={ocupado}>
              {enviando ? t('analitica.ejecutando') : t('analitica.ejecutarMapReduce')}
            </button>
            <button
              type="button"
              className="secundario"
              disabled={ocupado}
              onClick={() => void ejecutarConsultaRapida()}
            >
              {consultandoRapido ? t('analitica.consultando') : t('analitica.consultaRapida')}
            </button>
          </div>
        </form>
      </section>

      {ejecucionActiva && (
        <section
          className="tarjeta"
          aria-labelledby="titulo-estado-ejecucion"
          data-testid="estado-ejecucion"
        >
          <div className="item-cabecera">
            <h2 id="titulo-estado-ejecucion">{t('analitica.estadoTitulo')}</h2>
            <span
              className={`estado estado-${ejecucionActiva.estado}`}
              data-testid="badge-estado-ejecucion"
            >
              {t(`analitica.estados.${ejecucionActiva.estado}`)}
            </span>
          </div>

          <div className="metricas-grid">
            <div className="metrica">
              <small>{t('analitica.tipoLabel')}</small>
              <strong>{t(`analitica.tipos.${ejecucionActiva.tipo}`)}</strong>
            </div>
            <div className="metrica">
              <small>{t('analitica.procesadoresUsados')}</small>
              <strong data-testid="procesadores-ejecucion">
                {formatearNumero(ejecucionActiva.procesadores, idioma)}
              </strong>
            </div>
            <div className="metrica">
              <small>{t('analitica.progreso')}</small>
              <strong>{formatearPorcentaje(ejecucionActiva.progreso, idioma)}</strong>
            </div>
            {ejecucionActiva.duracionMs !== undefined && (
              <div className="metrica">
                <small>{t('analitica.duracion')}</small>
                <strong data-testid="duracion-ejecucion">
                  {formatearDuracion(ejecucionActiva.duracionMs, idioma)}
                </strong>
              </div>
            )}
          </div>

          <progress
            className="progreso-analitica"
            value={ejecucionActiva.progreso}
            max={1}
            aria-label={t('analitica.progreso')}
          />

          <p className="nota">
            {t('analitica.consultaId')}: <code>{ejecucionActiva.consultaId}</code> ·{' '}
            {t('analitica.creadaEn', {
              fecha: formatearFecha(ejecucionActiva.creadaEn, idioma, {
                dateStyle: 'short',
                timeStyle: 'short',
              }),
            })}
            {ejecucionActiva.terminadaEn && (
              <>
                {' · '}
                {t('analitica.terminadaEn', {
                  fecha: formatearFecha(ejecucionActiva.terminadaEn, idioma, {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  }),
                })}
              </>
            )}
          </p>

          {ejecucionActiva.estado === 'fallida' && ejecucionActiva.error && (
            <p role="alert" className="mensaje error">
              {t('analitica.errorEjecucion', { detalle: ejecucionActiva.error })}
            </p>
          )}
        </section>
      )}

      {resultadoMostrado && (
        <section
          className="tarjeta"
          aria-labelledby="titulo-resultado-analitica"
          data-testid="resultado-analitica"
        >
          <div className="item-cabecera">
            <h2 id="titulo-resultado-analitica">
              {t('analitica.resultadosTitulo')}: {t(`analitica.tipos.${resultadoMostrado.tipo}`)}
            </h2>
            <span className="etiqueta">
              {resultadoMostrado.modo === 'mapreduce'
                ? t('analitica.modoMapReduce')
                : t('analitica.modoRapido')}
            </span>
          </div>

          {resultadoMostrado.tipo === 'destinos' && (
            <VistaDestinos resultado={resultadoMostrado.datos} idioma={idioma} />
          )}
          {resultadoMostrado.tipo === 'cancelaciones' && (
            <VistaCancelaciones resultado={resultadoMostrado.datos} idioma={idioma} />
          )}
          {resultadoMostrado.tipo === 'tendencias' && (
            <VistaTendencias resultado={resultadoMostrado.datos} idioma={idioma} />
          )}
        </section>
      )}

      {historial.length > 1 && (
        <section className="tarjeta" aria-labelledby="titulo-historial">
          <h2 id="titulo-historial">{t('analitica.historialTitulo')}</h2>
          <ul className="lista-tarjetas">
            {historial.map((item) => (
              <li key={item.consultaId} className="item-fila">
                <div className="item-datos">
                  <div className="item-cabecera">
                    <strong>{t(`analitica.tipos.${item.tipo}`)}</strong>
                    <span className={`estado estado-${item.estado}`}>
                      {t(`analitica.estados.${item.estado}`)}
                    </span>
                  </div>
                  <small>
                    {t('analitica.procesadoresUsados')}:{' '}
                    {formatearNumero(item.procesadores, idioma)}
                    {item.duracionMs !== undefined
                      ? ` · ${formatearDuracion(item.duracionMs, idioma)}`
                      : ''}
                  </small>
                </div>
                <button
                  type="button"
                  className="secundario"
                  onClick={() => {
                    detenerSondeo();
                    setResultadoDirecto(undefined);
                    setEjecucionActiva(item);
                    if (item.estado === 'pendiente' || item.estado === 'enCurso') {
                      void consultarEstadoEjecucion(item.consultaId);
                    }
                  }}
                >
                  {t('analitica.verEjecucion')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function VistaDestinos({
  resultado,
  idioma,
}: {
  resultado: ResultadoDestinos;
  idioma: 'es' | 'en';
}) {
  const { t } = useTranslation();
  return (
    <div className="pila">
      <p className="nota">
        {t('analitica.periodo', {
          desde: formatearFechaSolo(resultado.desde, idioma),
          hasta: formatearFechaSolo(resultado.hasta, idioma),
        })}{' '}
        ·{' '}
        {t('analitica.generadoEn', {
          fecha: formatearFecha(resultado.generadoEn, idioma, {
            dateStyle: 'short',
            timeStyle: 'short',
          }),
        })}
      </p>

      <div className="metricas-grid">
        <div className="metrica">
          <small>{t('analitica.totalReservas')}</small>
          <strong>{formatearNumero(resultado.totalReservas, idioma)}</strong>
        </div>
      </div>

      {resultado.destinos.length === 0 ? (
        <p className="nota">{t('analitica.sinDatos')}</p>
      ) : (
        <div className="tabla-contenedor">
          <table className="tabla-datos">
            <thead>
              <tr>
                <th>{t('analitica.tablas.destino')}</th>
                <th className="num">{t('analitica.tablas.reservas')}</th>
                <th className="num">{t('analitica.tablas.proporcion')}</th>
              </tr>
            </thead>
            <tbody>
              {resultado.destinos.map((fila) => (
                <tr key={fila.destino}>
                  <td>
                    <strong>{fila.destino}</strong>
                    <div className="barra-proporcion" aria-hidden="true">
                      <div
                        className="barra-relleno"
                        style={{ width: `${Math.min(100, Math.round(fila.proporcion * 100))}%` }}
                      />
                    </div>
                  </td>
                  <td className="num">{formatearNumero(fila.reservas, idioma)}</td>
                  <td className="num">{formatearPorcentaje(fila.proporcion, idioma)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function VistaCancelaciones({
  resultado,
  idioma,
}: {
  resultado: ResultadoCancelaciones;
  idioma: 'es' | 'en';
}) {
  const { t } = useTranslation();
  const columnaClave =
    resultado.agruparPor === 'proveedor'
      ? t('analitica.tablas.proveedor')
      : t('analitica.tablas.destino');

  return (
    <div className="pila">
      <p className="nota">
        {t('analitica.periodo', {
          desde: formatearFechaSolo(resultado.desde, idioma),
          hasta: formatearFechaSolo(resultado.hasta, idioma),
        })}{' '}
        ·{' '}
        {t('analitica.generadoEn', {
          fecha: formatearFecha(resultado.generadoEn, idioma, {
            dateStyle: 'short',
            timeStyle: 'short',
          }),
        })}
      </p>

      <div className="metricas-grid">
        <div className="metrica">
          <small>{t('analitica.totalReservas')}</small>
          <strong>{formatearNumero(resultado.total.reservas, idioma)}</strong>
        </div>
        <div className="metrica">
          <small>{t('analitica.totalCanceladas')}</small>
          <strong>{formatearNumero(resultado.total.canceladas, idioma)}</strong>
        </div>
        <div className="metrica">
          <small>{t('analitica.tasaGlobal')}</small>
          <strong>{formatearPorcentaje(resultado.total.tasaCancelacion, idioma)}</strong>
        </div>
      </div>

      {resultado.grupos.length === 0 ? (
        <p className="nota">{t('analitica.sinDatos')}</p>
      ) : (
        <div className="tabla-contenedor">
          <table className="tabla-datos">
            <thead>
              <tr>
                <th>{columnaClave}</th>
                <th className="num">{t('analitica.tablas.reservas')}</th>
                <th className="num">{t('analitica.tablas.canceladas')}</th>
                <th className="num">{t('analitica.tablas.tasa')}</th>
              </tr>
            </thead>
            <tbody>
              {resultado.grupos.map((grupo) => (
                <tr key={grupo.clave}>
                  <td>
                    <strong>{grupo.clave}</strong>
                    <div className="barra-proporcion" aria-hidden="true">
                      <div
                        className="barra-relleno barra-relleno-alerta"
                        style={{
                          width: `${Math.min(100, Math.round(grupo.tasaCancelacion * 100))}%`,
                        }}
                      />
                    </div>
                  </td>
                  <td className="num">{formatearNumero(grupo.reservas, idioma)}</td>
                  <td className="num">{formatearNumero(grupo.canceladas, idioma)}</td>
                  <td className="num">{formatearPorcentaje(grupo.tasaCancelacion, idioma)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function VistaTendencias({
  resultado,
  idioma,
}: {
  resultado: ResultadoTendencias;
  idioma: 'es' | 'en';
}) {
  const { t } = useTranslation();
  const totalReservas = resultado.periodos.reduce((acc, p) => acc + p.reservas, 0);
  const totalCanceladas = resultado.periodos.reduce((acc, p) => acc + p.canceladas, 0);
  const maximoMes = Math.max(1, ...resultado.periodos.map((p) => p.reservas));

  return (
    <div className="pila">
      <p className="nota">
        {t('analitica.anio')}: {resultado.anio} ·{' '}
        {t('analitica.generadoEn', {
          fecha: formatearFecha(resultado.generadoEn, idioma, {
            dateStyle: 'short',
            timeStyle: 'short',
          }),
        })}
      </p>

      <div className="metricas-grid">
        <div className="metrica">
          <small>{t('analitica.totalReservas')}</small>
          <strong>{formatearNumero(totalReservas, idioma)}</strong>
        </div>
        <div className="metrica">
          <small>{t('analitica.totalCanceladas')}</small>
          <strong>{formatearNumero(totalCanceladas, idioma)}</strong>
        </div>
      </div>

      <div className="tabla-contenedor">
        <table className="tabla-datos">
          <thead>
            <tr>
              <th>{t('analitica.tablas.mes')}</th>
              <th className="num">{t('analitica.tablas.total')}</th>
              <th className="num">{t('analitica.tablas.vuelo')}</th>
              <th className="num">{t('analitica.tablas.hotel')}</th>
              <th className="num">{t('analitica.tablas.auto')}</th>
              <th className="num">{t('analitica.tablas.canceladas')}</th>
            </tr>
          </thead>
          <tbody>
            {resultado.periodos.map((periodo) => (
              <tr key={periodo.mes}>
                <td>
                  <strong className="mes-nombre">
                    {formatearMes(resultado.anio, periodo.mes, idioma)}
                  </strong>
                  <div className="barra-proporcion" aria-hidden="true">
                    <div
                      className="barra-relleno"
                      style={{
                        width: `${Math.round((periodo.reservas / maximoMes) * 100)}%`,
                      }}
                    />
                  </div>
                </td>
                <td className="num">{formatearNumero(periodo.reservas, idioma)}</td>
                <td className="num">{formatearNumero(periodo.porTipoReserva.vuelo, idioma)}</td>
                <td className="num">{formatearNumero(periodo.porTipoReserva.hotel, idioma)}</td>
                <td className="num">{formatearNumero(periodo.porTipoReserva.auto, idioma)}</td>
                <td className="num">{formatearNumero(periodo.canceladas, idioma)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
