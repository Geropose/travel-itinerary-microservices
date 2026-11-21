// Registro de accesos del gateway (Iteración 5, ADR-005, QA-8 y QA-9): consume el evento
// AccesoRechazado que publica el Validador de Intercepción de cada microservicio y lo guarda en
// accesos_rechazados (operación consumirAccesoRechazado de specs/asyncapi/eventos.yaml, cola
// gateway.AccesoRechazado). Los rechazos del propio gateway no pasan por acá: van directo a la base.
import {
  guardarAccesoRechazado,
  type AccesoRechazado,
  type Broker,
  type Logger,
  type Pool,
} from '@trotamundos/comun';

export interface OpcionesRegistroAccesos {
  broker: Pick<Broker, 'consumir'>;
  /** Base registro_accesos: ahí están accesos_rechazados y eventos_procesados. */
  pool: Pool;
  logger: Logger;
}

/**
 * Empieza a consumir AccesoRechazado. Si el mismo evento llega dos veces, el broker lo ignora
 * (eventos_procesados), así cada rechazo queda guardado una sola vez. La fecha es la del rechazo
 * (ocurridoEn), no la del momento en que se guarda.
 */
export async function consumirAccesosRechazados(opciones: OpcionesRegistroAccesos): Promise<void> {
  const { broker, pool, logger } = opciones;
  await broker.consumir<AccesoRechazado>({
    tipo: 'AccesoRechazado',
    pool,
    manejar: async (evento, cliente) => {
      await guardarAccesoRechazado(cliente, evento.datos, new Date(evento.ocurridoEn));
    },
  });
  logger.info('registro de accesos consumiendo AccesoRechazado');
}
