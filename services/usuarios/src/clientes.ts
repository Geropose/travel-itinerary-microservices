// Llamadas de Usuarios a otros servicios:
// - Viajes de la región: GET /interna/viajes/{viajeId}/dueno con el JWT del usuario propagado
//   (ADR-019), para verificar que quien gestiona designados es el dueño del viaje.
import { crearClienteHttp, errores, ErrorRespuestaHttp, type Logger } from '@trotamundos/comun';

export interface Viajes {
  /** true si el usuario del JWT es el dueño del viaje. Lanza 404 si no existe o 503 si falla. */
  esDueno(viajeId: string, token: string): Promise<boolean>;
}

export interface OpcionesClientes {
  urlViajes: string;
  logger: Logger;
  fetch?: typeof fetch;
}

export function crearViajes(opciones: OpcionesClientes): Viajes {
  const cliente = crearClienteHttp({ urlBase: opciones.urlViajes, fetch: opciones.fetch });
  return {
    async esDueno(viajeId, token) {
      try {
        const { datos } = await cliente.get<{ esDueno: boolean }>(
          `/interna/viajes/${encodeURIComponent(viajeId)}/dueno`,
          { token },
        );
        return datos.esDueno === true;
      } catch (error) {
        if (error instanceof ErrorRespuestaHttp && error.status === 404) {
          throw errores.noEncontrado('El viaje no existe.');
        }
        opciones.logger.warn({ err: error, viajeId }, 'No se pudo consultar el dueño del viaje');
        throw errores.noDisponible('No se pudo verificar el dueño del viaje.');
      }
    },
  };
}
