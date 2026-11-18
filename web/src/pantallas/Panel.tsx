// Panel (viajes.yaml, GET /panel). Muestra primero el último panel guardado en el dispositivo, sin
// esperar a la red (QA-3), y después lo actualiza. El dueño de Viajes completa la pantalla.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { guardarPanel, leerPanel, type PanelGuardado } from '../cache/panel.ts';
import { EnConstruccion, useIdioma } from '../componentes.tsx';
import { useApp, useClaims } from '../contexto.tsx';
import { formatearFecha } from '../idiomas/formatos.ts';

export function Panel() {
  const { t } = useTranslation();
  const { api } = useApp();
  const usuarioId = useClaims()?.sub;
  const idioma = useIdioma();
  const [guardado, setGuardado] = useState<PanelGuardado>();
  const [deLaRed, setDeLaRed] = useState(false);

  useEffect(() => {
    if (!usuarioId) return;
    let vigente = true;
    void leerPanel(usuarioId)
      .then((local) => {
        if (vigente && local) setGuardado((actual) => actual ?? local);
      })
      .catch(() => undefined);
    void api.viajes
      .GET('/panel')
      .then(async ({ data }) => {
        if (!data || !vigente) return;
        const ahora = new Date();
        setGuardado({ panel: data, guardadoEn: ahora.toISOString() });
        setDeLaRed(true);
        await guardarPanel(usuarioId, data, ahora);
      })
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, [api, usuarioId]);

  const fechaGuardado =
    guardado &&
    formatearFecha(guardado.guardadoEn, idioma, { dateStyle: 'short', timeStyle: 'short' });

  return (
    <>
      {guardado && (
        <section className="tarjeta" aria-labelledby="titulo-panel">
          <h1 id="titulo-panel">{t('panel.titulo')}</h1>
          <p className="nota" data-testid="origen-panel">
            {deLaRed
              ? t('panel.actualizado', { fecha: fechaGuardado })
              : t('panel.guardadoSinRed', { fecha: fechaGuardado })}
          </p>
          {guardado.panel.viajes.length === 0 ? (
            <p>{t('panel.sinViajes')}</p>
          ) : (
            <ul className="viajes">
              {guardado.panel.viajes.map((viaje) => (
                <li key={viaje.viajeId}>
                  <div className="viaje-resumen">
                    <strong>{viaje.destino}</strong>
                    <span>
                      {t('panel.fechas', {
                        inicio: formatearFecha(viaje.inicio, idioma),
                        fin: formatearFecha(viaje.fin, idioma),
                      })}
                    </span>
                  </div>
                  <Link className="enlace-boton" to={`/viajes/${viaje.viajeId}`}>
                    {t('panel.verDetalle')}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {!guardado && <EnConstruccion titulo={t('panel.titulo')} />}
    </>
  );
}
