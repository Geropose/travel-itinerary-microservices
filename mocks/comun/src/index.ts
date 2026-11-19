// Lo compartido por los mocks externos: generador de correos (correos-reserva.md), semillas
// coherentes entre correo y proveedores, rutas /admin, control de demoras/fallas y envío de avisos
// y webhooks con reintentos.
export * from './correo.ts';
export * from './generador.ts';
export * from './semillas.ts';
export * from './semillas-proveedores.ts';
export * from './admin.ts';
export * from './enviador.ts';
export * from './fallas.ts';
