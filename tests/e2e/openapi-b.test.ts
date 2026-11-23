import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leerEnv } from '../../infra/scripts/entorno.ts';
import {
  conectarOAuthMock,
  CONFIG_E2E,
  desconectarCuentasCorreo,
  eliminarReservasUsuario,
  emailAleatorio,
  idAleatorio,
  pedirJson,
  registrarYLogin,
  tokenServicioAutenticacion,
  type SesionE2E,
} from './comun.ts';
import { prepararContrato } from './openapi-contratos.ts';

describe.skipIf(process.env.CONTRATOS_EN_VIVO !== '1')(
  'Contratos HTTP de Usuarios y Correo (dueño B)',
  () => {
    let sesion: SesionE2E;
    let usuarios: ReturnType<typeof prepararContrato>;
    let correo: ReturnType<typeof prepararContrato>;
    let viajeId = '';
    let secretoAvisosGmail = '';

    beforeAll(async () => {
      sesion = await registrarYLogin();
      usuarios = prepararContrato('usuarios', sesion.jwt);
      correo = prepararContrato('correo', sesion.jwt);

      const fecha = new Date(Date.now() + 20 * 24 * 60 * 60_000);
      const inicio = fecha.toISOString();
      const fin = new Date(fecha.getTime() + 2 * 60 * 60_000).toISOString();
      const reserva = await pedirJson<{ viajeId: string }>(
        `${CONFIG_E2E.urlEnrutador}/api/viajes/reservas`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sesion.jwt}` },
          body: JSON.stringify({
            numeroReserva: `CTB${idAleatorio().toUpperCase()}`,
            proveedor: 'aerolinea-andina',
            tipoReserva: 'vuelo',
            origen: 'EZE',
            destino: 'SCL',
            inicio,
            fin,
          }),
        },
      );
      expect(reserva.status).toBe(201);
      viajeId = reserva.datos?.viajeId ?? '';
      expect(viajeId).not.toBe('');

      const env = leerEnv(readFileSync(new URL('../../.env', import.meta.url), 'utf8'));
      secretoAvisosGmail = process.env.SECRETO_AVISOS_GMAIL ?? env.SECRETO_AVISOS_GMAIL ?? '';
      expect(secretoAvisosGmail).not.toBe('');
    });

    afterAll(async () => {
      if (sesion) {
        await desconectarCuentasCorreo(sesion);
        await eliminarReservasUsuario(sesion);
      }
      const diferencias: unknown[] = [];
      for (const contrato of [usuarios, correo]) {
        try {
          contrato?.verificar();
        } catch (error) {
          diferencias.push(error);
        }
      }
      if (diferencias.length) {
        throw new AggregateError(diferencias, 'Diferencias de contratos HTTP (dueño B)');
      }
    });

    it('comprueba las once operaciones de Usuarios', async () => {
      await usuarios.probar('consultarSalud', { status: 200 });
      await usuarios.probar('obtenerPerfil', { status: 200 });
      await usuarios.probar('actualizarPerfil', { status: 200 });
      await usuarios.probar('obtenerWhitelist', { status: 200 });
      await usuarios.probar('guardarWhitelist', { status: 200 });

      const emailDesignado = emailAleatorio('designado-ct');
      await usuarios.probar('designarPersona', {
        status: 201,
        parametros: { viajeId },
        cuerpo: { email: emailDesignado },
      });
      await usuarios.probar('listarDesignados', {
        status: 200,
        parametros: { viajeId },
      });
      await usuarios.probar('consultarPermisoItinerario', {
        status: 200,
        parametros: { viajeId, usuarioId: sesion.usuarioId },
      });
      await usuarios.probar('quitarDesignado', {
        status: 204,
        parametros: { viajeId, email: emailDesignado },
      });

      await usuarios.probar('obtenerAgenciaPreferida', {
        status: 200,
        parametros: { usuarioId: sesion.usuarioId },
      });

      const tokenAuth = tokenServicioAutenticacion('region-1');
      await usuarios.probar('crearCuenta', {
        status: 201,
        headers: { Authorization: `Bearer ${tokenAuth}` },
        cuerpo: {
          usuarioId: randomUUID(),
          email: emailAleatorio('ct-interna-u'),
          nombre: 'Usuaria Interna Contrato',
          region: 'region-1',
          idioma: 'es',
        },
      });
    }, 90_000);

    it('comprueba las ocho operaciones de Correo', async () => {
      await correo.probar('consultarSalud', { status: 200 });

      const inicioOAuth = (await correo.probar('conectarCuentaCorreo', {
        status: 200,
        parametros: { proveedorCorreo: 'gmail' },
      })) as { urlAutorizacion: string } | undefined;
      if (!inicioOAuth?.urlAutorizacion) {
        throw new Error('[correo · dueño B] conectarCuentaCorreo no devolvió urlAutorizacion');
      }
      const state = new URL(inicioOAuth.urlAutorizacion).searchParams.get('state') ?? '';
      expect(state).not.toBe('');

      await correo.probar('completarConexionOAuth', {
        status: 302,
        parametros: { state, error: 'access_denied' },
      });

      const emailBuzon = emailAleatorio('buzon-ct', 'gmail.com');
      await conectarOAuthMock({
        proveedor: 'gmail',
        emailBuzon,
        jwt: sesion.jwt,
        region: 'region-1',
      });

      const lista = (await correo.probar('listarCuentasCorreo', { status: 200 })) as
        { cuentas: { id: string }[] } | undefined;
      const cuentaId = lista?.cuentas[0]?.id;
      if (!cuentaId) {
        throw new Error('[correo · dueño B] listarCuentasCorreo no devolvió la cuenta conectada');
      }

      await correo.probar('listarNoProcesados', { status: 200 });

      const ejemploGmail = correo.ejemplo('recibirAvisoGmail');
      if (!ejemploGmail || Array.isArray(ejemploGmail) || typeof ejemploGmail !== 'object') {
        throw new Error('Falta el ejemplo de recibirAvisoGmail');
      }
      await correo.probar('recibirAvisoGmail', {
        status: 202,
        parametros: { token: secretoAvisosGmail },
        cuerpo: {
          ...ejemploGmail,
          subscription: 'projects/trotamundos/subscriptions/gmail-avisos-region-1-push',
        },
      });

      await correo.probar('recibirAvisoOutlook', { status: 202 });

      await correo.probar('desconectarCuentaCorreo', {
        status: 204,
        parametros: { cuentaId },
      });
    }, 90_000);
  },
);
