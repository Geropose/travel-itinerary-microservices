import { isIP } from 'node:net';
import type { Request } from 'express';
import { autenticacion, type Servidor } from '@trotamundos/comun';
import type { MetadatosAcceso, NucleoConversacion } from './nucleo.ts';

function metadatosDe(req: Request): MetadatosAcceso {
  const ipLimpia = (req.ip ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return {
    metodo: req.method,
    ruta: req.baseUrl + req.path,
    ...(isIP(ipLimpia) ? { ip: ipLimpia } : {}),
  };
}

/** Registra todas las rutas de `specs/openapi/asistente.yaml`. */
export function registrarRutas(servidor: Servidor, nucleo: NucleoConversacion): void {
  servidor.app.post('/conversaciones', async (req, res) => {
    const auth = autenticacion(req);
    const body = (req.body ?? {}) as { idioma?: string };
    const conversacion = await nucleo.crearConversacion(auth.sub, body.idioma ?? auth.idioma);
    res
      .status(201)
      .setHeader('Location', `/api/asistente/conversaciones/${conversacion.conversacionId}`)
      .json(conversacion);
  });

  servidor.app.get('/conversaciones/:conversacionId', async (req, res) => {
    const auth = autenticacion(req);
    const conversacion = await nucleo.obtenerConversacion(
      req.params.conversacionId ?? '',
      auth.sub,
      metadatosDe(req),
    );
    res.status(200).json(conversacion);
  });

  servidor.app.post('/conversaciones/:conversacionId/mensajes', async (req, res) => {
    const auth = autenticacion(req);
    const { texto, zonaHoraria } = req.body as { texto: string; zonaHoraria?: string };
    const resultado = await nucleo.enviarMensaje(
      req.params.conversacionId ?? '',
      auth,
      texto,
      metadatosDe(req),
      zonaHoraria,
    );
    if (resultado.estado === 'consultando') {
      res.status(202).setHeader('Retry-After', '2').json(resultado);
      return;
    }
    res.status(200).json(resultado);
  });

  servidor.app.get('/conversaciones/:conversacionId/mensajes', async (req, res) => {
    const auth = autenticacion(req);
    const desdeCrudo = req.query.desde;
    const desde =
      typeof desdeCrudo === 'number'
        ? desdeCrudo
        : typeof desdeCrudo === 'string' && desdeCrudo.length > 0
          ? Number(desdeCrudo)
          : 0;

    const lista = await nucleo.listarMensajes(
      req.params.conversacionId ?? '',
      auth.sub,
      Number.isFinite(desde) && desde >= 0 ? desde : 0,
      metadatosDe(req),
    );
    res.status(200).json(lista);
  });

  servidor.app.post('/conversaciones/:conversacionId/confirmaciones', async (req, res) => {
    const auth = autenticacion(req);
    const { opcionId, zonaHoraria } = req.body as { opcionId: string; zonaHoraria?: string };
    const resultado = await nucleo.confirmarReprogramacion(
      req.params.conversacionId ?? '',
      auth,
      opcionId,
      metadatosDe(req),
      zonaHoraria,
    );
    if (resultado.estado === 'consultando') {
      res.status(202).setHeader('Retry-After', '2').json(resultado);
      return;
    }
    res.status(200).json(resultado);
  });
}
