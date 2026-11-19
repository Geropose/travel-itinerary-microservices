// Detalle de un viaje (viajes.yaml, GET /viajes/{viajeId}), gestión manual de reservas (UC-4),
// publicación en red social (POST /viajes/{viajeId}/compartir-red) y personas designadas para
// compartir el itinerario (usuarios.yaml, /itinerarios/{viajeId}/designados). Para personas
// designadas y viajes archivados se muestra en modo estrictamente solo lectura.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import type { components as Usuarios } from '../api/generado/usuarios.ts';
import type { components as Viajes } from '../api/generado/viajes.ts';
import { claveErrorHttp, useIdioma } from '../componentes.tsx';
import { useApp, useClaims } from '../contexto.tsx';
import { formatearFecha } from '../idiomas/formatos.ts';
import {
  ordenarReservas,
  ReservaFormulario,
  ReservaTarjeta,
  type Reserva,
  type Viaje,
} from './viajes-componentes.tsx';

type Designado = Usuarios['schemas']['Designado'];
type PublicacionRed = Viajes['schemas']['PublicacionRed'];
type Aviso = { tipo: 'exito' | 'error'; clave: string; params?: Record<string, string> };

const RED_SOCIAL_POR_DEFECTO = 'redsocial';

export function ViajeDetalle() {
  const { viajeId } = useParams<'viajeId'>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { api } = useApp();
  const claims = useClaims();
  const idioma = useIdioma();

  const [viaje, setViaje] = useState<Viaje>();
  const [errorViaje, setErrorViaje] = useState<string>();
  const [cargando, setCargando] = useState(true);

  const [mostrarAlta, setMostrarAlta] = useState(false);
  const [reservaEditando, setReservaEditando] = useState<Reserva>();
  const [ocupadoReserva, setOcupadoReserva] = useState(false);
  const [avisoReserva, setAvisoReserva] = useState<Aviso>();

  const [designados, setDesignados] = useState<Designado[]>([]);
  const [email, setEmail] = useState('');
  const [ocupadoCompartir, setOcupadoCompartir] = useState(false);
  const [avisoCompartir, setAvisoCompartir] = useState<Aviso>();

  const [publicacionRed, setPublicacionRed] = useState<PublicacionRed>();
  const [publicandoRed, setPublicandoRed] = useState(false);
  const [errorRedSocial, setErrorRedSocial] = useState<string>();

  const montadoRef = useRef(true);

  const cargarViaje = useCallback(
    async (opciones?: { silencioso?: boolean }): Promise<'ok' | 'no-encontrado' | 'error'> => {
      if (!viajeId) return 'error';
      if (!opciones?.silencioso) {
        setCargando(true);
        setErrorViaje(undefined);
        setViaje(undefined);
      }
      try {
        const { data, response } = await api.viajes.GET('/viajes/{viajeId}', {
          params: { path: { viajeId } },
        });
        if (!montadoRef.current) return 'error';
        if (!data) {
          if (response.status === 404) {
            setErrorViaje('viaje.noEncontrado');
            return 'no-encontrado';
          }
          setErrorViaje(claveErrorHttp(response.status));
          return 'error';
        }
        setViaje(data);
        setErrorViaje(undefined);
        return 'ok';
      } catch {
        if (montadoRef.current) setErrorViaje('errores.noDisponible');
        return 'error';
      } finally {
        if (montadoRef.current && !opciones?.silencioso) setCargando(false);
      }
    },
    [api, viajeId],
  );

  useEffect(() => {
    montadoRef.current = true;
    setDesignados([]);
    setAvisoCompartir(undefined);
    setAvisoReserva(undefined);
    setMostrarAlta(false);
    setReservaEditando(undefined);
    setPublicacionRed(undefined);
    setErrorRedSocial(undefined);
    void cargarViaje();
    return () => {
      montadoRef.current = false;
    };
  }, [cargarViaje]);

  const esDueno = Boolean(viaje && claims?.sub && viaje.usuarioId === claims.sub);
  const puedeEditar = Boolean(esDueno && viaje?.estado === 'activo');

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

  const alCrearReserva = async (creada: Reserva) => {
    setMostrarAlta(false);
    setAvisoReserva({
      tipo: 'exito',
      clave: 'reserva.creada',
      params: { codigo: creada.numeroReserva },
    });
    await cargarViaje({ silencioso: true });
  };

  const alModificarReserva = async (modificada: Reserva) => {
    setReservaEditando(undefined);
    setAvisoReserva({
      tipo: 'exito',
      clave: 'reserva.modificada',
      params: { codigo: modificada.numeroReserva },
    });
    await cargarViaje({ silencioso: true });
  };

  const alEliminarReserva = async (reserva: Reserva) => {
    setOcupadoReserva(true);
    setAvisoReserva(undefined);
    try {
      const { response } = await api.viajes.DELETE('/reservas/{reservaId}', {
        params: { path: { reservaId: reserva.reservaId } },
      });
      if (!response.ok) {
        setAvisoReserva({
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
      // Si era la última reserva del viaje, el backend elimina el viaje vacío: volvemos al panel.
      const resultado = await cargarViaje({ silencioso: true });
      if (resultado === 'no-encontrado') {
        void navigate('/', { replace: true });
        return;
      }
      setAvisoReserva({
        tipo: 'exito',
        clave: 'reserva.eliminada',
        params: { codigo: reserva.numeroReserva },
      });
    } catch {
      setAvisoReserva({ tipo: 'error', clave: 'errores.noDisponible' });
    } finally {
      setOcupadoReserva(false);
    }
  };

  const compartirEnRed = async () => {
    if (!viajeId) return;
    setPublicandoRed(true);
    setErrorRedSocial(undefined);
    try {
      const { data, response } = await api.viajes.POST('/viajes/{viajeId}/compartir-red', {
        params: { path: { viajeId } },
        body: { red: RED_SOCIAL_POR_DEFECTO },
      });
      if (!data) {
        setErrorRedSocial(
          response.status === 503
            ? 'viaje.compartirRed.errorNoDisponible'
            : claveErrorHttp(response.status),
        );
        return;
      }
      setPublicacionRed(data);
    } catch {
      setErrorRedSocial('viaje.compartirRed.errorNoDisponible');
    } finally {
      setPublicandoRed(false);
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

  const reservasOrdenadas = ordenarReservas(viaje.reservas);
  const rutaVolver = viaje.estado === 'archivado' ? '/archivados' : '/';
  const textoVolver =
    viaje.estado === 'archivado' ? t('viaje.volverArchivados') : t('viaje.volver');

  return (
    <div className="pila">
      <section className="tarjeta" aria-labelledby="titulo-viaje">
        <p className="enlace-volver">
          <Link to={rutaVolver}>{textoVolver}</Link>
        </p>
        <div className="cabecera-seccion">
          <div>
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
          </div>
          {puedeEditar && (
            <button
              type="button"
              onClick={() => {
                setReservaEditando(undefined);
                setMostrarAlta((actual) => !actual);
              }}
            >
              {mostrarAlta ? t('panel.cerrarFormulario') : t('viaje.agregarReserva')}
            </button>
          )}
        </div>

        {!esDueno && <p className="nota">{t('viaje.compartidoContigo')}</p>}
        {esDueno && viaje.estado === 'archivado' && (
          <p className="nota">{t('viaje.archivadoSoloLectura')}</p>
        )}

        {avisoReserva && (
          <p
            role={avisoReserva.tipo === 'error' ? 'alert' : 'status'}
            className={`mensaje ${avisoReserva.tipo}`}
          >
            {avisoReserva.params
              ? t(avisoReserva.clave, avisoReserva.params)
              : t(avisoReserva.clave)}
          </p>
        )}

        <h2 className="subtitulo">{t('viaje.reservasTitulo')}</h2>
        {reservasOrdenadas.length === 0 ? (
          <p className="nota">{t('viaje.sinReservas')}</p>
        ) : (
          <ul className="lista-tarjetas">
            {reservasOrdenadas.map((reserva) => (
              <ReservaTarjeta
                key={reserva.reservaId}
                reserva={reserva}
                editable={puedeEditar}
                ocupado={ocupadoReserva}
                alEditar={(item) => {
                  setMostrarAlta(false);
                  setReservaEditando(item);
                }}
                alEliminar={alEliminarReserva}
              />
            ))}
          </ul>
        )}
      </section>

      {puedeEditar && mostrarAlta && (
        <ReservaFormulario
          modo="alta"
          viajeFijoId={viaje.viajeId}
          alGuardar={alCrearReserva}
          alCancelar={() => setMostrarAlta(false)}
        />
      )}

      {puedeEditar && reservaEditando && (
        <ReservaFormulario
          key={reservaEditando.reservaId}
          modo="edicion"
          reservaInicial={reservaEditando}
          viajeFijoId={viaje.viajeId}
          alGuardar={alModificarReserva}
          alCancelar={() => setReservaEditando(undefined)}
        />
      )}

      {esDueno && reservasOrdenadas.length > 0 && (
        <section className="tarjeta" aria-labelledby="titulo-compartir-red">
          <h2 id="titulo-compartir-red">{t('viaje.compartirRed.titulo')}</h2>
          <p className="nota">{t('viaje.compartirRed.descripcion')}</p>
          <div className="acciones-fila">
            <button
              type="button"
              className="secundario"
              disabled={publicandoRed}
              onClick={() => void compartirEnRed()}
            >
              {publicandoRed ? t('viaje.compartirRed.publicando') : t('viaje.compartirRed.boton')}
            </button>
          </div>
          {errorRedSocial && (
            <p role="alert" className="mensaje error">
              {t(errorRedSocial)}
            </p>
          )}
          {publicacionRed && (
            <p role="status" className="mensaje exito">
              {t('viaje.compartirRed.publicada', {
                fecha: formatearFecha(publicacionRed.publicadaEn, idioma, {
                  dateStyle: 'short',
                  timeStyle: 'short',
                }),
              })}{' '}
              <a href={publicacionRed.url} target="_blank" rel="noreferrer">
                {t('viaje.compartirRed.verPublicacion')}
              </a>
            </p>
          )}
        </section>
      )}

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
