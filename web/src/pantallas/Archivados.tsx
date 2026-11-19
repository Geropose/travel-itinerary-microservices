// Pantalla de viajes archivados (UC-5, viajes.yaml GET /archivados). Los viajes terminados se
// archivan automáticamente y se muestran en modo solo lectura del más reciente al más antiguo.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { claveErrorHttp, useIdioma } from '../componentes.tsx';
import { useApp } from '../contexto.tsx';
import { formatearFecha } from '../idiomas/formatos.ts';
import { ordenarReservas, ReservaTarjeta, type Viaje } from './viajes-componentes.tsx';

export function Archivados() {
  const { t } = useTranslation();
  const { api } = useApp();
  const idioma = useIdioma();

  const [viajes, setViajes] = useState<Viaje[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string>();
  const montadoRef = useRef(true);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(undefined);
    try {
      const { data, response } = await api.viajes.GET('/archivados');
      if (!montadoRef.current) return;
      if (!data) {
        setError(claveErrorHttp(response.status));
        return;
      }
      setViajes(data.viajes);
    } catch {
      if (montadoRef.current) setError('errores.noDisponible');
    } finally {
      if (montadoRef.current) setCargando(false);
    }
  }, [api]);

  useEffect(() => {
    montadoRef.current = true;
    void cargar();
    return () => {
      montadoRef.current = false;
    };
  }, [cargar]);

  return (
    <div className="pila">
      <section className="tarjeta" aria-labelledby="titulo-archivados">
        <h1 id="titulo-archivados">{t('archivados.titulo')}</h1>
        <p className="nota">{t('archivados.descripcion')}</p>

        {cargando && <p className="nota">{t('app.cargando')}</p>}

        {!cargando && error && (
          <div className="mensaje error" role="alert">
            <p>{t(error)}</p>
            <button type="button" className="secundario" onClick={() => void cargar()}>
              {t('archivados.reintentar')}
            </button>
          </div>
        )}

        {!cargando && !error && viajes.length === 0 && (
          <div className="estado-vacio">
            <p>{t('archivados.vacio')}</p>
            <p className="nota">{t('archivados.vacioAyuda')}</p>
          </div>
        )}
      </section>

      {!cargando && !error && viajes.length > 0 && (
        <ul className="lista-viajes" aria-label={t('archivados.titulo')}>
          {viajes.map((viaje) => {
            const reservasOrdenadas = ordenarReservas(viaje.reservas);
            return (
              <li
                key={viaje.viajeId}
                className="tarjeta viaje-tarjeta"
                data-testid={`viaje-archivado-${viaje.viajeId}`}
              >
                <div className="viaje-cabecera">
                  <div className="viaje-resumen">
                    <div className="item-cabecera">
                      <h2>{viaje.destino}</h2>
                      <span className="etiqueta">{t('viaje.estados.archivado')}</span>
                    </div>
                    <span className="nota">
                      {t('panel.fechas', {
                        inicio: formatearFecha(viaje.inicio, idioma),
                        fin: formatearFecha(viaje.fin, idioma),
                      })}
                    </span>
                  </div>
                  <Link className="enlace-boton" to={`/viajes/${viaje.viajeId}`}>
                    {t('archivados.verDetalle')}
                  </Link>
                </div>

                {reservasOrdenadas.length === 0 ? (
                  <p className="nota">{t('viaje.sinReservas')}</p>
                ) : (
                  <ul className="lista-tarjetas reservas-en-viaje">
                    {reservasOrdenadas.map((reserva) => (
                      <ReservaTarjeta key={reserva.reservaId} reserva={reserva} editable={false} />
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
