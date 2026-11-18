// Piezas que usan varias pantallas: selector de idioma, aviso sin conexión y "en construcción".
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { Idioma } from './api/sesion.ts';
import { useApp } from './contexto.tsx';
import { formatearFecha, formatearMoneda } from './idiomas/formatos.ts';
import { cambiarIdioma, esIdioma, IDIOMAS } from './idiomas/i18n.ts';

const NOMBRES_IDIOMA: Record<Idioma, string> = { es: 'Español', en: 'English' };

export function useIdioma(): Idioma {
  const { i18n } = useTranslation();
  return esIdioma(i18n.language) ? i18n.language : 'es';
}

export function SelectorIdioma() {
  const { t } = useTranslation();
  const { almacen } = useApp();
  const idioma = useIdioma();
  return (
    <label className="selector-idioma">
      <span>{t('app.idioma')}</span>
      <select
        value={idioma}
        onChange={(e) => {
          if (esIdioma(e.target.value)) cambiarIdioma(e.target.value, almacen);
        }}
      >
        {IDIOMAS.map((opcion) => (
          <option key={opcion} value={opcion} lang={opcion}>
            {NOMBRES_IDIOMA[opcion]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function useEnLinea(): boolean {
  const [enLinea, setEnLinea] = useState(() => navigator.onLine);
  useEffect(() => {
    const actualizar = () => setEnLinea(navigator.onLine);
    window.addEventListener('online', actualizar);
    window.addEventListener('offline', actualizar);
    return () => {
      window.removeEventListener('online', actualizar);
      window.removeEventListener('offline', actualizar);
    };
  }, []);
  return enLinea;
}

/** Pantalla que todavía no existe: la completa el dueño del servicio. */
export function EnConstruccion({ titulo }: { titulo: string }) {
  const { t } = useTranslation();
  const idioma = useIdioma();
  return (
    <section className="tarjeta">
      <h1>{titulo}</h1>
      <p>{t('construccion.texto')}</p>
      <p className="ejemplo-formato" data-testid="ejemplo-formato">
        {t('construccion.hoy', {
          fecha: formatearFecha(new Date(), idioma, { dateStyle: 'long' }),
          precio: formatearMoneda(1234.5, idioma),
        })}
      </p>
    </section>
  );
}

export function SinPermiso() {
  const { t } = useTranslation();
  return (
    <section className="tarjeta" role="alert">
      <h1>{t('errores.sinPermiso')}</h1>
      <Link to="/">{t('errores.volver')}</Link>
    </section>
  );
}
