// Detalle de un viaje (viajes.yaml, GET /viajes/{viajeId}) y gestión de personas designadas
// para compartir el itinerario (usuarios.yaml, /itinerarios/{viajeId}/designados).
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import type { components as Usuarios } from '../api/generado/usuarios.ts';
import type { components as Viajes } from '../api/generado/viajes.ts';
import { claveErrorHttp, useIdioma } from '../componentes.tsx';
import { useApp, useClaims } from '../contexto.tsx';
import { formatearFecha } from '../idiomas/formatos.ts';

type Viaje = Viajes['schemas']['Viaje'];
type Designado = Usuarios['schemas']['Designado'];
type Aviso = { tipo: 'exito' | 'error'; clave: string; params?: Record<string, string> };

export function ViajeDetalle() {
  const { viajeId } = useParams<'viajeId'>();
  const { t } = useTranslation();
  const { api } = useApp();
  const claims = useClaims();
  const idioma = useIdioma();

  const [viaje, setViaje] = useState<Viaje>();
  const [errorViaje, setErrorViaje] = useState<string>();
  const [cargando, setCargando] = useState(true);

  const [designados, setDesignados] = useState<Designado[]>([]);
  const [email, setEmail] = useState('');
  const [ocupadoCompartir, setOcupadoCompartir] = useState(false);
  const [avisoCompartir, setAvisoCompartir] = useState<Aviso>();

  useEffect(() => {
    if (!viajeId) return;
    let vigente = true;
    setCargando(true);
    setErrorViaje(undefined);
    setViaje(undefined);
    setDesignados([]);
    setAvisoCompartir(undefined);

    void api.viajes
      .GET('/viajes/{viajeId}', { params: { path: { viajeId } } })
      .then(({ data, response }) => {
        if (!vigente) return;
        if (!data) {
          setErrorViaje(
            response.status === 404 ? 'viaje.noEncontrado' : claveErrorHttp(response.status),
          );
          return;
        }
        setViaje(data);
      })
      .catch(() => {
        if (vigente) setErrorViaje('errores.noDisponible');
      })
      .finally(() => {
        if (vigente) setCargando(false);
      });

    return () => {
      vigente = false;
    };
  }, [api, viajeId]);

  const esDueno = Boolean(viaje && claims?.sub && viaje.usuarioId === claims.sub);

  useEffect(() => {
    if (!viajeId || !esDueno) return;
    let vigente = true;
    void api.usuarios
      .GET('/itinerarios/{viajeId}/designados', { params: { path: { viajeId } } })
      .then(({ data, response }) => {
        if (!vigente) return;
        if (!data) {
          setAvisoCompartir({ tipo: 'error', clave: claveErrorHttp(response.status) });
          return;
        }
        setDesignados(data.designados);
      })
      .catch(() => {
        if (vigente) setAvisoCompartir({ tipo: 'error', clave: 'errores.noDisponible' });
      });
    return () => {
      vigente = false;
    };
  }, [api, esDueno, viajeId]);

  const designar = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!viajeId) return;
    const limpio = email.trim().toLowerCase();
    if (!limpio) return;
    setOcupadoCompartir(true);
    setAvisoCompartir(undefined);
    try {
      const { data, response } = await api.usuarios.POST('/itinerarios/{viajeId}/designados', {
        params: { path: { viajeId } },
        body: { email: limpio },
      });
      if (!data) {
        const clave =
          response.status === 400
            ? 'viaje.compartir.errorSolicitud'
            : response.status === 409
              ? 'viaje.compartir.errorDuplicado'
              : claveErrorHttp(response.status);
        setAvisoCompartir({ tipo: 'error', clave });
        return;
      }
      setDesignados((prev) => [...prev, data]);
      setEmail('');
      setAvisoCompartir({
        tipo: 'exito',
        clave: 'viaje.compartir.agregado',
        params: { email: data.email },
      });
    } catch {
      setAvisoCompartir({ tipo: 'error', clave: 'errores.noDisponible' });
    } finally {
      setOcupadoCompartir(false);
    }
  };

  const quitar = async (correoDesignado: string) => {
    if (!viajeId) return;
    setOcupadoCompartir(true);
    setAvisoCompartir(undefined);
    try {
      const { response } = await api.usuarios.DELETE('/itinerarios/{viajeId}/designados/{email}', {
        params: { path: { viajeId, email: correoDesignado } },
      });
      if (!response.ok) {
        setAvisoCompartir({ tipo: 'error', clave: claveErrorHttp(response.status) });
        return;
      }
      setDesignados((prev) => prev.filter((d) => d.email !== correoDesignado));
      setAvisoCompartir({
        tipo: 'exito',
        clave: 'viaje.compartir.quitado',
        params: { email: correoDesignado },
      });
    } catch {
      setAvisoCompartir({ tipo: 'error', clave: 'errores.noDisponible' });
    } finally {
      setOcupadoCompartir(false);
    }
  };

  if (cargando) {
    return (
      <section className="tarjeta">
        <p className="nota">{t('app.cargando')}</p>
      </section>
    );
  }

  if (errorViaje || !viaje) {
    return (
      <section className="tarjeta" role="alert">
        <p>{t(errorViaje ?? 'viaje.noEncontrado')}</p>
        <Link to="/">{t('viaje.volver')}</Link>
      </section>
    );
  }

  return (
    <div className="pila">
      <section className="tarjeta" aria-labelledby="titulo-viaje">
        <p className="enlace-volver">
          <Link to="/">{t('viaje.volver')}</Link>
        </p>
        <div className="item-cabecera">
          <h1 id="titulo-viaje">{viaje.destino}</h1>
          <span className="etiqueta">{t(`viaje.estados.${viaje.estado}`)}</span>
        </div>
        <p className="nota">
          {t('panel.fechas', {
            inicio: formatearFecha(viaje.inicio, idioma),
            fin: formatearFecha(viaje.fin, idioma),
          })}
        </p>
        {!esDueno && <p className="nota">{t('viaje.compartidoContigo')}</p>}

        <h2 className="subtitulo">{t('viaje.reservasTitulo')}</h2>
        {viaje.reservas.length === 0 ? (
          <p className="nota">{t('viaje.sinReservas')}</p>
        ) : (
          <ul className="lista-tarjetas">
            {viaje.reservas.map((r) => (
              <li key={r.reservaId} className="item-fila">
                <div className="item-datos">
                  <div className="item-cabecera">
                    <strong>
                      {t(`viaje.tipos.${r.tipoReserva}`)} · {r.proveedor}
                    </strong>
                    <span className="etiqueta">{t(`viaje.estadosReserva.${r.estado}`)}</span>
                  </div>
                  <span>
                    {r.origen
                      ? t('viaje.ruta', { origen: r.origen, destino: r.destino })
                      : r.destino}
                  </span>
                  <small>{t('viaje.codigoReserva', { codigo: r.numeroReserva })}</small>
                  <small>
                    {t('panel.fechas', {
                      inicio: formatearFecha(r.inicio, idioma, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      }),
                      fin: formatearFecha(r.fin, idioma, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      }),
                    })}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {esDueno && (
        <section className="tarjeta" aria-labelledby="titulo-compartir">
          <h2 id="titulo-compartir">{t('viaje.compartir.titulo')}</h2>
          <p className="nota">{t('viaje.compartir.descripcion')}</p>

          <form className="formulario-linea" onSubmit={(e) => void designar(e)}>
            <label>
              <span>{t('viaje.compartir.emailLabel')}</span>
              <input
                name="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('viaje.compartir.emailPlaceholder')}
                disabled={ocupadoCompartir}
              />
            </label>
            <button type="submit" disabled={ocupadoCompartir}>
              {t('viaje.compartir.agregar')}
            </button>
          </form>

          {avisoCompartir && (
            <p
              role={avisoCompartir.tipo === 'error' ? 'alert' : 'status'}
              className={`mensaje ${avisoCompartir.tipo}`}
            >
              {avisoCompartir.params
                ? t(avisoCompartir.clave, avisoCompartir.params)
                : t(avisoCompartir.clave)}
            </p>
          )}

          {designados.length === 0 ? (
            <p className="nota">{t('viaje.compartir.vacio')}</p>
          ) : (
            <ul className="lista-tarjetas">
              {designados.map((persona) => (
                <li key={persona.email} className="item-fila">
                  <div className="item-datos">
                    <strong>{persona.email}</strong>
                    <small>
                      {persona.usuarioId
                        ? t('viaje.compartir.conCuenta')
                        : t('viaje.compartir.sinCuenta')}{' '}
                      ·{' '}
                      {t('viaje.compartir.desde', {
                        fecha: formatearFecha(persona.designadoEn, idioma),
                      })}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="secundario"
                    disabled={ocupadoCompartir}
                    aria-label={t('viaje.compartir.quitarPersona', { email: persona.email })}
                    onClick={() => void quitar(persona.email)}
                  >
                    {t('viaje.compartir.quitar')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
