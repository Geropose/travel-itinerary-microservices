// Pantalla de cuentas de correo conectadas (specs/openapi/correo.yaml): listado, última revisión,
// flujo OAuth de solo lectura (Gmail / Outlook) y desconexión.
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import type { components } from '../api/generado/correo.ts';
import { claveErrorHttp, useIdioma } from '../componentes.tsx';
import { useApp } from '../contexto.tsx';
import { formatearFecha } from '../idiomas/formatos.ts';

type CuentaCorreo = components['schemas']['CuentaCorreo'];
type ProveedorCorreo = components['schemas']['ProveedorCorreo'];

const MOTIVOS_OAUTH = new Set([
  'permiso-denegado',
  'scope-insuficiente',
  'codigo-invalido',
  'cuenta-de-otro-usuario',
  'proveedor-no-disponible',
]);

type Aviso = { tipo: 'exito' | 'error'; clave: string };

function leerAvisoOAuth(params: URLSearchParams): Aviso | undefined {
  const resultado = params.get('resultado');
  if (resultado === 'conectada') return { tipo: 'exito', clave: 'correo.oauthConectada' };
  if (resultado === 'error') {
    const motivo = params.get('motivo') ?? '';
    const claveMotivo = MOTIVOS_OAUTH.has(motivo) ? motivo : 'desconocido';
    return { tipo: 'error', clave: `correo.erroresOAuth.${claveMotivo}` };
  }
  return undefined;
}

export function Correo() {
  const { t } = useTranslation();
  const { api } = useApp();
  const idioma = useIdioma();
  const [searchParams, setSearchParams] = useSearchParams();

  const [cuentas, setCuentas] = useState<CuentaCorreo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<Aviso | undefined>(() => leerAvisoOAuth(searchParams));

  useEffect(() => {
    if (
      searchParams.has('resultado') ||
      searchParams.has('motivo') ||
      searchParams.has('cuentaId')
    ) {
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const cargarCuentas = useCallback(async () => {
    setCargando(true);
    try {
      const { data, response } = await api.correo.GET('/cuentas-correo');
      if (!data) {
        setAviso({ tipo: 'error', clave: claveErrorHttp(response.status) });
        return;
      }
      setCuentas(data.cuentas);
    } catch {
      setAviso({ tipo: 'error', clave: 'errores.noDisponible' });
    } finally {
      setCargando(false);
    }
  }, [api]);

  useEffect(() => {
    void cargarCuentas();
  }, [cargarCuentas]);

  const conectar = async (proveedorCorreo: ProveedorCorreo) => {
    setOcupado(true);
    setAviso(undefined);
    try {
      const { data, response } = await api.correo.POST(
        '/cuentas-correo/{proveedorCorreo}/conectar',
        {
          params: { path: { proveedorCorreo } },
        },
      );
      if (!data) {
        setAviso({ tipo: 'error', clave: claveErrorHttp(response.status) });
        return;
      }
      window.location.assign(data.urlAutorizacion);
    } catch {
      setAviso({ tipo: 'error', clave: 'errores.noDisponible' });
    } finally {
      setOcupado(false);
    }
  };

  const desconectar = async (cuentaId: string) => {
    setOcupado(true);
    setAviso(undefined);
    try {
      const { response } = await api.correo.DELETE('/cuentas-correo/{cuentaId}', {
        params: { path: { cuentaId } },
      });
      if (!response.ok) {
        setAviso({ tipo: 'error', clave: claveErrorHttp(response.status) });
        return;
      }
      setCuentas((prev) => prev.filter((c) => c.id !== cuentaId));
      setAviso({ tipo: 'exito', clave: 'correo.desconectadaExito' });
    } catch {
      setAviso({ tipo: 'error', clave: 'errores.noDisponible' });
    } finally {
      setOcupado(false);
    }
  };

  const fmtFecha = (iso: string) =>
    formatearFecha(iso, idioma, { dateStyle: 'short', timeStyle: 'short' });

  return (
    <section className="tarjeta" aria-labelledby="titulo-correo">
      <h1 id="titulo-correo">{t('correo.titulo')}</h1>
      <p className="nota">{t('correo.descripcion')}</p>

      <div className="acciones-fila">
        <button type="button" disabled={ocupado} onClick={() => void conectar('gmail')}>
          {t('correo.conectarGmail')}
        </button>
        <button type="button" disabled={ocupado} onClick={() => void conectar('outlook')}>
          {t('correo.conectarOutlook')}
        </button>
      </div>

      {aviso && (
        <p role={aviso.tipo === 'error' ? 'alert' : 'status'} className={`mensaje ${aviso.tipo}`}>
          {t(aviso.clave)}
        </p>
      )}

      <h2 className="subtitulo">{t('correo.cuentasTitulo')}</h2>
      {cargando ? (
        <p className="nota">{t('app.cargando')}</p>
      ) : cuentas.length === 0 ? (
        <p className="nota">{t('correo.sinCuentas')}</p>
      ) : (
        <ul className="lista-tarjetas">
          {cuentas.map((cuenta) => (
            <li key={cuenta.id} className="item-fila">
              <div className="item-datos">
                <div className="item-cabecera">
                  <strong>{cuenta.email}</strong>
                  <span className="etiqueta">
                    {t(`correo.proveedores.${cuenta.proveedorCorreo}`)}
                  </span>
                  <span className={`estado estado-${cuenta.estado}`}>
                    {t(`correo.estados.${cuenta.estado}`)}
                  </span>
                </div>
                <small>{t('correo.conectadaEl', { fecha: fmtFecha(cuenta.conectadaEn) })}</small>
                <small>
                  {cuenta.ultimaRevision
                    ? t('correo.ultimaRevision', { fecha: fmtFecha(cuenta.ultimaRevision) })
                    : t('correo.sinRevision')}
                </small>
                {cuenta.estado === 'sin-permiso' && (
                  <small className="texto-error">{t('correo.reconectarAviso')}</small>
                )}
              </div>
              <button
                type="button"
                className="secundario"
                disabled={ocupado}
                aria-label={t('correo.desconectarCuenta', { email: cuenta.email })}
                onClick={() => void desconectar(cuenta.id)}
              >
                {t('correo.desconectar')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
