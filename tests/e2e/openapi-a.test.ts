import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  CONFIG_E2E,
  emailAleatorio,
  registrarYLogin,
  tokenServicioAutenticacion,
  type SesionE2E,
} from './comun.ts';
import { prepararContrato } from './openapi-contratos.ts';

describe.skipIf(process.env.CONTRATOS_EN_VIVO !== '1')(
  'Contratos HTTP de Autenticación, Gateway y Monitor (dueño A)',
  () => {
    let sesion: SesionE2E;
    let autenticacion: ReturnType<typeof prepararContrato>;
    let gateway: ReturnType<typeof prepararContrato>;
    let monitor: ReturnType<typeof prepararContrato>;

    beforeAll(async () => {
      sesion = await registrarYLogin();
      autenticacion = prepararContrato('autenticacion', sesion.jwt);
      gateway = prepararContrato('gateway', sesion.jwt);
      monitor = prepararContrato('monitor', sesion.jwt);
    });

    afterAll(() => {
      const diferencias: unknown[] = [];
      for (const contrato of [autenticacion, gateway, monitor]) {
        try {
          contrato?.verificar();
        } catch (error) {
          diferencias.push(error);
        }
      }
      if (diferencias.length) {
        throw new AggregateError(diferencias, 'Diferencias de contratos HTTP (dueño A)');
      }
    });

    it('comprueba la operación de salud del API Gateway y las dos del Monitor', async () => {
      await gateway.probar('consultarSalud', { status: 200 });
      await monitor.probar('consultarSalud', { status: 200 });
      await monitor.probar('consultarEstado', { status: 200 });
    }, 60_000);

    it('comprueba las ocho operaciones de Autenticación', async () => {
      await autenticacion.probar('consultarSalud', { status: 200 });
      await autenticacion.probar('obtenerClavesPublicas', { status: 200 });

      const emailContrato = emailAleatorio('ct-auth');
      await autenticacion.probar('registrarCuenta', {
        status: 201,
        cuerpo: {
          nombre: 'Usuaria Contrato Auth',
          email: emailContrato,
          contrasena: CONFIG_E2E.contrasenaDefecto,
          region: 'region-1',
          idioma: 'es',
        },
      });

      const sesionLogin = (await autenticacion.probar('iniciarSesion', {
        status: 200,
        cuerpo: {
          email: emailContrato,
          contrasena: CONFIG_E2E.contrasenaDefecto,
        },
      })) as { jwt: string; tokenRenovacion: string } | undefined;
      if (!sesionLogin?.tokenRenovacion) {
        throw new Error('[autenticacion · dueño A] Login no devolvió tokenRenovacion');
      }

      const renovado = (await autenticacion.probar('renovarJwt', {
        status: 200,
        cuerpo: { tokenRenovacion: sesionLogin.tokenRenovacion },
      })) as { jwt: string } | undefined;
      if (!renovado?.jwt) {
        throw new Error('[autenticacion · dueño A] renovarJwt no devolvió jwt');
      }

      await autenticacion.probar('cerrarSesion', {
        status: 204,
        headers: { Authorization: `Bearer ${renovado.jwt}` },
        cuerpo: { tokenRenovacion: sesionLogin.tokenRenovacion },
      });

      await autenticacion.probar('emitirTokenServicio', {
        status: 200,
        cuerpo: {
          servicio: 'pruebas',
          secreto: CONFIG_E2E.secretoServicioPruebas,
        },
      });

      const tokenAuth = tokenServicioAutenticacion('region-1');
      await autenticacion.probar('existeCuenta', {
        status: 200,
        headers: { Authorization: `Bearer ${tokenAuth}` },
        parametros: { email: emailContrato },
      });
    }, 90_000);
  },
);
