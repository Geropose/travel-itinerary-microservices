import { randomUUID } from 'node:crypto';
import { crearPool } from '@trotamundos/comun';
import { loggerDePrueba, USUARIO_PRUEBA } from '@trotamundos/comun/pruebas';
import { expect, it, vi } from 'vitest';
import { crearNucleoConversacion } from '../src/nucleo.ts';
import { crearRegistroPlugins } from '../src/plugins/registro.ts';
import type { MensajeHistorial, RespuestaPlugin } from '../src/plugins/tipos.ts';
import { crearGestorReglas } from '../src/reglas.ts';
import * as repositorio from '../src/repositorio.ts';

it('guarda la respuesta si el proveedor termina mientras se persiste el aviso consultando', async () => {
  const { logger } = loggerDePrueba('asistente');
  const pool = crearPool({ url: 'postgres://prueba@localhost/prueba' });
  const conversacionId = randomUUID();
  const mensajes: MensajeHistorial[] = [];
  const avisoEnCurso = Promise.withResolvers<undefined>();
  const permitirGuardarAviso = Promise.withResolvers<undefined>();
  const respuestaProveedor = Promise.withResolvers<RespuestaPlugin>();
  const fecha = '2026-11-21T12:00:00.000Z';
  const region = 'region-1';
  let consultando = false;

  vi.spyOn(repositorio, 'obtenerConversacionCabecera').mockImplementation(async () => ({
    conversacionId,
    usuarioId: USUARIO_PRUEBA,
    region,
    idioma: 'es',
    intentosFallidos: 0,
    ofreceDerivar: false,
    consultando,
    ultimaSecuencia: mensajes.length,
    creadaEn: fecha,
    actualizadaEn: fecha,
  }));
  vi.spyOn(repositorio, 'listarMensajes').mockImplementation(async () => [...mensajes]);
  vi.spyOn(repositorio, 'agregarMensaje').mockImplementation(async (_, __, datos) => {
    if (datos.resultado === 'consultando') {
      avisoEnCurso.resolve(undefined);
      await permitirGuardarAviso.promise;
    }
    const { enviadoEn, ...mensaje } = datos;
    const guardado = {
      ...mensaje,
      mensajeId: randomUUID(),
      secuencia: mensajes.length + 1,
      enviadoEn: enviadoEn.toISOString(),
    };
    mensajes.push(guardado);
    return guardado;
  });
  vi.spyOn(repositorio, 'actualizarEstadoConversacion').mockImplementation(
    async (_, __, estado) => {
      consultando = estado.consultando ?? consultando;
    },
  );

  const nucleo = crearNucleoConversacion({
    pool,
    logger,
    region,
    reglas: crearGestorReglas(),
    plugins: crearRegistroPlugins([
      { intencion: 'reprogramar', atender: () => respuestaProveedor.promise },
    ]),
    umbralRespuestaLentaMs: 15,
  });
  const acceso = { metodo: 'POST', ruta: '/conversaciones/prueba/mensajes' };
  const turno = nucleo.enviarMensaje(
    conversacionId,
    {
      sub: USUARIO_PRUEBA,
      region,
      idioma: 'es',
      roles: ['usuario'],
      esServicio: false,
      token: 'prueba',
    },
    'Quiero reprogramar mi vuelo',
    acceso,
  );

  try {
    await Promise.race([
      avisoEnCurso.promise,
      turno.then(() => {
        throw new Error('El turno terminó antes de guardar el aviso consultando');
      }),
    ]);
    respuestaProveedor.resolve({
      texto: 'El proveedor terminó la consulta',
      resultado: 'respondido',
    });
    await Promise.resolve();
    permitirGuardarAviso.resolve(undefined);

    expect((await turno).estado).toBe('consultando');
    await vi.waitFor(async () => {
      const resultado = await nucleo.listarMensajes(conversacionId, USUARIO_PRUEBA, 0, acceso);
      expect(resultado.mensajes.at(-1)?.texto).toBe('El proveedor terminó la consulta');
      expect(resultado.consultando).toBe(false);
    });
  } finally {
    permitirGuardarAviso.resolve(undefined);
    await nucleo.detener();
    await pool.end();
    vi.restoreAllMocks();
  }
});
