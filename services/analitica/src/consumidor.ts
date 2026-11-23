// Consumidor regional del Anonimizador (Iteración 6, ADR-002, ADR-016, ADR-017):
// Consume ViajeActualizado del broker de SU región, garantiza idempotencia en la base regional
// (eventos_procesados), anonimiza dentro de la región con SECRETO_ANALITICA y persiste la fila
// validada contra ViajeAnonimizado.json en la base global de analítica.
import type { Broker, Logger, Pool, Region } from '@trotamundos/comun';
import { anonimizarViajeActualizado } from './anonimizador.ts';
import type { ViajeActualizadoDatos } from './modelo.ts';
import * as repositorio from './repositorio.ts';

export interface OpcionesConsumidorAnonimizador {
  broker: Broker;
  /** Base regional de analítica donde reside eventos_procesados (CONST-6). */
  poolRegional: Pool;
  /** Base global de analítica donde se guarda el histórico anonimizado particionado. */
  poolAnalitica: Pool;
  region: Region;
  secretoAnalitica: string;
  logger: Logger;
  cantidadConsumidores?: number;
  prefetch?: number;
  ahora?: () => number;
}

export async function registrarConsumidorAnonimizador(
  opciones: OpcionesConsumidorAnonimizador,
): Promise<void> {
  const { broker, poolRegional, poolAnalitica, region, secretoAnalitica, logger } = opciones;
  const cantidad = Math.max(1, opciones.cantidadConsumidores ?? 2);
  const prefetch = Math.max(1, opciones.prefetch ?? 10);
  const ahora = opciones.ahora ?? Date.now;

  for (let i = 0; i < cantidad; i++) {
    await broker.consumir<ViajeActualizadoDatos>({
      tipo: 'ViajeActualizado',
      pool: poolRegional,
      prefetch,
      manejar: async (evento, cliente) => {
        const anonimizada = anonimizarViajeActualizado(evento, secretoAnalitica, region);
        const tsEvento = Date.parse(evento.ocurridoEn);
        const fechaEvento = Number.isNaN(tsEvento) ? new Date(ahora()) : new Date(tsEvento);
        const { accion } =
          poolAnalitica === poolRegional
            ? await repositorio.guardarFilaAnonimizadaEnCliente(cliente, anonimizada, fechaEvento)
            : await repositorio.guardarFilaAnonimizada(poolAnalitica, anonimizada, fechaEvento);
        // Nunca logueamos numeroReserva ni SECRETO_ANALITICA; solo metadatos anonimizados.
        logger.debug(
          {
            eventId: evento.eventId,
            region: anonimizada.region,
            proveedor: anonimizada.proveedor,
            tipoReserva: anonimizada.tipoReserva,
            estado: anonimizada.estado,
            accion,
          },
          'ViajeActualizado anonimizado y persistido en la base de analítica',
        );
      },
    });
  }
}
