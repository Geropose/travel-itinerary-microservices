import {
  ErrorDependenciaNoDisponible,
  type ClienteIntegraciones,
  type ClienteUsuarios,
} from '../clientes.ts';
import { interpolarTexto } from '../reglas.ts';
import type { MensajeHistorial, PluginConsulta } from './tipos.ts';

function armarResumenDerivacion(
  historial: MensajeHistorial[],
  mensajeActual: string,
  motivoExplicito?: string,
): string {
  const ultimosUsuario = historial
    .filter((m) => m.autor === 'usuario')
    .slice(-3)
    .map((m) => m.texto.trim())
    .filter(Boolean);

  const partes: string[] = [];
  if (motivoExplicito) partes.push(motivoExplicito);
  if (ultimosUsuario.length > 0) {
    partes.push(`Últimos mensajes del usuario: ${ultimosUsuario.join(' | ')}`);
  } else if (mensajeActual.trim()) {
    partes.push(mensajeActual.trim());
  }
  return partes.join(' — ').slice(0, 1800) || 'Derivación solicitada desde el asistente virtual.';
}

/**
 * Plug-in de derivación a la agencia preferida (Iteración 7, UC-6, ADR-018, ADR-019).
 * Pide el perfil del usuario a Usuarios y crea el caso en la agencia a través de Integraciones,
 * siempre propagando el JWT del usuario.
 */
export function crearPluginDerivacion(dependencias: {
  usuarios: ClienteUsuarios;
  integraciones: ClienteIntegraciones;
}): PluginConsulta {
  const { usuarios, integraciones } = dependencias;

  return {
    intencion: 'derivar',

    async atender(contexto, mensaje) {
      let perfil;
      try {
        perfil = await usuarios.obtenerPerfil(contexto.token);
      } catch (error) {
        const servicio =
          error instanceof ErrorDependenciaNoDisponible ? error.servicio : 'usuarios';
        return {
          texto: contexto.reglas.textos.noDisponibleDerivar,
          resultado: 'noDisponible',
          noDisponible: { funcion: 'derivar', servicio },
          ofreceDerivar: false,
        };
      }

      if (!perfil.agenciaPreferida) {
        return {
          texto: contexto.reglas.textos.sinAgenciaPreferida,
          resultado: 'respondido',
        };
      }

      const resumen = armarResumenDerivacion(
        contexto.historial,
        mensaje,
        contexto.motivoDerivacion,
      );
      const conversacion = contexto.historial.slice(-200).map((m) => ({
        autor: m.autor,
        texto: m.texto,
        enviadoEn: m.enviadoEn,
      }));

      let caso;
      try {
        caso = await integraciones.crearCasoAgencia(
          {
            agencia: perfil.agenciaPreferida,
            usuarioId: contexto.usuarioId,
            resumen,
            contacto: { nombre: perfil.nombre, email: perfil.email },
            conversacion,
          },
          contexto.token,
        );
      } catch (error) {
        const servicio = error instanceof ErrorDependenciaNoDisponible ? error.servicio : 'agencia';
        return {
          texto: contexto.reglas.textos.noDisponibleDerivar,
          resultado: 'noDisponible',
          noDisponible: { funcion: 'derivar', servicio },
          ofreceDerivar: false,
        };
      }

      return {
        texto: interpolarTexto(contexto.reglas.textos.derivadoOk, {
          agencia: caso.agencia,
          numeroCaso: caso.numeroCaso,
        }),
        resultado: 'derivado',
        caso: {
          agencia: caso.agencia,
          numeroCaso: caso.numeroCaso,
        },
      };
    },
  };
}
