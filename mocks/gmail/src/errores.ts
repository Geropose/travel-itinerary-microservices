// Formato de error de la Gmail API (specs/externos/gmail.md, sección 1.5) y de /token (RFC 6749,
// sección 5.2, sección 1.4).

export interface ErrorGmail {
  error: {
    errors: { domain: string; reason: string; message: string; [extra: string]: string }[];
    code: number;
    message: string;
  };
}

export function errorGmail(
  codigo: number,
  mensaje: string,
  reason: string,
  extra: Record<string, string> = {},
  domain = 'global',
): ErrorGmail {
  return {
    error: {
      errors: [{ domain, reason, message: mensaje, ...extra }],
      code: codigo,
      message: mensaje,
    },
  };
}

/** 401 de un token vencido, inválido o sin el scope gmail.readonly. */
export const credencialesInvalidas = () =>
  errorGmail(401, 'Invalid Credentials', 'authError', {
    locationType: 'header',
    location: 'Authorization',
  });

/** 429 al superar la cuota por usuario (QA-7). */
export const limiteSuperado = () =>
  errorGmail(429, 'User-rate limit exceeded.', 'rateLimitExceeded', {}, 'usageLimits');

export const noEncontrado = () => errorGmail(404, 'Requested entity was not found.', 'notFound');

export const argumentoInvalido = (mensaje: string) => errorGmail(400, mensaje, 'invalidArgument');

/** Error de /token (RFC 6749): el adaptador solo mira `error`. */
export const errorToken = (error: string, descripcion: string) => ({
  error,
  error_description: descripcion,
});
