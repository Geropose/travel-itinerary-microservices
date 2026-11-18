// Llamadas de Autenticación a otros servicios, con su propio token de servicio:
// - Usuarios de la región: POST /interna/cuentas en el registro;
// - Autenticación de la otra región: GET /interna/cuentas/existe (ADR-017). Solo dice sí o no: los
//   datos de la cuenta no salen de su región (CONST-6).
import { crearClienteHttp, ErrorRespuestaHttp, type Region } from '@trotamundos/comun';

export interface NuevaCuenta {
  usuarioId: string;
  email: string;
  nombre: string;
  region: Region;
  idioma: string;
}

export interface Usuarios {
  /** Crea la cuenta. Lanza un error si Usuarios no la crea (y entonces se deshace el registro). */
  crearCuenta(cuenta: NuevaCuenta): Promise<void>;
}

export interface OtraRegion {
  region: Region;
  /** true si la cuenta existe en la otra región. Lanza un error si la otra región no responde. */
  existeCuenta(email: string): Promise<boolean>;
}

export interface OpcionesClientes {
  urlUsuarios: string;
  urlOtraRegion: string;
  otraRegion: Region;
  /** Token de servicio propio (tokens.ts tokenDeServicioPropio). */
  token: () => Promise<string>;
  fetch?: typeof fetch;
}

export function crearUsuarios(opciones: OpcionesClientes): Usuarios {
  const cliente = crearClienteHttp({ urlBase: opciones.urlUsuarios, fetch: opciones.fetch });
  return {
    async crearCuenta(cuenta) {
      await cliente.post('/interna/cuentas', cuenta, { token: await opciones.token() });
    },
  };
}

export function crearOtraRegion(opciones: OpcionesClientes): OtraRegion {
  const cliente = crearClienteHttp({ urlBase: opciones.urlOtraRegion, fetch: opciones.fetch });
  return {
    region: opciones.otraRegion,
    async existeCuenta(email) {
      const { datos } = await cliente.get<{ existe: boolean }>('/interna/cuentas/existe', {
        query: { email },
        token: await opciones.token(),
      });
      return datos.existe;
    },
  };
}

/** Status que devolvió el otro servicio, si llegó a responder. */
export function statusDe(error: unknown): number | undefined {
  return error instanceof ErrorRespuestaHttp ? error.status : undefined;
}
