import { ErrorDependenciaNoDisponible, type ClienteViajes } from '../clientes.ts';
import { interpolarTexto, normalizarTexto } from '../reglas.ts';
import {
  etiquetaEstadoReserva,
  etiquetaTipoReserva,
  extraerCodigoReserva,
  formatearFechaHora,
  type PluginConsulta,
  type ReservaResumen,
} from './tipos.ts';

function filtrarPorTipo(
  reservas: ReservaResumen[],
  textoNorm: string,
): ReservaResumen[] | undefined {
  if (/\b(vuelo|vuelos|flight|flights)\b/.test(textoNorm)) {
    return reservas.filter((r) => r.tipoReserva === 'vuelo');
  }
  if (/\b(hotel|hoteles|alojamiento|hotels)\b/.test(textoNorm)) {
    return reservas.filter((r) => r.tipoReserva === 'hotel');
  }
  if (/\b(auto|autos|coche|rentadora|car|cars)\b/.test(textoNorm)) {
    return reservas.filter((r) => r.tipoReserva === 'auto');
  }
  return undefined;
}

/**
 * Plug-in de consulta de estado (Iteración 7, ADR-018, QA-9).
 * Consulta únicamente las reservas del usuario autenticado en el Servicio de Viajes propagando su JWT.
 */
export function crearPluginEstado(viajes: ClienteViajes): PluginConsulta {
  return {
    intencion: 'estado',

    async atender(contexto, mensaje) {
      let todas;
      try {
        todas = await viajes.listarReservas(contexto.usuarioId, contexto.token);
      } catch (error) {
        const servicio = error instanceof ErrorDependenciaNoDisponible ? error.servicio : 'viajes';
        return {
          texto: contexto.reglas.textos.noDisponibleEstado,
          resultado: 'noDisponible',
          noDisponible: { funcion: 'estado', servicio },
          ofreceDerivar: true,
        };
      }

      const resumenes: ReservaResumen[] = todas.map((r) => ({
        proveedor: r.proveedor,
        numeroReserva: r.numeroReserva,
        tipoReserva: r.tipoReserva,
        estado: r.estado,
        inicio: r.inicio,
        fin: r.fin,
        ...(r.tipoReserva === 'vuelo' && r.origen ? { origen: r.origen } : {}),
        destino: r.destino,
      }));

      const codigoPedido = extraerCodigoReserva(mensaje);
      if (codigoPedido) {
        const encontrada = resumenes.find(
          (r) => r.numeroReserva.toUpperCase() === codigoPedido.toUpperCase(),
        );
        if (!encontrada) {
          return {
            texto: interpolarTexto(contexto.reglas.textos.reservaNoEncontrada, {
              numeroReserva: codigoPedido,
            }),
            resultado: 'respondido',
            reservas: [],
          };
        }
        const ruta = encontrada.origen
          ? `${encontrada.origen} → ${encontrada.destino}`
          : encontrada.destino;
        return {
          texto: interpolarTexto(contexto.reglas.textos.estadoUnicaReserva, {
            tipo: etiquetaTipoReserva(encontrada.tipoReserva, contexto.idioma),
            numeroReserva: encontrada.numeroReserva,
            ruta,
            inicio: formatearFechaHora(encontrada.inicio, contexto.idioma, contexto.zonaHoraria),
            estado: etiquetaEstadoReserva(encontrada.estado, contexto.idioma),
          }),
          resultado: 'respondido',
          reservas: [encontrada],
        };
      }

      if (resumenes.length === 0) {
        return {
          texto: contexto.reglas.textos.sinReservas,
          resultado: 'respondido',
          reservas: [],
        };
      }

      const filtradasPorTipo = filtrarPorTipo(resumenes, normalizarTexto(mensaje));
      const seleccionadas =
        filtradasPorTipo && filtradasPorTipo.length > 0 ? filtradasPorTipo : resumenes;

      if (seleccionadas.length === 1) {
        const unica = seleccionadas[0];
        if (unica) {
          const ruta = unica.origen ? `${unica.origen} → ${unica.destino}` : unica.destino;
          return {
            texto: interpolarTexto(contexto.reglas.textos.estadoUnicaReserva, {
              tipo: etiquetaTipoReserva(unica.tipoReserva, contexto.idioma),
              numeroReserva: unica.numeroReserva,
              ruta,
              inicio: formatearFechaHora(unica.inicio, contexto.idioma, contexto.zonaHoraria),
              estado: etiquetaEstadoReserva(unica.estado, contexto.idioma),
            }),
            resultado: 'respondido',
            reservas: [unica],
          };
        }
      }

      const lineas = seleccionadas.map((r) => {
        const ruta = r.origen ? `${r.origen} → ${r.destino}` : r.destino;
        return `- ${etiquetaTipoReserva(r.tipoReserva, contexto.idioma)} ${r.numeroReserva} (${ruta}, ${formatearFechaHora(r.inicio, contexto.idioma, contexto.zonaHoraria)}): ${etiquetaEstadoReserva(r.estado, contexto.idioma)}`;
      });

      return {
        texto: `${contexto.reglas.textos.estadoEncabezado}\n${lineas.join('\n')}`,
        resultado: 'respondido',
        reservas: seleccionadas,
      };
    },
  };
}
