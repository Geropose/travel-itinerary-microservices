import { contieneFrase, normalizarTexto } from '../reglas.ts';
import type { PluginConsulta } from './tipos.ts';

/**
 * Plug-in de problemas menores (Iteración 7, ADR-018, ADR-019).
 * Responde exclusivamente desde `config/reglas.{es,en}.yaml` (equipaje, check-in, compartir
 * itinerario), por lo que sigue funcionando incluso si todos los demás servicios están caídos.
 */
export function crearPluginProblemasMenores(): PluginConsulta {
  return {
    intencion: 'problemaMenor',

    async atender(contexto, mensaje) {
      const normalizado = normalizarTexto(mensaje);
      const catalogo = contexto.reglas.problemasMenores;

      for (const [tema, regla] of Object.entries(catalogo)) {
        if (tema === 'general') continue;
        if (regla.palabrasClave.some((p) => contieneFrase(normalizado, p))) {
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
