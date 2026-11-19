import {
  ErrorDependenciaNoDisponible,
  ErrorOpcionRechazada,
  type ClienteIntegraciones,
  type ClienteViajes,
  type OpcionDeIntegraciones,
  type ReservaDeViajes,
} from '../clientes.ts';
import { interpolarTexto, type IdiomaAsistente } from '../reglas.ts';
import {
  extraerCodigoReserva,
  formatearFechaHora,
  type OpcionReprogramacion,
  type PluginConsulta,
} from './tipos.ts';

function describirCosto(costo: { monto: string; moneda: string }, idioma: IdiomaAsistente): string {
  if (Number(costo.monto) === 0) {
    return idioma === 'en' ? 'no fee' : 'sin cargo';
  }
  return `${costo.moneda} ${costo.monto}`;
}

function traducirOpcion(
  oferta: OpcionDeIntegraciones,
  reserva: ReservaDeViajes,
  idioma: IdiomaAsistente,
): OpcionReprogramacion {
  const fechaTexto = formatearFechaHora(oferta.inicio, idioma);
  const vuelo = oferta.detalle?.numeroVuelo ? `${oferta.detalle.numeroVuelo}, ` : '';
  const costoTexto = describirCosto(oferta.costo, idioma);
  return {
    opcionId: oferta.opcionId,
    proveedor: reserva.proveedor,
    numeroReserva: reserva.numeroReserva,
    tipoReserva: reserva.tipoReserva,
    inicio: oferta.inicio,
    fin: oferta.fin,
    ...(reserva.tipoReserva === 'vuelo' && (oferta.origen ?? reserva.origen)
      ? { origen: oferta.origen ?? reserva.origen }
      : {}),
    destino: oferta.destino ?? reserva.destino,
    descripcion: `${vuelo}${fechaTexto}, ${costoTexto}`,
  };
}

/**
 * Plug-in de reprogramación (Iteración 7, ADR-018, ADR-019, QA-9).
 * - Paso 1 (`atender`): verifica que la reserva pertenezca al usuario consultando Viajes con su
 *   JWT, pide opciones a Integraciones y las devuelve sin aplicar nada todavía.
 * - Paso 2 (`confirmar`): solo cuando el usuario confirma una opción pendiente, pide aplicarla a
 *   Integraciones (nunca una opción inventada).
 */
export function crearPluginReprogramacion(dependencias: {
  viajes: ClienteViajes;
  integraciones: ClienteIntegraciones;
}): PluginConsulta {
  const { viajes, integraciones } = dependencias;

  return {
    intencion: 'reprogramar',

    async atender(contexto, mensaje) {
      let reservas: ReservaDeViajes[];
      try {
        reservas = await viajes.listarReservas(contexto.usuarioId, contexto.token);
      } catch (error) {
        const servicio = error instanceof ErrorDependenciaNoDisponible ? error.servicio : 'viajes';
        return {
          texto: contexto.reglas.textos.noDisponibleReprogramar,
          resultado: 'noDisponible',
          noDisponible: { funcion: 'reprogramar', servicio },
          ofreceDerivar: true,
        };
      }

      if (reservas.length === 0) {
        return {
          texto: contexto.reglas.textos.reprogramacionSinReservas,
          resultado: 'respondido',
        };
      }

      const codigo = extraerCodigoReserva(mensaje);
      let elegida: ReservaDeViajes | undefined;

      if (codigo) {
        elegida = reservas.find((r) => r.numeroReserva.toUpperCase() === codigo.toUpperCase());
        if (!elegida) {
          return {
            texto: interpolarTexto(contexto.reglas.textos.reservaNoEncontrada, {
              numeroReserva: codigo,
            }),
            resultado: 'respondido',
          };
        }
      } else {
        const vuelos = reservas.filter((r) => r.tipoReserva === 'vuelo');
        if (vuelos.length === 1) {
          elegida = vuelos[0];
        } else if (reservas.length === 1) {
          elegida = reservas[0];
        } else {
          const ejemplo = (vuelos[0] ?? reservas[0])?.numeroReserva ?? 'XKQ7PL';
          return {
            texto: interpolarTexto(contexto.reglas.textos.pedirNumeroReprogramacion, { ejemplo }),
            resultado: 'respondido',
          };
        }
      }

      if (!elegida) {
        return {
          texto: contexto.reglas.textos.reprogramacionSinReservas,
          resultado: 'respondido',
        };
      }

      let ofertas: OpcionDeIntegraciones[];
      try {
        ofertas = await integraciones.pedirOpcionesReprogramacion(
          elegida.proveedor,
          elegida.numeroReserva,
          contexto.token,
        );
      } catch (error) {
        const servicio =
          error instanceof ErrorDependenciaNoDisponible ? error.servicio : 'integraciones';
        return {
          texto: contexto.reglas.textos.noDisponibleReprogramar,
          resultado: 'noDisponible',
          noDisponible: { funcion: 'reprogramar', servicio },
          ofreceDerivar: true,
        };
      }

      if (ofertas.length === 0) {
        return {
          texto: interpolarTexto(contexto.reglas.textos.sinOpcionesReprogramacion, {
            numeroReserva: elegida.numeroReserva,
          }),
          resultado: 'respondido',
          ofreceDerivar: true,
        };
      }

      const opciones = ofertas.map((o) => traducirOpcion(o, elegida, contexto.idioma));
      return {
        texto: contexto.reglas.textos.opcionesEncontradas,
        resultado: 'opciones',
        opciones,
      };
    },

    async confirmar(contexto, opcion) {
      try {
        await integraciones.aplicarReprogramacion(
          opcion.proveedor,
          opcion.numeroReserva,
          opcion.opcionId,
          contexto.token,
        );
      } catch (error) {
        if (error instanceof ErrorOpcionRechazada) {
          return {
            texto: contexto.reglas.textos.opcionRechazada,
            resultado: 'opcionRechazada',
            ofreceDerivar: true,
          };
        }
        const servicio =
          error instanceof ErrorDependenciaNoDisponible ? error.servicio : 'integraciones';
        return {
          texto: contexto.reglas.textos.noDisponibleReprogramar,
          resultado: 'noDisponible',
          noDisponible: { funcion: 'reprogramar', servicio },
          ofreceDerivar: true,
        };
      }

      return {
        texto: interpolarTexto(contexto.reglas.textos.reprogramadoOk, {
          numeroReserva: opcion.numeroReserva,
          inicio: formatearFechaHora(opcion.inicio, contexto.idioma),
        }),
        resultado: 'reprogramado',
      };
    },
  };
}
