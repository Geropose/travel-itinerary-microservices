import { contieneFrase, normalizarTexto } from '../reglas.ts';
import type { PluginConsulta } from './tipos.ts';

// Temas conversacionales evaluados después de las dudas específicas para que frases como
// "Hola, ¿cuánto equipaje puedo llevar?" respondan la duda concreta, y en orden de especificidad
// para que "Hola, ¿cómo estás?" o "Hola, ¿qué podés hacer?" respondan a la pregunta.
const ORDEN_CORTESIA = ['quienSos', 'comoEstas', 'despedida', 'gracias', 'saludo'] as const;
const TEMAS_CORTESIA = new Set<string>(ORDEN_CORTESIA);

/**
 * Plug-in de problemas menores (Iteración 7, ADR-018, ADR-019).
 * Responde exclusivamente desde `config/reglas.{es,en}.yaml` (equipaje, check-in, compartir
 * itinerario, uso de la app y cortesía), por lo que sigue funcionando incluso si todos los demás
 * servicios están caídos.
 */
export function crearPluginProblemasMenores(): PluginConsulta {
  return {
    intencion: 'problemaMenor',

    async atender(contexto, mensaje) {
      const normalizado = normalizarTexto(mensaje);
      const catalogo = contexto.reglas.problemasMenores;

      for (const [tema, regla] of Object.entries(catalogo)) {
        if (tema === 'general' || TEMAS_CORTESIA.has(tema)) continue;
        if (regla.palabrasClave.some((p) => contieneFrase(normalizado, p))) {
          return {
            texto: regla.respuesta,
            resultado: 'respondido',
          };
        }
      }

      for (const tema of ORDEN_CORTESIA) {
        const regla = catalogo[tema];
        if (regla && regla.palabrasClave.some((p) => contieneFrase(normalizado, p))) {
          return {
            texto: regla.respuesta,
            resultado: 'respondido',
          };
        }
      }

      const fallback = catalogo.general?.respuesta ?? contexto.reglas.textos.saludo;
      return {
        texto: fallback,
        resultado: 'respondido',
      };
    },
  };
}
