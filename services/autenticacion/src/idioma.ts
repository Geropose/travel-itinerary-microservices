// Credenciales al día con el idioma del perfil (QA-11): consume el evento IdiomaActualizado que
// publica Usuarios al cambiar el idioma (operación consumirIdiomaActualizado de
// specs/asyncapi/eventos.yaml, cola autenticacion.IdiomaActualizado) y lo guarda en la credencial.
// Así el próximo JWT (login o renovación) lleva el idioma nuevo en el claim idioma.
import type { Broker, Logger, Pool } from '@trotamundos/comun';
import { actualizarIdioma } from './repositorio.ts';

/** Campo datos de IdiomaActualizado (specs/schemas/IdiomaActualizado.json). */
export interface IdiomaActualizado {
  usuarioId: string;
  idioma: 'es' | 'en';
}

export interface OpcionesIdioma {
  broker: Pick<Broker, 'consumir'>;
  /** Base de Autenticación: ahí están credenciales y eventos_procesados. */
  pool: Pool;
  logger: Logger;
}

/**
 * Empieza a consumir IdiomaActualizado. Si el mismo evento llega dos veces, el broker lo ignora
 * (eventos_procesados). Si la credencial no existe (cuenta de otra región o borrada), no hace nada.
 */
export async function consumirIdiomasActualizados(opciones: OpcionesIdioma): Promise<void> {
  const { broker, pool, logger } = opciones;
  await broker.consumir<IdiomaActualizado>({
    tipo: 'IdiomaActualizado',
    pool,
    manejar: async (evento, cliente) => {
      await actualizarIdioma(cliente, evento.datos.usuarioId, evento.datos.idioma);
    },
  });
  logger.info('credenciales consumiendo IdiomaActualizado');
}
