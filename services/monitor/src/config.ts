import { esquemaBase } from '@trotamundos/comun';

/** Variables de entorno de monitor (ver .env.example). Si falta una, el servicio no arranca. */
export const esquemaConfig = esquemaBase.extend({});

export type Config = ReturnType<typeof esquemaConfig.parse>;
