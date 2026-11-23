// Ventana de chat con el Asistente Virtual (P2.D6, Iteración 7, ADR-019):
// - Burbuja flotante en todas las pantallas del usuario + vista completa en /asistente.
// - Mensajes del usuario y del asistente, tarjetas de reservas, botones para confirmar opciones
//   de reprogramación y acceso rápido para derivar a la agencia.
// - Polling cada 2 s a GET /conversaciones/{id}/mensajes?desde= mientras `consultando` sea true
//   (se detiene al llegar la respuesta o al cerrar el chat).
// - Degradación controlada (ADR-019): si /health falla o hay 3 errores seguidos del asistente,
//   oculta el chat y muestra el botón "Contactar a mi agencia" (POST /agencias/casos).
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import type { components as AsistenteSchemas } from '../api/generado/asistente.ts';
import { claveErrorHttp, useEnLinea, useIdioma } from '../componentes.tsx';
import { useApp, useClaims } from '../contexto.tsx';
import { formatearFecha } from '../idiomas/formatos.ts';

type Mensaje = AsistenteSchemas['schemas']['Mensaje'];
type OpcionReprogramacion = AsistenteSchemas['schemas']['OpcionReprogramacion'];
type ReservaResumen = AsistenteSchemas['schemas']['ReservaResumen'];

const INTERVALO_POLLING_MS = 2000;
const MAX_ERRORES_SEGUIDOS = 3;

function claveConversacion(usuarioId: string | undefined): string {
  return `trotamundos.chat.conversacion.${usuarioId ?? 'anonimo'}`;
}

function leerConversacionGuardada(usuarioId: string | undefined): string | null {
  try {
    return window.sessionStorage.getItem(claveConversacion(usuarioId));
  } catch {
    return null;
  }
}

function guardarConversacionId(usuarioId: string | undefined, id: string | null) {
  try {
    const clave = claveConversacion(usuarioId);
    if (id) window.sessionStorage.setItem(clave, id);
    else window.sessionStorage.removeItem(clave);
  } catch {
    // Entornos sin sessionStorage disponible: seguimos solo en memoria.
  }
}

/** Zona horaria del dispositivo (por ejemplo, `America/Argentina/Buenos_Aires`), para que el asistente muestre las horas como el panel. */
function zonaHorariaDelDispositivo(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function combinarMensajes(actuales: Mensaje[], nuevos: Mensaje[]): Mensaje[] {
  if (nuevos.length === 0) return actuales;
  const porId = new Map<string, Mensaje>();
  for (const m of actuales) porId.set(m.mensajeId, m);
  for (const m of nuevos) porId.set(m.mensajeId, m);
  return [...porId.values()].sort((a, b) => a.secuencia - b.secuencia);
}

function ultimaSecuenciaDe(mensajes: Mensaje[]): number {
  let max = 0;
  for (const m of mensajes) {
    if (m.secuencia > max) max = m.secuencia;
  }
  return max;
}

/** Determina si la oferta de opciones de `mensaje` sigue pendiente de confirmación. */
function esOfertaActiva(mensajes: Mensaje[], indice: number): boolean {
  const actual = mensajes[indice];
  if (!actual || actual.autor !== 'asistente' || !actual.opciones?.length) return false;
  for (let i = indice + 1; i < mensajes.length; i += 1) {
    const posterior = mensajes[i];
    if (!posterior) continue;
    if (
      posterior.confirmacion ||
      posterior.resultado === 'reprogramado' ||
      posterior.resultado === 'opcionRechazada' ||
      posterior.resultado === 'opciones' ||
      posterior.resultado === 'derivado'
    ) {
      return false;
    }
  }
  return true;
}

function esErrorDeServicio(status: number | undefined): boolean {
  return status === undefined || status >= 500;
}

interface PropsContactoAgencia {
  modo: 'flotante' | 'pantalla';
  onReintentarAsistente: () => void;
}

function FallbackAgencia({ modo, onReintentarAsistente }: PropsContactoAgencia) {
  const { t } = useTranslation();
  const { api } = useApp();
  const enLinea = useEnLinea();
  const [formularioAbierto, setFormularioAbierto] = useState(modo === 'pantalla');
  const [resumen, setResumen] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sinAgencia, setSinAgencia] = useState(false);
  const [casoCreado, setCasoCreado] = useState<{ agencia: string; numeroCaso: string } | null>(
    null,
  );

  async function enviarCaso(evento: FormEvent) {
    evento.preventDefault();
    const limpio = resumen.trim();
    if (!limpio) {
      setError(t('chat.agenciaResumenRequerido'));
      return;
    }
    setEnviando(true);
    setError(null);
    setSinAgencia(false);
    setCasoCreado(null);
    try {
      const { data, response } = await api.integraciones.POST('/agencias/casos', {
        body: { resumen: limpio },
      });
      if (data) {
        setCasoCreado({ agencia: data.agencia, numeroCaso: data.numeroCaso });
        setResumen('');
        return;
      }
      if (response.status === 409) {
        setSinAgencia(true);
        return;
      }
      setError(t(claveErrorHttp(response.status)));
    } catch {
      setError(t('errores.noDisponible'));
    } finally {
      setEnviando(false);
    }
  }

  const cuerpoFormulario = (
    <div
      className={modo === 'flotante' ? 'chat-panel chat-panel-agencia' : 'tarjeta chat-pantalla'}
      data-testid="panel-contactar-agencia"
    >
      <div className="chat-cabecera">
        <div>
          <h2 className="chat-titulo">{t('chat.agenciaTitulo')}</h2>
          <p className="nota chat-subtitulo">{t('chat.asistenteCaido')}</p>
        </div>
        {modo === 'flotante' && (
          <button
            type="button"
            className="secundario chat-boton-chico"
            onClick={() => setFormularioAbierto(false)}
          >
            {t('chat.agenciaCerrar')}
          </button>
        )}
      </div>

      <div className="chat-cuerpo-agencia">
        <p>{t('chat.agenciaAyuda')}</p>

        {casoCreado && (
          <p className="mensaje-ok" aria-live="polite" data-testid="agencia-caso-creado">
            {t('chat.agenciaExito', {
              numeroCaso: casoCreado.numeroCaso,
              agencia: casoCreado.agencia,
            })}
          </p>
        )}

        {sinAgencia && (
          <div role="alert" className="chat-alerta">
            <p>{t('chat.agenciaSinPreferida')}</p>
            <Link to="/preferencias">{t('chat.agenciaIrAPreferencias')}</Link>
          </div>
        )}

        {error && (
          <p role="alert" className="chat-alerta">
            {error}
          </p>
        )}

        <form className="formulario" onSubmit={(e) => void enviarCaso(e)}>
          <label>
            {t('chat.agenciaResumen')}
            <textarea
              rows={3}
              value={resumen}
              placeholder={t('chat.agenciaPlaceholder')}
              onChange={(e) => setResumen(e.target.value)}
              disabled={enviando || !enLinea}
            />
          </label>
          <div className="chat-acciones-agencia">
            <button type="submit" disabled={enviando || !enLinea}>
              {enviando ? t('chat.agenciaEnviando') : t('chat.agenciaEnviar')}
            </button>
            <button
              type="button"
              className="secundario"
              onClick={onReintentarAsistente}
              disabled={!enLinea}
            >
              {t('chat.agenciaReintentarAsistente')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  if (modo === 'pantalla') return cuerpoFormulario;

  return (
    <div className="chat-flotante">
      {formularioAbierto && cuerpoFormulario}
      {!formularioAbierto && (
        <button
          type="button"
          className="chat-burbuja chat-burbuja-agencia"
          data-testid="boton-contactar-agencia"
          onClick={() => setFormularioAbierto(true)}
        >
          {t('chat.contactarAgencia')}
        </button>
      )}
    </div>
  );
}

interface PropsVentanaChat {
  modo: 'flotante' | 'pantalla';
}

function VentanaChat({ modo }: PropsVentanaChat) {
  const { t } = useTranslation();
  const { api } = useApp();
  const claims = useClaims();
  const idioma = useIdioma();
  const enLinea = useEnLinea();
  const usuarioId = claims?.sub;

  const [abierto, setAbierto] = useState(modo === 'pantalla');
  const [asistenteCaido, setAsistenteCaido] = useState(false);
  const [conversacionId, setConversacionId] = useState<string | null>(() =>
    leerConversacionGuardada(usuarioId),
  );
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [consultando, setConsultando] = useState(false);
  const [iniciando, setIniciando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [confirmandoId, setConfirmandoId] = useState<string | null>(null);
  const [texto, setTexto] = useState('');
  const [errorLocal, setErrorLocal] = useState<string | null>(null);

  const erroresSeguidosRef = useRef(0);
  const ultimaSecuenciaRef = useRef(0);
  const conversacionActivaRef = useRef<string | null>(conversacionId);
  const finListaRef = useRef<HTMLDivElement | null>(null);

  const chatActivo = modo === 'pantalla' || abierto;

  useEffect(() => {
    conversacionActivaRef.current = conversacionId;
  }, [conversacionId]);

  useEffect(() => {
    ultimaSecuenciaRef.current = ultimaSecuenciaDe(mensajes);
  }, [mensajes]);

  useEffect(() => {
    if (chatActivo) {
      finListaRef.current?.scrollIntoView?.({ block: 'end' });
    }
  }, [mensajes.length, consultando, chatActivo]);

  const registrarExito = useCallback(() => {
    erroresSeguidosRef.current = 0;
  }, []);

  const registrarFallaServicio = useCallback(() => {
    erroresSeguidosRef.current += 1;
    if (erroresSeguidosRef.current >= MAX_ERRORES_SEGUIDOS) {
      setConsultando(false);
      setAsistenteCaido(true);
      return true;
    }
    return false;
  }, []);

  const verificarSalud = useCallback(async () => {
    if (!enLinea) return;
    try {
      const { data, response } = await api.asistente.GET('/health');
      if (response.ok && data?.estado === 'ok') {
        erroresSeguidosRef.current = 0;
        setAsistenteCaido(false);
      } else {
        setConsultando(false);
        setAsistenteCaido(true);
      }
    } catch {
      if (navigator.onLine) {
        setConsultando(false);
        setAsistenteCaido(true);
      }
    }
  }, [api, enLinea]);

  // Chequea /health al montar (y cuando vuelve la conexión): si está caído, oculta el chat y
  // muestra "Contactar a mi agencia" (ADR-019).
  useEffect(() => {
    void verificarSalud();
  }, [verificarSalud]);

  const abrirONuevaConversacion = useCallback(
    async (forzarNueva = false) => {
      if (!enLinea || asistenteCaido) return;
      setIniciando(true);
      setErrorLocal(null);
      try {
        const existente = forzarNueva ? null : conversacionId;
        if (existente) {
          const { data, response } = await api.asistente.GET('/conversaciones/{conversacionId}', {
            params: { path: { conversacionId: existente } },
          });
          if (data) {
            registrarExito();
            setConversacionId(data.conversacionId);
            setMensajes(data.mensajes);
            setConsultando(data.consultando);
            return;
          }
          if (response.status === 404) {
            guardarConversacionId(usuarioId, null);
            setConversacionId(null);
          } else if (esErrorDeServicio(response.status)) {
            if (!registrarFallaServicio()) setErrorLocal(t('chat.errorEnvio'));
            return;
          }
        }

        const { data, response } = await api.asistente.POST('/conversaciones', {
          body: { idioma },
        });
        if (data) {
          registrarExito();
          guardarConversacionId(usuarioId, data.conversacionId);
          setConversacionId(data.conversacionId);
          setMensajes(data.mensajes);
          setConsultando(data.consultando);
          return;
        }
        if (esErrorDeServicio(response.status)) {
          if (!registrarFallaServicio()) setErrorLocal(t('chat.errorEnvio'));
        } else {
          setErrorLocal(t(claveErrorHttp(response.status)));
        }
      } catch {
        if (!registrarFallaServicio()) setErrorLocal(t('errores.noDisponible'));
      } finally {
        setIniciando(false);
      }
    },
    [
      api,
      asistenteCaido,
      conversacionId,
      enLinea,
      idioma,
      registrarExito,
      registrarFallaServicio,
      t,
      usuarioId,
    ],
  );

  // Cuando el usuario abre la ventana de chat y aún no cargamos mensajes, iniciamos o retomamos.
  useEffect(() => {
    if (!chatActivo || asistenteCaido || !enLinea) return;
    if (mensajes.length > 0 || iniciando) return;
    void abrirONuevaConversacion(false);
  }, [chatActivo, asistenteCaido, enLinea, mensajes.length, iniciando, abrirONuevaConversacion]);

  // Polling cada 2 s mientras `consultando` sea true y la ventana esté abierta.
  // Al cerrar el chat (`chatActivo = false`), cambiar de conversación o llegar la respuesta,
  // ignora respuestas tardías de conversaciones anteriores y limpia el intervalo.
  useEffect(() => {
    if (!chatActivo || !consultando || !conversacionId || asistenteCaido || !enLinea) {
      return undefined;
    }

    let cancelado = false;
    let enVuelo = false;
    const conversacionSondeada = conversacionId;

    const consultarNuevos = async () => {
      if (enVuelo || cancelado) return;
      enVuelo = true;
      try {
        const { data, response } = await api.asistente.GET(
          '/conversaciones/{conversacionId}/mensajes',
          {
            params: {
              path: { conversacionId: conversacionSondeada },
              query: { desde: ultimaSecuenciaRef.current },
            },
          },
        );
        if (cancelado || conversacionActivaRef.current !== conversacionSondeada) {
          return;
        }
        if (data) {
          registrarExito();
          if (data.mensajes.length > 0) {
            setMensajes((prev) => combinarMensajes(prev, data.mensajes));
          }
          ultimaSecuenciaRef.current = Math.max(ultimaSecuenciaRef.current, data.ultimaSecuencia);
          if (!data.consultando) {
            setConsultando(false);
          }
          return;
        }
        if (esErrorDeServicio(response.status)) {
          registrarFallaServicio();
        }
      } catch {
        if (!cancelado && conversacionActivaRef.current === conversacionSondeada) {
          registrarFallaServicio();
        }
      } finally {
        enVuelo = false;
      }
    };

    const temporizador = window.setInterval(() => {
      void consultarNuevos();
    }, INTERVALO_POLLING_MS);

    return () => {
      cancelado = true;
      window.clearInterval(temporizador);
    };
  }, [
    api,
    asistenteCaido,
    chatActivo,
    consultando,
    conversacionId,
    enLinea,
    registrarExito,
    registrarFallaServicio,
  ]);

  async function enviarTexto(textoMensaje: string) {
    const limpio = textoMensaje.trim();
    if (!limpio || enviando || consultando || !enLinea || asistenteCaido) return;

    let idActual = conversacionId;
    if (!idActual) {
      setIniciando(true);
      try {
        const { data, response } = await api.asistente.POST('/conversaciones', {
          body: { idioma },
        });
        if (!data) {
          if (esErrorDeServicio(response.status)) {
            if (!registrarFallaServicio()) setErrorLocal(t('chat.errorEnvio'));
          } else {
            setErrorLocal(t(claveErrorHttp(response.status)));
          }
          return;
        }
        registrarExito();
        idActual = data.conversacionId;
        guardarConversacionId(usuarioId, idActual);
        setConversacionId(idActual);
        setMensajes(data.mensajes);
      } catch {
        if (!registrarFallaServicio()) setErrorLocal(t('errores.noDisponible'));
        return;
      } finally {
        setIniciando(false);
      }
    }

    setEnviando(true);
    setErrorLocal(null);
    try {
      const { data, response } = await api.asistente.POST(
        '/conversaciones/{conversacionId}/mensajes',
        {
          params: { path: { conversacionId: idActual } },
          body: { texto: limpio, zonaHoraria: zonaHorariaDelDispositivo() },
        },
      );
      if (data) {
        registrarExito();
        setTexto('');
        setMensajes((prev) => combinarMensajes(prev, [data.mensajeUsuario, data.respuesta]));
        setConsultando(data.estado === 'consultando' || response.status === 202);
        return;
      }
      if (esErrorDeServicio(response.status)) {
        if (!registrarFallaServicio()) setErrorLocal(t('chat.errorEnvio'));
      } else {
        setErrorLocal(t(claveErrorHttp(response.status)));
      }
    } catch {
      if (!registrarFallaServicio()) setErrorLocal(t('errores.noDisponible'));
    } finally {
      setEnviando(false);
    }
  }

  async function confirmarOpcion(opcion: OpcionReprogramacion) {
    if (!conversacionId || enviando || consultando || confirmandoId || !enLinea || asistenteCaido) {
      return;
    }
    setConfirmandoId(opcion.opcionId);
    setErrorLocal(null);
    try {
      const { data, response } = await api.asistente.POST(
        '/conversaciones/{conversacionId}/confirmaciones',
        {
          params: { path: { conversacionId } },
          body: { opcionId: opcion.opcionId, zonaHoraria: zonaHorariaDelDispositivo() },
        },
      );
      if (data) {
        registrarExito();
        setMensajes((prev) => combinarMensajes(prev, [data.mensajeUsuario, data.respuesta]));
        setConsultando(data.estado === 'consultando' || response.status === 202);
        return;
      }
      if (response.status === 409) {
        setErrorLocal(t('chat.errorConfirmar'));
      } else if (esErrorDeServicio(response.status)) {
        if (!registrarFallaServicio()) setErrorLocal(t('chat.errorConfirmar'));
      } else {
        setErrorLocal(t(claveErrorHttp(response.status)));
      }
    } catch {
      if (!registrarFallaServicio()) setErrorLocal(t('errores.noDisponible'));
    } finally {
      setConfirmandoId(null);
    }
  }

  function manejarSubmit(evento: FormEvent) {
    evento.preventDefault();
    void enviarTexto(texto);
  }

  if (asistenteCaido) {
    return (
      <FallbackAgencia
        modo={modo}
        onReintentarAsistente={() => {
          void verificarSalud();
        }}
      />
    );
  }

  const contenidoVentana = (
    <section
      className={modo === 'flotante' ? 'chat-panel' : 'tarjeta chat-pantalla'}
      aria-label={t('chat.titulo')}
      data-testid="ventana-chat"
    >
      <header className="chat-cabecera">
        <h2 className="chat-titulo">{t('chat.titulo')}</h2>
        <div className="chat-cabecera-acciones">
          <button
            type="button"
            className="secundario chat-boton-chico"
            onClick={() => {
              conversacionActivaRef.current = null;
              ultimaSecuenciaRef.current = 0;
              setMensajes([]);
              setConsultando(false);
              guardarConversacionId(usuarioId, null);
              setConversacionId(null);
              void abrirONuevaConversacion(true);
            }}
            disabled={iniciando || enviando || !enLinea}
          >
            {t('chat.nuevaConversacion')}
          </button>
          {modo === 'flotante' && (
            <button
              type="button"
              className="secundario chat-boton-chico"
              aria-label={t('chat.cerrar')}
              onClick={() => setAbierto(false)}
            >
              ×
            </button>
          )}
        </div>
      </header>

      <div className="chat-mensajes" aria-live="polite" data-testid="chat-lista-mensajes">
        {iniciando && mensajes.length === 0 && <p className="nota">{t('chat.iniciando')}</p>}

        {mensajes.map((mensaje, indice) => {
          const ofertaActiva = esOfertaActiva(mensajes, indice);
          const esUltimo = indice === mensajes.length - 1;
          return (
            <article
              key={mensaje.mensajeId}
              className={`chat-mensaje chat-mensaje-${mensaje.autor}`}
              data-testid={`chat-mensaje-${mensaje.autor}`}
            >
              <div className="chat-mensaje-meta">
                <strong>
                  {mensaje.autor === 'usuario' ? t('chat.autorUsuario') : t('chat.autorAsistente')}
                </strong>
                <small>{formatearFecha(mensaje.enviadoEn, idioma, { timeStyle: 'short' })}</small>
              </div>
              <p className="chat-mensaje-texto">{mensaje.texto}</p>

              {mensaje.reservas && mensaje.reservas.length > 0 && (
                <ul className="chat-reservas" data-testid="chat-reservas">
                  {mensaje.reservas.map((r: ReservaResumen) => (
                    <li key={`${r.proveedor}-${r.numeroReserva}`} className="chat-reserva-item">
                      <strong>
                        {t(`viaje.tipos.${r.tipoReserva}`)} · {r.numeroReserva}
                      </strong>{' '}
                      <span className={`estado estado-${r.estado}`}>
                        {t(`viaje.estadosReserva.${r.estado}`)}
                      </span>
                      <div className="nota">
                        {r.origen ? `${r.origen} → ${r.destino}` : r.destino} ·{' '}
                        {formatearFecha(r.inicio, idioma, {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {mensaje.opciones && mensaje.opciones.length > 0 && (
                <div className="chat-opciones" data-testid="chat-opciones">
                  <p className="nota">{t('chat.opcionesTitulo')}</p>
                  {mensaje.opciones.map((opcion) => (
                    <div key={opcion.opcionId} className="chat-opcion-tarjeta">
                      <div>
                        <strong>
                          {opcion.descripcion ??
                            `${opcion.origen ? `${opcion.origen} → ` : ''}${opcion.destino}`}
                        </strong>
                        <div className="nota">
                          {opcion.numeroReserva} ·{' '}
                          {formatearFecha(opcion.inicio, idioma, {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="chat-boton-confirmar"
                        data-testid={`confirmar-opcion-${opcion.opcionId}`}
                        disabled={
                          !ofertaActiva ||
                          enviando ||
                          consultando ||
                          confirmandoId !== null ||
                          !enLinea
                        }
                        onClick={() => void confirmarOpcion(opcion)}
                      >
                        {confirmandoId === opcion.opcionId
                          ? t('chat.confirmando')
                          : t('chat.confirmarOpcion')}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {mensaje.caso && (
                <p className="chat-badge-caso" data-testid="chat-caso-derivado">
                  {t('chat.casoCreado', {
                    numeroCaso: mensaje.caso.numeroCaso,
                    agencia: mensaje.caso.agencia,
                  })}
                </p>
              )}

              {mensaje.noDisponible && (
                <p className="nota chat-badge-degradado">
                  {t('chat.funcionNoDisponible', { servicio: mensaje.noDisponible.servicio })}
                </p>
              )}

              {mensaje.ofreceDerivar && esUltimo && !consultando && (
                <button
                  type="button"
                  className="secundario chat-boton-derivar"
                  disabled={enviando || !enLinea}
                  onClick={() => void enviarTexto(t('chat.mensajeConfirmarDerivacion'))}
                >
                  {t('chat.derivarRapido')}
                </button>
              )}
            </article>
          );
        })}

        {consultando && (
          <p className="chat-consultando" data-testid="chat-consultando">
            {t('chat.consultando')}
          </p>
        )}

        {!enLinea && <p className="nota">{t('chat.sinConexion')}</p>}

        <div ref={finListaRef} />
      </div>

      {errorLocal && (
        <p role="alert" className="chat-alerta chat-alerta-inline">
          {errorLocal}
        </p>
      )}

      <form className="chat-formulario" onSubmit={manejarSubmit}>
        <input
          type="text"
          aria-label={t('chat.etiquetaMensaje')}
          placeholder={t('chat.placeholder')}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          disabled={enviando || consultando || iniciando || !enLinea}
        />
        <button
          type="submit"
          disabled={enviando || consultando || iniciando || !enLinea || texto.trim().length === 0}
        >
          {enviando ? t('chat.enviando') : t('chat.enviar')}
        </button>
      </form>
    </section>
  );

  if (modo === 'pantalla') return contenidoVentana;

  return (
    <div className="chat-flotante">
      {abierto ? (
        contenidoVentana
      ) : (
        <button
          type="button"
          className="chat-burbuja"
          data-testid="chat-burbuja"
          aria-label={t('chat.abrir')}
          onClick={() => setAbierto(true)}
        >
          {t('menu.asistente')}
        </button>
      )}
    </div>
  );
}

/** Burbuja flotante que aparece en todas las pantallas del usuario (excepto en /asistente). */
export function BurbujaAsistente() {
  const { pathname } = useLocation();
  if (pathname === '/asistente') return null;
  return <VentanaChat modo="flotante" />;
}

/** Pantalla dedicada /asistente (accesible también desde el menú principal). */
export function Asistente() {
  const { t } = useTranslation();
  return (
    <div className="pantalla-asistente">
      <h1>{t('menu.asistente')}</h1>
      <VentanaChat modo="pantalla" />
    </div>
  );
}
