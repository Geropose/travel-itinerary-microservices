// Piezas reutilizables de Viajes: ordenamiento y lectura de detalles de reserva, tarjeta con estado
// visible y formatos Intl, y formulario de alta/edición manual (UC-4, viajes.yaml).
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { components } from '../api/generado/viajes.ts';
import { claveErrorHttp, useIdioma } from '../componentes.tsx';
import { useApp } from '../contexto.tsx';
import {
  aInputFechaHora,
  desdeInputFechaHora,
  formatearFecha,
  formatearMoneda,
} from '../idiomas/formatos.ts';

export type Viaje = components['schemas']['Viaje'];
export type Reserva = components['schemas']['Reserva'];
export type TipoReserva = components['schemas']['TipoReserva'];
export type EstadoReserva = components['schemas']['EstadoReserva'];
type NuevaReserva = components['schemas']['NuevaReserva'];
type CambioReserva = components['schemas']['CambioReserva'];

const TIPOS_RESERVA: readonly TipoReserva[] = ['vuelo', 'hotel', 'auto'];
const ESTADOS_RESERVA: readonly EstadoReserva[] = ['confirmada', 'modificada', 'cancelada'];
const MONEDAS_SUGERIDAS = ['ARS', 'USD', 'EUR', 'BRL', 'CLP', 'UYU', 'MXN'] as const;
const PROVEEDORES_SUGERIDOS = ['aerolinea-andina', 'hotel-cordillera', 'rentadora-sur'] as const;

export interface DetalleLeido {
  precio?: number;
  moneda?: string;
  numeroVuelo?: string;
  asiento?: string;
  habitacion?: string;
  vehiculo?: string;
  notas?: string;
}

/** Ordena las reservas de un viaje cronológicamente por fecha de inicio. */
export function ordenarReservas(reservas: readonly Reserva[]): Reserva[] {
  return [...reservas].sort((a, b) => new Date(a.inicio).getTime() - new Date(b.inicio).getTime());
}

/** Extrae datos de presentación conocidos del campo libre `detalle`. */
export function leerDetalleReserva(detalle: unknown): DetalleLeido {
  if (!detalle || typeof detalle !== 'object') return {};
  const crudo = detalle as Record<string, unknown>;
  const resultado: DetalleLeido = {};

  const precioBruto = crudo.precio ?? crudo.monto ?? crudo.importe;
  if (typeof precioBruto === 'number' && Number.isFinite(precioBruto) && precioBruto >= 0) {
    resultado.precio = precioBruto;
  }

  const texto = (clave: string): string | undefined => {
    const valor = crudo[clave];
    return typeof valor === 'string' && valor.trim().length > 0 ? valor.trim() : undefined;
  };

  const moneda = texto('moneda');
  if (moneda && /^[A-Za-z]{3}$/.test(moneda)) resultado.moneda = moneda.toUpperCase();

  const numeroVuelo = texto('numeroVuelo');
  if (numeroVuelo) resultado.numeroVuelo = numeroVuelo;

  const asiento = texto('asiento');
  if (asiento) resultado.asiento = asiento;

  const habitacion = texto('habitacion');
  if (habitacion) resultado.habitacion = habitacion;

  const vehiculo = texto('vehiculo');
  if (vehiculo) resultado.vehiculo = vehiculo;

  const notas = texto('notas');
  if (notas) resultado.notas = notas;

  return resultado;
}

/** Arma el objeto `detalle` preservando campos previos que el formulario no toca. */
export function construirDetalleReserva(campos: {
  precio: string;
  moneda: string;
  notas: string;
  base?: unknown;
}): Record<string, unknown> {
  const resultado: Record<string, unknown> =
    campos.base && typeof campos.base === 'object'
      ? { ...(campos.base as Record<string, unknown>) }
      : {};

  const precioTexto = campos.precio.trim().replace(',', '.');
  if (precioTexto.length > 0) {
    resultado.precio = Number(precioTexto);
    delete resultado.monto;
    delete resultado.importe;
  } else {
    delete resultado.precio;
    delete resultado.monto;
    delete resultado.importe;
  }

  const monedaLimpia = campos.moneda.trim().toUpperCase();
  if (monedaLimpia.length === 3) {
    resultado.moneda = monedaLimpia;
  } else {
    delete resultado.moneda;
  }

  const notasLimpias = campos.notas.trim();
  if (notasLimpias.length > 0) {
    resultado.notas = notasLimpias;
  } else {
    delete resultado.notas;
  }

  return resultado;
}

/**
 * openapi-typescript tipa un `type: object` libre como `Record<string, never>`. Este adaptador
 * acota la conversión en un solo punto sin modificar `specs/openapi/viajes.yaml`.
 */
function aDetalleContrato(objeto: Record<string, unknown>): Record<string, never> {
  return objeto as Record<string, never>;
}

function detallesIguales(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const clavesA = Object.keys(a).sort();
  const clavesB = Object.keys(b).sort();
  if (clavesA.length !== clavesB.length) return false;
  return clavesA.every((c, idx) => c === clavesB[idx] && a[c] === b[c]);
}

export interface PropsReservaTarjeta {
  reserva: Reserva;
  editable?: boolean;
  ocupado?: boolean;
  alEditar?: (reserva: Reserva) => void;
  alEliminar?: (reserva: Reserva) => Promise<void> | void;
}

export function ReservaTarjeta({
  reserva,
  editable = false,
  ocupado = false,
  alEditar,
  alEliminar,
}: PropsReservaTarjeta) {
  const { t } = useTranslation();
  const idioma = useIdioma();
  const [confirmandoBaja, setConfirmandoBaja] = useState(false);
  const detalle = leerDetalleReserva(reserva.detalle);

  const precioFormateado =
    detalle.precio !== undefined
      ? formatearMoneda(detalle.precio, idioma, detalle.moneda)
      : undefined;

  const extras: string[] = [];
  if (detalle.numeroVuelo) extras.push(t('reserva.detalleVuelo', { valor: detalle.numeroVuelo }));
  if (detalle.asiento) extras.push(t('reserva.detalleAsiento', { valor: detalle.asiento }));
  if (detalle.habitacion)
    extras.push(t('reserva.detalleHabitacion', { valor: detalle.habitacion }));
  if (detalle.vehiculo) extras.push(t('reserva.detalleVehiculo', { valor: detalle.vehiculo }));

  return (
    <li
      className={`item-fila reserva-item reserva-${reserva.estado}`}
      data-testid={`reserva-${reserva.numeroReserva}`}
    >
      <div className="item-datos">
        <div className="item-cabecera">
          <strong>
            {t(`viaje.tipos.${reserva.tipoReserva}`)} · {reserva.proveedor}
          </strong>
          <span
            className={`estado estado-${reserva.estado}`}
            data-testid={`estado-reserva-${reserva.numeroReserva}`}
          >
            {t(`viaje.estadosReserva.${reserva.estado}`)}
          </span>
        </div>
        <span>
          {reserva.origen
            ? t('viaje.ruta', { origen: reserva.origen, destino: reserva.destino })
            : reserva.destino}
        </span>
        <div className="reserva-meta">
          <small>{t('viaje.codigoReserva', { codigo: reserva.numeroReserva })}</small>
          {precioFormateado && (
            <strong
              className="reserva-precio"
              data-testid={`precio-reserva-${reserva.numeroReserva}`}
            >
              {precioFormateado}
            </strong>
          )}
        </div>
        <small>
          {t('panel.fechas', {
            inicio: formatearFecha(reserva.inicio, idioma, {
              dateStyle: 'short',
              timeStyle: 'short',
            }),
            fin: formatearFecha(reserva.fin, idioma, {
              dateStyle: 'short',
              timeStyle: 'short',
            }),
          })}
        </small>
        {extras.length > 0 && <small>{extras.join(' · ')}</small>}
        {detalle.notas && <small>{t('reserva.detalleNotas', { valor: detalle.notas })}</small>}
        <small>
          {t('reserva.origenEtiqueta', {
            origen: t(`reserva.origenCambio.${reserva.origenCambio}`),
          })}
        </small>
      </div>

      {editable && (
        <div className="acciones-reserva">
          {confirmandoBaja ? (
            <div className="confirmacion-inline" role="group">
              <span className="nota">
                {t('reserva.preguntaEliminar', { codigo: reserva.numeroReserva })}
              </span>
              <div className="acciones-fila">
                <button
                  type="button"
                  className="peligro"
                  disabled={ocupado}
                  onClick={() => {
                    setConfirmandoBaja(false);
                    void alEliminar?.(reserva);
                  }}
                >
                  {t('reserva.confirmarEliminar')}
                </button>
                <button
                  type="button"
                  className="secundario"
                  disabled={ocupado}
                  onClick={() => setConfirmandoBaja(false)}
                >
                  {t('reserva.cancelar')}
                </button>
              </div>
            </div>
          ) : (
            <div className="acciones-fila">
              {alEditar && (
                <button
                  type="button"
                  className="secundario"
                  disabled={ocupado}
                  aria-label={t('reserva.editarReserva', { codigo: reserva.numeroReserva })}
                  onClick={() => alEditar(reserva)}
                >
                  {t('reserva.editar')}
                </button>
              )}
              {alEliminar && (
                <button
                  type="button"
                  className="secundario peligro-texto"
                  disabled={ocupado}
                  aria-label={t('reserva.eliminarReserva', { codigo: reserva.numeroReserva })}
                  onClick={() => setConfirmandoBaja(true)}
                >
                  {t('reserva.eliminar')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export interface PropsReservaFormulario {
  modo: 'alta' | 'edicion';
  reservaInicial?: Reserva;
  viajeFijoId?: string;
  viajesActivos?: readonly Viaje[];
  alGuardar: (reserva: Reserva) => Promise<void> | void;
  alCancelar: () => void;
}

export function ReservaFormulario({
  modo,
  reservaInicial,
  viajeFijoId,
  viajesActivos = [],
  alGuardar,
  alCancelar,
}: PropsReservaFormulario) {
  const { t } = useTranslation();
  const { api } = useApp();
  const idioma = useIdioma();

  const detalleInicial = leerDetalleReserva(reservaInicial?.detalle);

  const [tipoReserva, setTipoReserva] = useState<TipoReserva>(
    reservaInicial?.tipoReserva ?? 'vuelo',
  );
  const [proveedor, setProveedor] = useState(reservaInicial?.proveedor ?? 'aerolinea-andina');
  const [numeroReserva, setNumeroReserva] = useState(reservaInicial?.numeroReserva ?? '');
  const [origen, setOrigen] = useState(reservaInicial?.origen ?? '');
  const [destino, setDestino] = useState(reservaInicial?.destino ?? '');
  const [inicio, setInicio] = useState(
    reservaInicial ? aInputFechaHora(reservaInicial.inicio) : '',
  );
  const [fin, setFin] = useState(reservaInicial ? aInputFechaHora(reservaInicial.fin) : '');
  const [viajeId, setViajeId] = useState(viajeFijoId ?? reservaInicial?.viajeId ?? '');
  const [estado, setEstado] = useState<EstadoReserva>(reservaInicial?.estado ?? 'confirmada');
  const [precio, setPrecio] = useState(
    detalleInicial.precio !== undefined ? String(detalleInicial.precio) : '',
  );
  const [moneda, setMoneda] = useState(detalleInicial.moneda ?? '');
  const [notas, setNotas] = useState(detalleInicial.notas ?? '');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string>();

  const mostrarOrigen = tipoReserva !== 'hotel';
  const monedas =
    moneda && !MONEDAS_SUGERIDAS.includes(moneda as (typeof MONEDAS_SUGERIDAS)[number])
      ? [...MONEDAS_SUGERIDAS, moneda]
      : [...MONEDAS_SUGERIDAS];

  const enviar = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(undefined);

    const origenLimpio = origen.trim();
    const destinoLimpio = destino.trim();
    const inicioIso = desdeInputFechaHora(inicio);
    const finIso = desdeInputFechaHora(fin);

    if (tipoReserva === 'vuelo' && !origenLimpio) {
      setError('reserva.errorOrigenVuelo');
      return;
    }
    if (!inicioIso || !finIso || new Date(finIso).getTime() < new Date(inicioIso).getTime()) {
      setError('reserva.errorFechas');
      return;
    }

    const precioTexto = precio.trim().replace(',', '.');
    if (precioTexto.length > 0) {
      const numero = Number(precioTexto);
      if (!Number.isFinite(numero) || numero < 0) {
        setError('reserva.errorPrecio');
        return;
      }
    }

    setGuardando(true);
    try {
      if (modo === 'alta') {
        const detalleObj = construirDetalleReserva({ precio, moneda, notas });
        const cuerpo: NuevaReserva = {
          ...(viajeId ? { viajeId } : {}),
          proveedor: proveedor.trim(),
          tipoReserva,
          numeroReserva: numeroReserva.trim(),
          inicio: inicioIso,
          fin: finIso,
          ...(mostrarOrigen && origenLimpio ? { origen: origenLimpio } : {}),
          destino: destinoLimpio,
          ...(Object.keys(detalleObj).length > 0 ? { detalle: aDetalleContrato(detalleObj) } : {}),
        };

        const { data, response } = await api.viajes.POST('/reservas', { body: cuerpo });
        if (!data) {
          setError(
            response.status === 409
              ? 'reserva.errorConflictoAlta'
              : claveErrorHttp(response.status),
          );
          return;
        }
        await alGuardar(data);
        return;
      }

      if (!reservaInicial) return;
      const cambios: CambioReserva = {};
      if (viajeId && viajeId !== reservaInicial.viajeId) cambios.viajeId = viajeId;
      if (inicio !== aInputFechaHora(reservaInicial.inicio)) cambios.inicio = inicioIso;
      if (fin !== aInputFechaHora(reservaInicial.fin)) cambios.fin = finIso;
      if (mostrarOrigen && origenLimpio && origenLimpio !== (reservaInicial.origen ?? '')) {
        cambios.origen = origenLimpio;
      }
      if (destinoLimpio !== reservaInicial.destino) cambios.destino = destinoLimpio;
      if (estado !== reservaInicial.estado) cambios.estado = estado;

      const detalleBase =
        reservaInicial.detalle && typeof reservaInicial.detalle === 'object'
          ? (reservaInicial.detalle as Record<string, unknown>)
          : {};
      const detalleNuevo = construirDetalleReserva({ precio, moneda, notas, base: detalleBase });
      if (!detallesIguales(detalleBase, detalleNuevo)) {
        cambios.detalle = aDetalleContrato(detalleNuevo);
      }

      if (Object.keys(cambios).length === 0) {
        setError('reserva.errorSinCambios');
        return;
      }

      const { data, response } = await api.viajes.PATCH('/reservas/{reservaId}', {
        params: { path: { reservaId: reservaInicial.reservaId } },
        body: cambios,
      });
      if (!data) {
        setError(
          response.status === 409
            ? 'reserva.errorConflictoEdicion'
            : claveErrorHttp(response.status),
        );
        return;
      }
      await alGuardar(data);
    } catch {
      setError('errores.noDisponible');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <section className="tarjeta" aria-labelledby="titulo-form-reserva">
      <h2 id="titulo-form-reserva">
        {modo === 'alta' ? t('reserva.tituloAlta') : t('reserva.tituloEdicion')}
      </h2>

      {modo === 'edicion' && reservaInicial && (
        <p className="nota">
          {t(`viaje.tipos.${reservaInicial.tipoReserva}`)} · {reservaInicial.proveedor} ·{' '}
          {t('viaje.codigoReserva', { codigo: reservaInicial.numeroReserva })}
        </p>
      )}

      <form className="formulario" onSubmit={(e) => void enviar(e)}>
        {modo === 'alta' && (
          <div className="formulario-grid">
            <label>
              <span>{t('reserva.tipo')}</span>
              <select
                name="tipoReserva"
                value={tipoReserva}
                disabled={guardando}
                onChange={(e) => setTipoReserva(e.target.value as TipoReserva)}
              >
                {TIPOS_RESERVA.map((tipo) => (
                  <option key={tipo} value={tipo}>
                    {t(`viaje.tipos.${tipo}`)}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>{t('reserva.proveedor')}</span>
              <input
                name="proveedor"
                type="text"
                list="proveedores-trotamundos"
                required
                value={proveedor}
                placeholder={t('reserva.proveedorPlaceholder')}
                disabled={guardando}
                onChange={(e) => setProveedor(e.target.value)}
              />
              <datalist id="proveedores-trotamundos">
                {PROVEEDORES_SUGERIDOS.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </label>

            <label>
              <span>{t('reserva.numeroReserva')}</span>
              <input
                name="numeroReserva"
                type="text"
                required
                value={numeroReserva}
                placeholder={t('reserva.numeroPlaceholder')}
                disabled={guardando}
                onChange={(e) => setNumeroReserva(e.target.value)}
              />
            </label>
          </div>
        )}

        <div className="formulario-grid">
          {mostrarOrigen && (
            <label>
              <span>{t('reserva.origen')}</span>
              <input
                name="origen"
                type="text"
                value={origen}
                placeholder={
                  tipoReserva === 'vuelo'
                    ? t('reserva.origenVueloPlaceholder')
                    : t('reserva.origenAutoPlaceholder')
                }
                disabled={guardando}
                onChange={(e) => setOrigen(e.target.value)}
              />
            </label>
          )}

          <label>
            <span>{t('reserva.destino')}</span>
            <input
              name="destino"
              type="text"
              required
              value={destino}
              placeholder={t('reserva.destinoPlaceholder')}
              disabled={guardando}
              onChange={(e) => setDestino(e.target.value)}
            />
          </label>
        </div>

        <div className="formulario-grid">
          <label>
            <span>{t('reserva.inicio')}</span>
            <input
              name="inicio"
              type="datetime-local"
              required
              value={inicio}
              disabled={guardando}
              onChange={(e) => setInicio(e.target.value)}
            />
          </label>

          <label>
            <span>{t('reserva.fin')}</span>
            <input
              name="fin"
              type="datetime-local"
              required
              value={fin}
              disabled={guardando}
              onChange={(e) => setFin(e.target.value)}
            />
          </label>
        </div>

        <div className="formulario-grid">
          {modo === 'edicion' && (
            <div className="campo">
              <label htmlFor="reserva-estado">{t('reserva.estado')}</label>
              <select
                id="reserva-estado"
                name="estado"
                value={estado}
                disabled={guardando}
                onChange={(e) => setEstado(e.target.value as EstadoReserva)}
              >
                {ESTADOS_RESERVA.map((item) => (
                  <option key={item} value={item}>
                    {t(`viaje.estadosReserva.${item}`)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {!viajeFijoId && viajesActivos.length > 0 && (
            <div className="campo">
              <label htmlFor="reserva-viaje">{t('reserva.viaje')}</label>
              <select
                id="reserva-viaje"
                name="viajeId"
                value={viajeId}
                disabled={guardando}
                onChange={(e) => setViajeId(e.target.value)}
              >
                {modo === 'alta' && <option value="">{t('reserva.agruparAutomatico')}</option>}
                {viajesActivos.map((v) => (
                  <option key={v.viajeId} value={v.viajeId}>
                    {v.destino} ({formatearFecha(v.inicio, idioma)})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="formulario-grid">
          <label>
            <span>{t('reserva.precio')}</span>
            <input
              name="precio"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={precio}
              placeholder={t('reserva.precioPlaceholder')}
              disabled={guardando}
              onChange={(e) => setPrecio(e.target.value)}
            />
          </label>

          <div className="campo">
            <label htmlFor="reserva-moneda">{t('reserva.moneda')}</label>
            <select
              id="reserva-moneda"
              name="moneda"
              value={moneda}
              disabled={guardando}
              onChange={(e) => setMoneda(e.target.value)}
            >
              <option value="">{t('reserva.monedaDefecto')}</option>
              {monedas.map((codigo) => (
                <option key={codigo} value={codigo}>
                  {t(`preferencias.monedas.${codigo}`, { defaultValue: codigo })}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label>
          <span>{t('reserva.notas')}</span>
          <input
            name="notas"
            type="text"
            value={notas}
            placeholder={t('reserva.notasPlaceholder')}
            disabled={guardando}
            onChange={(e) => setNotas(e.target.value)}
          />
        </label>

        {error && (
          <p role="alert" className="mensaje error">
            {t(error)}
          </p>
        )}

        <div className="acciones-fila">
          <button type="submit" disabled={guardando}>
            {guardando
              ? t('reserva.guardando')
              : modo === 'alta'
                ? t('reserva.guardarAlta')
                : t('reserva.guardarEdicion')}
          </button>
          <button type="button" className="secundario" disabled={guardando} onClick={alCancelar}>
            {t('reserva.cancelar')}
          </button>
        </div>
      </form>
    </section>
  );
}
