// Panel de viajes activos (viajes.yaml, GET /panel y UC-4 /reservas):
// - Muestra primero el último panel guardado en IndexedDB sin esperar a la red (QA-3).
// - Actualiza contra la red al abrir, cada 60 s y al volver a la pestaña.
// - Agrupa viajes activos con sus reservas en orden, estado visible y formatos Intl.
// - Permite alta, edición y baja manual de reservas (UC-4).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { guardarPanel, leerPanel, type PanelGuardado } from '../cache/panel.ts';
import { claveErrorHttp, useIdioma } from '../componentes.tsx';
import { useApp, useClaims } from '../contexto.tsx';
import { formatearFecha } from '../idiomas/formatos.ts';
import {
  ordenarReservas,
  ReservaFormulario,
  ReservaTarjeta,
  type Reserva,
} from './viajes-componentes.tsx';

export const INTERVALO_REFRESCO_PANEL_MS = 60_000;

type Aviso = { tipo: 'exito' | 'error'; clave: string; params?: Record<string, string> };

export function Panel() {
  const { t } = useTranslation();
  const { api } = useApp();
  const usuarioId = useClaims()?.sub;
  const idioma = useIdioma();

  const [guardado, setGuardado] = useState<PanelGuardado>();
  const [deLaRed, setDeLaRed] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [refrescando, setRefrescando] = useState(false);
  const [errorRed, setErrorRed] = useState<string>();

  const [mostrarAlta, setMostrarAlta] = useState(false);
  const [reservaEditando, setReservaEditando] = useState<Reserva>();
  const [ocupadoMutacion, setOcupadoMutacion] = useState(false);
  const [aviso, setAviso] = useState<Aviso>();

  const montadoRef = useRef(true);
  const secuenciaRef = useRef(0);

  const cargarDesdeRed = useCallback(async () => {
    if (!usuarioId) return;
    const turno = ++secuenciaRef.current;
    setRefrescando(true);
    try {
      const { data, response } = await api.viajes.GET('/panel');
      if (!montadoRef.current || turno !== secuenciaRef.current) return;
      if (!data) {
        setDeLaRed(false);
        setErrorRed(claveErrorHttp(response.status));
        return;
      }
      const ahora = new Date();
      setGuardado({ panel: data, guardadoEn: ahora.toISOString() });
      setDeLaRed(true);
      setErrorRed(undefined);
      await guardarPanel(usuarioId, data, ahora).catch(() => undefined);
    } catch {
      if (!montadoRef.current || turno !== secuenciaRef.current) return;
      setDeLaRed(false);
      setErrorRed('errores.noDisponible');
    } finally {
      if (montadoRef.current && turno === secuenciaRef.current) {
        setCargando(false);
        setRefrescando(false);
      }
    }
  }, [api, usuarioId]);

  useEffect(() => {
    montadoRef.current = true;
    if (!usuarioId) return;

    setCargando(true);
    setErrorRed(undefined);

    void leerPanel(usuarioId)
      .then((local) => {
        if (montadoRef.current && local) {
          setGuardado((actual) => actual ?? local);
          setCargando(false);
        }
      })
      .catch(() => undefined);

    void cargarDesdeRed();

    const temporizador = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void cargarDesdeRed();
      }
    }, INTERVALO_REFRESCO_PANEL_MS);

    const alCambiarVisibilidad = () => {
      if (document.visibilityState === 'visible') {
        void cargarDesdeRed();
      }
    };

    const alReconectar = () => {
      void cargarDesdeRed();
    };

    document.addEventListener('visibilitychange', alCambiarVisibilidad);
    window.addEventListener('online', alReconectar);

    return () => {
      montadoRef.current = false;
      window.clearInterval(temporizador);
      document.removeEventListener('visibilitychange', alCambiarVisibilidad);
      window.removeEventListener('online', alReconectar);
    };
  }, [cargarDesdeRed, usuarioId]);

  const viajes = guardado?.panel.viajes ?? [];

  const alCrearReserva = async (creada: Reserva) => {
    setMostrarAlta(false);
    setAviso({
      tipo: 'exito',
      clave: 'reserva.creada',
      params: { codigo: creada.numeroReserva },
    });
    await cargarDesdeRed();
  };

  const alModificarReserva = async (modificada: Reserva) => {
    setReservaEditando(undefined);
    setAviso({
      tipo: 'exito',
      clave: 'reserva.modificada',
      params: { codigo: modificada.numeroReserva },
    });
    await cargarDesdeRed();
  };

  const alEliminarReserva = async (reserva: Reserva) => {
    setOcupadoMutacion(true);
    setAviso(undefined);
    try {
      const { response } = await api.viajes.DELETE('/reservas/{reservaId}', {
        params: { path: { reservaId: reserva.reservaId } },
      });
      if (!response.ok) {
        setAviso({
          tipo: 'error',
          clave:
            response.status === 409
              ? 'reserva.errorConflictoBaja'
              : claveErrorHttp(response.status),
        });
        return;
      }
      if (reservaEditando?.reservaId === reserva.reservaId) {
        setReservaEditando(undefined);
      }
      setAviso({
        tipo: 'exito',
        clave: 'reserva.eliminada',
        params: { codigo: reserva.numeroReserva },
      });
      await cargarDesdeRed();
    } catch {
      setAviso({ tipo: 'error', clave: 'errores.noDisponible' });
    } finally {
      setOcupadoMutacion(false);
    }
  };

  const fechaGuardado =
    guardado &&
    formatearFecha(guardado.guardadoEn, idioma, { dateStyle: 'short', timeStyle: 'short' });

  return (
    <div className="pila">
      <section className="tarjeta" aria-labelledby="titulo-panel">
        <div className="cabecera-seccion">
          <div>
            <h1 id="titulo-panel">{t('panel.titulo')}</h1>
            {guardado && (
              <p className="nota" data-testid="origen-panel">
                {deLaRed
                  ? t('panel.actualizado', { fecha: fechaGuardado })
                  : t('panel.guardadoSinRed', { fecha: fechaGuardado })}
              </p>
            )}
          </div>
          <div className="acciones-fila">
            <button
              type="button"
              onClick={() => {
                setReservaEditando(undefined);
                setMostrarAlta((actual) => !actual);
              }}
            >
              {mostrarAlta ? t('panel.cerrarFormulario') : t('panel.agregarReserva')}
            </button>
            <button
              type="button"
              className="secundario"
              disabled={refrescando}
              onClick={() => void cargarDesdeRed()}
            >
              {refrescando ? t('panel.actualizando') : t('panel.actualizar')}
            </button>
          </div>
        </div>

        {aviso && (
          <p role={aviso.tipo === 'error' ? 'alert' : 'status'} className={`mensaje ${aviso.tipo}`}>
            {aviso.params ? t(aviso.clave, aviso.params) : t(aviso.clave)}
          </p>
        )}

        {!guardado && cargando && <p className="nota">{t('app.cargando')}</p>}

        {!guardado && !cargando && errorRed && (
          <div className="mensaje error" role="alert">
            <p>{t(errorRed)}</p>
            <button type="button" className="secundario" onClick={() => void cargarDesdeRed()}>
              {t('panel.reintentar')}
            </button>
          </div>
        )}

        {guardado && viajes.length === 0 && (
          <div className="estado-vacio">
            <p>{t('panel.sinViajes')}</p>
            <p className="nota">{t('panel.sinViajesAyuda')}</p>
          </div>
        )}
      </section>

      {mostrarAlta && (
        <ReservaFormulario
          modo="alta"
          viajesActivos={viajes}
          alGuardar={alCrearReserva}
          alCancelar={() => setMostrarAlta(false)}
        />
      )}

      {reservaEditando && (
        <ReservaFormulario
          key={reservaEditando.reservaId}
          modo="edicion"
          reservaInicial={reservaEditando}
          viajesActivos={viajes}
          alGuardar={alModificarReserva}
          alCancelar={() => setReservaEditando(undefined)}
        />
      )}

      {viajes.length > 0 && (
        <ul className="lista-viajes" aria-label={t('panel.titulo')}>
          {viajes.map((viaje) => {
            const reservasOrdenadas = ordenarReservas(viaje.reservas);
            return (
              <li
                key={viaje.viajeId}
                className="tarjeta viaje-tarjeta"
                data-testid={`viaje-${viaje.viajeId}`}
              >
                <div className="viaje-cabecera">
                  <div className="viaje-resumen">
                    <div className="item-cabecera">
                      <h2>{viaje.destino}</h2>
                      <span className="etiqueta">
                        {reservasOrdenadas.length === 1
                          ? t('panel.cantidadReservasUno')
                          : t('panel.cantidadReservasVarios', {
                              cantidad: reservasOrdenadas.length,
                            })}
                      </span>
                    </div>
                    <span className="nota">
                      {t('panel.fechas', {
                        inicio: formatearFecha(viaje.inicio, idioma),
                        fin: formatearFecha(viaje.fin, idioma),
                      })}
                    </span>
                  </div>
                  <Link className="enlace-boton" to={`/viajes/${viaje.viajeId}`}>
                    {t('panel.verDetalle')}
                  </Link>
                </div>

                {reservasOrdenadas.length === 0 ? (
                  <p className="nota">{t('viaje.sinReservas')}</p>
                ) : (
                  <ul className="lista-tarjetas reservas-en-viaje">
                    {reservasOrdenadas.map((reserva) => (
                      <ReservaTarjeta
                        key={reserva.reservaId}
                        reserva={reserva}
                        editable
                        ocupado={ocupadoMutacion}
                        alEditar={(item) => {
                          setMostrarAlta(false);
                          setReservaEditando(item);
                        }}
                        alEliminar={alEliminarReserva}
                      />
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
