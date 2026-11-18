// Pantalla de Preferencias del usuario (specs/openapi/usuarios.yaml, GET/PATCH /perfil):
// idioma (cambia la interfaz al instante), moneda y agencia preferida.
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { components } from '../api/generado/usuarios.ts';
import { claveErrorHttp, useIdioma } from '../componentes.tsx';
import { useApp } from '../contexto.tsx';
import { formatearMoneda } from '../idiomas/formatos.ts';
import { cambiarIdioma, esIdioma, IDIOMAS } from '../idiomas/i18n.ts';

type Perfil = components['schemas']['Perfil'];

const MONEDAS_BASE = ['ARS', 'USD', 'EUR', 'BRL', 'CLP', 'UYU', 'MXN'] as const;
const NOMBRES_IDIOMA: Record<'es' | 'en', string> = { es: 'Español', en: 'English' };

function agenciasDisponibles(extra?: string | null): string[] {
  const crudo =
    (import.meta.env.VITE_AGENCIAS_CONFIGURADAS as string | undefined) ?? 'viajes-del-plata';
  const lista = crudo
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  if (extra && !lista.includes(extra)) lista.push(extra);
  return lista;
}

type Aviso = { tipo: 'exito' | 'error'; clave: string };

export function Preferencias() {
  const { t } = useTranslation();
  const { api, almacen } = useApp();
  const idioma = useIdioma();

  const [perfil, setPerfil] = useState<Perfil>();
  const [moneda, setMoneda] = useState('ARS');
  const [agencia, setAgencia] = useState('');
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<Aviso>();

  useEffect(() => {
    let vigente = true;
    void api.usuarios
      .GET('/perfil')
      .then(({ data, response }) => {
        if (!vigente) return;
        if (!data) {
          setAviso({ tipo: 'error', clave: claveErrorHttp(response.status) });
          return;
        }
        setPerfil(data);
        setMoneda(data.moneda);
        setAgencia(data.agenciaPreferida ?? '');
      })
      .catch(() => {
        if (vigente) setAviso({ tipo: 'error', clave: 'errores.noDisponible' });
      })
      .finally(() => {
        if (vigente) setCargando(false);
      });
    return () => {
      vigente = false;
    };
  }, [api]);

  const monedas = MONEDAS_BASE.includes(moneda as (typeof MONEDAS_BASE)[number])
    ? [...MONEDAS_BASE]
    : [...MONEDAS_BASE, moneda];
  const agencias = agenciasDisponibles(perfil?.agenciaPreferida);

  const alGuardar = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setGuardando(true);
    setAviso(undefined);
    try {
      const { data, response } = await api.usuarios.PATCH('/perfil', {
        body: {
          idioma,
          moneda,
          agenciaPreferida: agencia ? agencia : null,
        },
      });
      if (!data) {
        setAviso({ tipo: 'error', clave: claveErrorHttp(response.status) });
        return;
      }
      setPerfil(data);
      setMoneda(data.moneda);
      setAgencia(data.agenciaPreferida ?? '');
      setAviso({ tipo: 'exito', clave: 'preferencias.guardado' });
    } catch {
      setAviso({ tipo: 'error', clave: 'errores.noDisponible' });
    } finally {
      setGuardando(false);
    }
  };

  return (
    <section className="tarjeta" aria-labelledby="titulo-preferencias">
      <h1 id="titulo-preferencias">{t('preferencias.titulo')}</h1>
      <p className="nota">{t('preferencias.descripcion')}</p>
      {perfil && (
        <p className="nota">
          {t('preferencias.cuenta', {
            email: perfil.email,
            region: t(`regiones.${perfil.region}`),
          })}
        </p>
      )}

      {cargando ? (
        <p className="nota">{t('app.cargando')}</p>
      ) : (
        <form className="formulario" onSubmit={(e) => void alGuardar(e)}>
          <label>
            {t('preferencias.idioma')}
            <select
              name="idioma"
              value={idioma}
              aria-describedby="ayuda-idioma"
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
            <small id="ayuda-idioma">{t('preferencias.idiomaAyuda')}</small>
          </label>

          <label>
            {t('preferencias.moneda')}
            <select
              name="moneda"
              value={moneda}
              disabled={guardando || !perfil}
              onChange={(e) => setMoneda(e.target.value)}
            >
              {monedas.map((codigo) => (
                <option key={codigo} value={codigo}>
                  {t(`preferencias.monedas.${codigo}`, { defaultValue: codigo })}
                </option>
              ))}
            </select>
            <small>
              {t('preferencias.ejemploMoneda', {
                precio: formatearMoneda(1234.5, idioma, moneda),
              })}
            </small>
          </label>

          <label>
            {t('preferencias.agencia')}
            <select
              name="agenciaPreferida"
              value={agencia}
              disabled={guardando || !perfil}
              onChange={(e) => setAgencia(e.target.value)}
            >
              <option value="">{t('preferencias.sinAgencia')}</option>
              {agencias.map((slug) => (
                <option key={slug} value={slug}>
                  {t(`preferencias.agencias.${slug}`, { defaultValue: slug })}
                </option>
              ))}
            </select>
          </label>

          {aviso && (
            <p
              role={aviso.tipo === 'error' ? 'alert' : 'status'}
              className={`mensaje ${aviso.tipo}`}
            >
              {t(aviso.clave)}
            </p>
          )}

          <button type="submit" disabled={guardando || !perfil}>
            {guardando ? t('preferencias.guardando') : t('preferencias.guardar')}
          </button>
        </form>
      )}
    </section>
  );
}
