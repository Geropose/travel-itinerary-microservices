import { crearClienteHttp, errores, ErrorHttp, ErrorRespuestaHttp } from '@trotamundos/comun';

export interface PerfilUsuario {
  usuarioId: string;
  email: string;
  nombre: string;
  agenciaPreferida: string | null;
}

export interface ClienteUsuarios {
  obtenerPerfil(token: string): Promise<PerfilUsuario>;
}

export interface OpcionesClienteUsuarios {
  urlBase: string;
  tiempoMaximoMs?: number;
  fetch?: typeof fetch;
}

/**
 * Cliente HTTP hacia el Servicio de Usuarios (GET /perfil propagando el JWT del usuario, ADR-019)
 * para resolver la agencia preferida y los datos de contacto en `POST /agencias/casos`.
 */
export function crearClienteUsuarios(opciones: OpcionesClienteUsuarios): ClienteUsuarios {
  const http = crearClienteHttp({
    urlBase: opciones.urlBase,
    tiempoMaximoMs: opciones.tiempoMaximoMs ?? 2000,
    ...(opciones.fetch ? { fetch: opciones.fetch } : {}),
  });

  return {
    async obtenerPerfil(token) {
      try {
        const { datos } = await http.get<PerfilUsuario>('/perfil', { token });
        return datos;
      } catch (error) {
        if (error instanceof ErrorRespuestaHttp && error.status < 500) {
          if (error.status === 401) throw errores.noAutenticado();
          if (error.status === 403) throw errores.prohibido();
          if (error.status === 404) throw errores.noEncontrado('El usuario no existe.');
          throw new ErrorHttp({
            status: error.status,
            tipo: 'solicitud-invalida',
            titulo: 'Solicitud inválida',
            detalle: 'El Servicio de Usuarios rechazó la consulta del perfil.',
          });
        }
        throw new ErrorHttp({
          status: 503,
          tipo: 'tercero-no-disponible',
          titulo: 'Tercero no disponible',
          detalle: 'No se pudo consultar el perfil del usuario para contactar a su agencia.',
        });
      }
    },
  };
}
