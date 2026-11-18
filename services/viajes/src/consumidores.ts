// Consumidores de eventos de Viajes (Iteración 2, ADR-002, ADR-009): corren N consumidores en
// paralelo sobre viajes.ReservaDetectada y viajes.ReservaActualizada con idempotencia atómica.
import type { Broker, Logger, Pool } from '@trotamundos/comun';
import type { GestorViajes } from './gestor.ts';
import type { ReservaActualizadaDatos, ReservaDetectadaDatos } from './modelo.ts';

export interface OpcionesConsumidoresViajes {
  broker: Broker;
  pool: Pool;
  gestor: GestorViajes;
  logger: Logger;
  cantidadConsumidores?: number;
  prefetch?: number;
  alCambiarUsuario?: (usuarioId: string) => Promise<void> | void;
}

/**
 * Registra `cantidadConsumidores` canales consumidores en paralelo por tipo de evento.
 * `broker.consumir` abre una transacción sobre `pool`, verifica `eventos_procesados` y entrega el
 * mismo cliente de transacción para que cambio + outbox + marca de evento se confirmen juntos.
 */
export async function registrarConsumidoresViajes(
  opciones: OpcionesConsumidoresViajes,
): Promise<void> {
  const { broker, pool, gestor, logger, alCambiarUsuario } = opciones;
  const cantidad = Math.max(1, opciones.cantidadConsumidores ?? 4);
  const prefetch = Math.max(1, opciones.prefetch ?? 5);

  for (let i = 0; i < cantidad; i++) {
    await broker.consumir<ReservaDetectadaDatos>({
      tipo: 'ReservaDetectada',
      pool,
      prefetch,
      manejar: async (evento, cliente) => {
        const resultado = await gestor.procesarReservaDetectada(cliente, evento.datos);
        if (resultado.accion === 'creada' || resultado.accion === 'actualizada') {
          await alCambiarUsuario?.(resultado.usuarioId);
        }
      },
    });

    await broker.consumir<ReservaActualizadaDatos>({
      tipo: 'ReservaActualizada',
      pool,
      prefetch,
      manejar: async (evento, cliente) => {
        const resultado = await gestor.procesarReservaActualizada(cliente, evento.datos);
        if (resultado.accion === 'actualizada') {
          await alCambiarUsuario?.(resultado.usuarioId);
        }
      },
    });
  }

  logger.info(
    { cantidadConsumidores: cantidad, prefetch },
    'consumidores de eventos de viajes iniciados',
  );
}
