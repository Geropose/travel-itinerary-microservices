// Pantalla de Whitelist de remitentes (specs/openapi/usuarios.yaml): activar/desactivar filtros y
// agregar o quitar direcciones y dominios permitidos (UC-2).
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { components } from '../api/generado/usuarios.ts';
import { claveErrorHttp, useIdioma } from '../componentes.tsx';
import { useApp } from '../contexto.tsx';
import { formatearFecha } from '../idiomas/formatos.ts';

type WhitelistDatos = components['schemas']['Whitelist'];

const REGEX_REMITENTE = /^[^@\s]*@[^@\s]+\.[^@\s]+$/;

type Aviso = { tipo: 'exito' | 'error'; clave: string };

export function Whitelist() {
  const { t } = useTranslation();
  const { api } = useApp();
  const idioma = useIdioma();

  const [whitelist, setWhitelist] = useState<WhitelistDatos>();
  const [remitente, setRemitente] = useState('');
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<Aviso>();

  useEffect(() => {
    let vigente = true;
    void api.usuarios
      .GET('/whitelist')
      .then(({ data, response }) => {
        if (!vigente) return;
        if (!data) {
          setAviso({ tipo: 'error', clave: claveErrorHttp(response.status) });
          return;
        }
        setWhitelist(data);
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

  const guardarCambio = async (remitentesPermitidos: string[], filtrosActivos: boolean) => {
    setGuardando(true);
    setAviso(undefined);
    try {
      const { data, response } = await api.usuarios.PUT('/whitelist', {
        body: { remitentesPermitidos, filtrosActivos },
      });
      if (!data) {
        setAviso({ tipo: 'error', clave: claveErrorHttp(response.status) });
        return false;
      }
      setWhitelist(data);
      setAviso({ tipo: 'exito', clave: 'whitelist.guardado' });
      return true;
    } catch {
      setAviso({ tipo: 'error', clave: 'errores.noDisponible' });
      return false;
    } finally {
      setGuardando(false);
    }
  };

  const alAlternarFiltros = async (activo: boolean) => {
    if (!whitelist) return;
    const anterior = whitelist;
    setWhitelist({ ...whitelist, filtrosActivos: activo });
    const ok = await guardarCambio(anterior.remitentesPermitidos, activo);
    if (!ok) setWhitelist(anterior);
  };

  const alAgregar = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!whitelist) return;
    const limpio = remitente.trim().toLowerCase();
    if (!REGEX_REMITENTE.test(limpio)) {
      setAviso({ tipo: 'error', clave: 'whitelist.errorFormato' });
      return;
    }
    if (whitelist.remitentesPermitidos.some((r) => r.toLowerCase() === limpio)) {
      setAviso({ tipo: 'error', clave: 'whitelist.errorDuplicado' });
      return;
    }
    const ok = await guardarCambio(
      [...whitelist.remitentesPermitidos, limpio],
      whitelist.filtrosActivos,
    );
    if (ok) setRemitente('');
  };

  const quitar = (objetivo: string) => {
    if (!whitelist) return;
    void guardarCambio(
      whitelist.remitentesPermitidos.filter((r) => r !== objetivo),
      whitelist.filtrosActivos,
    );
  };

  return (
    <section className="tarjeta" aria-labelledby="titulo-whitelist">
      <h1 id="titulo-whitelist">{t('whitelist.titulo')}</h1>
      <p className="nota">{t('whitelist.descripcion')}</p>

      {cargando ? (
        <p className="nota">{t('app.cargando')}</p>
      ) : (
        whitelist && (
          <>
            <div className="bloque-interruptor">
              <label className="interruptor">
                <input
                  type="checkbox"
                  checked={whitelist.filtrosActivos}
                  disabled={guardando}
                  onChange={(e) => void alAlternarFiltros(e.target.checked)}
                />
                <span>{t('whitelist.activarFiltros')}</span>
              </label>
              <small>
                {whitelist.filtrosActivos
                  ? t('whitelist.estadoActivo')
                  : t('whitelist.estadoInactivo')}
              </small>
              {whitelist.actualizadoEn && (
                <small>
                  {t('whitelist.actualizado', {
                    fecha: formatearFecha(whitelist.actualizadoEn, idioma, {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    }),
                  })}
                </small>
              )}
            </div>

            <form className="formulario-linea" onSubmit={(e) => void alAgregar(e)}>
              <label>
                <span>{t('whitelist.remitenteLabel')}</span>
                <input
                  name="remitente"
                  type="text"
                  value={remitente}
                  onChange={(e) => setRemitente(e.target.value)}
                  placeholder={t('whitelist.remitentePlaceholder')}
                  aria-describedby="ayuda-remitente"
                  disabled={guardando}
                />
                <small id="ayuda-remitente">{t('whitelist.remitenteAyuda')}</small>
              </label>
              <button type="submit" disabled={guardando}>
                {t('whitelist.agregar')}
              </button>
            </form>

            {aviso && (
              <p
                role={aviso.tipo === 'error' ? 'alert' : 'status'}
                className={`mensaje ${aviso.tipo}`}
              >
                {t(aviso.clave)}
              </p>
            )}

            <h2 className="subtitulo">{t('whitelist.listaTitulo')}</h2>
            {whitelist.remitentesPermitidos.length === 0 ? (
              <p className="nota">{t('whitelist.sinRemitentes')}</p>
            ) : (
              <ul className="lista-tarjetas">
                {whitelist.remitentesPermitidos.map((item) => (
                  <li key={item} className="item-fila">
                    <strong>{item}</strong>
                    <button
                      type="button"
                      className="secundario"
                      disabled={guardando}
                      aria-label={t('whitelist.quitarRemitente', { remitente: item })}
                      onClick={() => quitar(item)}
                    >
                      {t('whitelist.quitar')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )
      )}
    </section>
  );
}
