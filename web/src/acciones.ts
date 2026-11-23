// Inicio de sesión, registro y cierre de sesión (autenticacion.yaml). Las pantallas solo muestran
// el resultado.
import type { Api } from './api/cliente.ts';
import type { components } from './api/generado/autenticacion.ts';
import type { Almacen, Claims, Sesion } from './api/sesion.ts';
import { borrarPanel } from './cache/panel.ts';
import { cambiarIdioma } from './idiomas/i18n.ts';

export type ErrorAcceso =
  'credenciales' | 'bloqueado' | 'emailUsado' | 'noDisponible' | 'inesperado';
export type Resultado = { ok: true } | { ok: false; error: ErrorAcceso };

type SolicitudRegistro = components['schemas']['SolicitudRegistro'];

function errorDe(status: number | undefined): ErrorAcceso {
  switch (status) {
    case 401:
      return 'credenciales';
    case 429:
      return 'bloqueado';
    case 409:
      return 'emailUsado';
    case undefined:
    case 502:
    case 503:
    case 504:
      return 'noDisponible';
    default:
      return 'inesperado';
  }
}

/**
 * Inicia sesión. El enrutador global elige la región con X-Region (la recordada) y, si la cuenta
 * es de la otra, la reenvía: la respuesta trae la región de la cuenta, que se recuerda.
 */
export async function iniciarSesion(
  api: Api,
  sesion: Sesion,
  almacen: Almacen,
  email: string,
  contrasena: string,
): Promise<Resultado> {
  try {
    const { data, response } = await api.autenticacion.POST('/login', {
      body: { email, contrasena },
    });
    if (!data) {
      return {
        ok: false,
        error: response.status === 400 ? 'credenciales' : errorDe(response.status),
      };
    }
    sesion.guardar(data);
    // La interfaz pasa al idioma de la cuenta.
    const idioma = sesion.claims()?.idioma;
    if (idioma) cambiarIdioma(idioma, almacen);
    return { ok: true };
  } catch {
    return { ok: false, error: 'noDisponible' };
  }
}

/** Crea la cuenta en la región elegida y después inicia sesión. */
export async function registrarse(
  api: Api,
  sesion: Sesion,
  almacen: Almacen,
  datos: SolicitudRegistro,
): Promise<Resultado> {
  // La región elegida es donde se guardan los datos (CONST-6): X-Region manda la solicitud ahí.
  try {
    sesion.recordarRegion(datos.region);
  } catch {
    // Si falla el almacenamiento local, se intenta igual con el valor por defecto del servidor.
  }
  try {
    const { data, response } = await api.autenticacion.POST('/registro', { body: datos });
    if (!data) return { ok: false, error: errorDe(response.status) };
  } catch {
    return { ok: false, error: 'noDisponible' };
  }
  return iniciarSesion(api, sesion, almacen, datos.email, datos.contrasena);
}

/** Cierra la sesión: revoca el token de renovación y borra el panel guardado del usuario. */
export async function cerrarSesion(
  api: Api,
  sesion: Sesion,
  claims: Claims | undefined,
  tiempoMaximoLogoutMs = 3_000,
) {
  try {
    const datos = sesion.obtener();
    if (datos) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        api.autenticacion
          .POST('/logout', {
            body: { tokenRenovacion: datos.tokenRenovacion },
            signal: AbortSignal.timeout(tiempoMaximoLogoutMs),
          })
          .catch(() => undefined),
        new Promise<void>((resolver) => {
          timer = setTimeout(resolver, tiempoMaximoLogoutMs);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    }
  } finally {
    if (claims) await borrarPanel(claims.sub).catch(() => undefined);
    sesion.cerrar();
  }
}
