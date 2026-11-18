// Cuota por usuario de la Gmail API (specs/externos/gmail.md, sección 7; QA-7): unidades por minuto
// por buzón. Al superarla, la API responde 429 y la solicitud no consume unidades.

/** Costo en unidades de cada método (tabla de la sección 7). */
export const COSTOS = {
  perfil: 1,
  'messages.list': 5,
  'messages.get': 20,
  'messages.get.full': 60,
  'history.list': 2,
  watch: 100,
} as const;

export type Metodo = keyof typeof COSTOS;

export interface Cuota {
  /** Descuenta las unidades del método; devuelve false si con eso se pasa del límite. */
  consumir(email: string, metodo: Metodo): boolean;
}

/** Ventana móvil de 60 s por buzón. */
export function crearCuota(limitePorMinuto: number, reloj: () => number): Cuota {
  const usos = new Map<string, { en: number; unidades: number }[]>();
  return {
    consumir(email, metodo) {
      const ahora = reloj();
      const recientes = (usos.get(email) ?? []).filter((u) => ahora - u.en < 60_000);
      const usadas = recientes.reduce((total, u) => total + u.unidades, 0);
      const costo = COSTOS[metodo];
      if (usadas + costo > limitePorMinuto) {
        usos.set(email, recientes);
        return false;
      }
      recientes.push({ en: ahora, unidades: costo });
      usos.set(email, recientes);
      return true;
    },
  };
}
