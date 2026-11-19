import {
  crearEvento,
  enTransaccion,
  guardarEnOutbox,
  type Logger,
  type Pool,
  type Region,
} from '@trotamundos/comun';
import type { AdaptadorProveedorViaje } from './adaptadores/tipos.ts';
import * as repositorio from './repositorio.ts';
import type { ViaNoTraducido } from './repositorio.ts';

export type EstadoProcesamientoMensaje = 'aceptado' | 'repetido' | 'no-traducido';

export interface OpcionesProcesadorProveedores {
  pool: Pool;
  region: Region;
  logger: Logger;
  ahora?: () => number;
}

export interface ProcesadorProveedores {
  procesarMensaje(
    adaptador: AdaptadorProveedorViaje,
    mensaje: unknown,
    via: ViaNoTraducido,
  ): Promise<EstadoProcesamientoMensaje>;
  registrarCuerpoNoJson(proveedor: string, tamanoBytes: number, via: ViaNoTraducido): Promise<void>;
}

/**
 * Procesa mensajes de proveedores (vía webhook o consulta periódica):
 * - Si no se puede traducir, guarda el mensaje sin datos personales en `no_traducidos` (QA-6).
 * - Si se traduce, deduplica por `(proveedor, numeroReserva, versionCambio)`, actualiza el último
 *   estado conocido y encola `ReservaActualizada` en el outbox dentro de la misma transacción.
 */
export function crearProcesadorProveedores(
  opciones: OpcionesProcesadorProveedores,
): ProcesadorProveedores {
  const { pool, region, logger, ahora = Date.now } = opciones;

  async function guardarNoTraducido(
    proveedor: string,
    via: ViaNoTraducido,
    motivo: string,
    cuerpo: string,
  ): Promise<void> {
    const registro = await repositorio.registrarNoTraducido(pool, {
      proveedor,
      via,
      motivo,
      cuerpo,
      recibidoEn: new Date(ahora()),
    });
    logger.warn(
      { proveedor, via, noTraducidoId: registro.id, motivo },
      'Mensaje de proveedor enviado a no_traducidos',
    );
  }

  async function procesarMensaje(
    adaptador: AdaptadorProveedorViaje,
    mensaje: unknown,
    via: ViaNoTraducido,
  ): Promise<EstadoProcesamientoMensaje> {
    const primera = adaptador.traducir(mensaje);
    if (!primera.ok) {
      await guardarNoTraducido(
        adaptador.nombre,
        via,
        primera.motivo,
        primera.cuerpoSinDatosPersonales,
      );
      return 'no-traducido';
    }

    let falloConEstadoPrevio: { motivo: string; cuerpo: string } | undefined;

    const estado = await enTransaccion<EstadoProcesamientoMensaje>(pool, async (cliente) => {
      const esNuevo = await repositorio.registrarCambioSiNuevo(
        cliente,
        adaptador.nombre,
        primera.evento.numeroReserva,
        primera.claveVersion,
      );
      if (!esNuevo) {
        return 'repetido';
      }

      const estadoPrevio = await repositorio.obtenerEstadoReserva(
        cliente,
        adaptador.nombre,
        primera.evento.numeroReserva,
        { paraActualizar: true },
      );

      const traducido = estadoPrevio ? adaptador.traducir(mensaje, estadoPrevio) : primera;
      if (!traducido.ok) {
        falloConEstadoPrevio = {
          motivo: traducido.motivo,
          cuerpo: traducido.cuerpoSinDatosPersonales,
        };
        // Forzamos rollback de `cambios_procesados` para registrar en `no_traducidos` afuera.
        throw new Error('FALLO_TRADUCCION_CON_ESTADO_PREVIO');
      }

      await repositorio.guardarEstadoReserva(
        cliente,
        adaptador.nombre,
        traducido.evento.numeroReserva,
        traducido.estadoActual,
      );

      const sobre = crearEvento('ReservaActualizada', traducido.evento, region);
      await guardarEnOutbox(cliente, sobre);
      return 'aceptado';
    }).catch(async (error: unknown) => {
      if (falloConEstadoPrevio) {
        await guardarNoTraducido(
          adaptador.nombre,
          via,
          falloConEstadoPrevio.motivo,
          falloConEstadoPrevio.cuerpo,
        );
        return 'no-traducido' as const;
      }
      throw error;
    });

    if (estado === 'aceptado') {
      logger.info(
        {
          proveedor: adaptador.nombre,
          via,
          numeroReserva: primera.evento.numeroReserva,
          version: primera.claveVersion,
          estado: primera.evento.estado,
        },
        'Cambio de proveedor encolado en outbox',
      );
    }
    return estado;
  }

  async function registrarCuerpoNoJson(
    proveedor: string,
    tamanoBytes: number,
    via: ViaNoTraducido,
  ): Promise<void> {
    await guardarNoTraducido(
      proveedor,
      via,
      'El cuerpo no es JSON válido.',
      `[cuerpo no JSON de ${tamanoBytes} bytes]`,
    );
  }

  return {
    procesarMensaje,
    registrarCuerpoNoJson,
  };
}
