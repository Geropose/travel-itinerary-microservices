import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  CONFIG_E2E,
  eliminarReservasUsuario,
  esperarCondicion,
  idAleatorio,
  loginAnalista,
  pedirJson,
  registrarYLogin,
  reiniciarMock,
  tokenServicioDePruebas,
  type SesionE2E,
} from './comun.ts';
import { prepararContrato } from './openapi-contratos.ts';

describe.skipIf(process.env.CONTRATOS_EN_VIVO !== '1')(
  'Contratos HTTP de Viajes y Analítica (dueño C)',
  () => {
    let sesion: SesionE2E;
    let viajes: ReturnType<typeof prepararContrato>;
    let analitica: ReturnType<typeof prepararContrato>;
    let jwtAnalista = '';
    const fecha = new Date(Date.now() + 25 * 24 * 60 * 60_000);
    const inicio = fecha.toISOString();
    const fin = new Date(fecha.getTime() + 3 * 60 * 60_000).toISOString();

    beforeAll(async () => {
      sesion = await registrarYLogin();
      const analista = await loginAnalista('region-1');
      jwtAnalista = analista.jwt;
      viajes = prepararContrato('viajes', sesion.jwt);
      analitica = prepararContrato('analitica', jwtAnalista);
    });

    afterAll(async () => {
      if (sesion) {
        await eliminarReservasUsuario(sesion);
      }
      await reiniciarMock(CONFIG_E2E.urlMockRedSocial);
      const diferencias: unknown[] = [];
      for (const contrato of [viajes, analitica]) {
        try {
          contrato?.verificar();
        } catch (error) {
          diferencias.push(error);
        }
      }
      if (diferencias.length) {
        throw new AggregateError(diferencias, 'Diferencias de contratos HTTP (dueño C)');
      }
    });

    it('comprueba las trece operaciones de Viajes', async () => {
      await viajes.probar('consultarSalud', { status: 200 });

      const ejemploReserva = viajes.ejemplo('crearReserva');
      if (!ejemploReserva || Array.isArray(ejemploReserva) || typeof ejemploReserva !== 'object') {
        throw new Error('Falta el ejemplo de crearReserva en viajes.yaml');
      }
      const numeroReserva = `CTC${idAleatorio().toUpperCase()}`;
      const creada = (await viajes.probar('crearReserva', {
        status: 201,
        cuerpo: {
          ...ejemploReserva,
          numeroReserva,
          inicio,
          fin,
        },
      })) as { reservaId: string; viajeId: string; numeroReserva: string } | undefined;
      if (!creada?.reservaId || !creada.viajeId) {
        throw new Error('[viajes · dueño C] crearReserva no devolvió reservaId/viajeId');
      }

      await viajes.probar('obtenerPanel', { status: 200 });
      await viajes.probar('listarArchivados', { status: 200 });
      await viajes.probar('obtenerViaje', {
        status: 200,
        parametros: { viajeId: creada.viajeId },
      });
      await viajes.probar('compartirViajeEnRed', {
        status: 201,
        parametros: { viajeId: creada.viajeId },
      });
      await viajes.probar('modificarReserva', {
        status: 200,
        parametros: { reservaId: creada.reservaId },
        cuerpo: {
          inicio,
          fin,
          estado: 'modificada',
        },
      });

      await viajes.probar('listarReservasInterna', {
        status: 200,
        parametros: { usuarioId: sesion.usuarioId },
      });
      await viajes.probar('consultarDuenoViaje', {
        status: 200,
        parametros: { viajeId: creada.viajeId },
      });
      await viajes.probar('obtenerReservaPorNumeroInterna', {
        status: 200,
        parametros: {
          numeroReserva: creada.numeroReserva,
          proveedor: 'aerolinea-andina',
        },
        parametrosInvalidos: { numeroReserva: ' ' },
      });

      const tokenPruebas = tokenServicioDePruebas('region-1');
      await viajes.probar('listarUsuariosConViajeProximo', {
        status: 200,
        headers: { Authorization: `Bearer ${tokenPruebas}` },
      });
      await viajes.probar('ejecutarArchivado', {
        status: 200,
        headers: { Authorization: `Bearer ${tokenPruebas}` },
      });

      await viajes.probar('eliminarReserva', {
        status: 204,
        parametros: { reservaId: creada.reservaId },
      });
    }, 90_000);

    it('comprueba las seis operaciones de Analítica', async () => {
      await analitica.probar('consultarSalud', { status: 200 });
      await analitica.probar('consultarDestinos', {
        status: 200,
        parametros: { desde: '2025-01-01', hasta: '2025-12-31' },
      });
      await analitica.probar('consultarCancelaciones', {
        status: 200,
        parametros: { desde: '2025-01-01', hasta: '2025-12-31', agruparPor: 'proveedor' },
      });
      await analitica.probar('consultarTendencias', {
        status: 200,
        parametros: { anio: '2025' },
      });

      const lanzada = (await analitica.probar('ejecutarConsulta', {
        status: 202,
        parametros: { tipo: 'destinos' },
      })) as { consultaId: string } | undefined;
      if (!lanzada?.consultaId) {
        throw new Error('[analitica · dueño C] ejecutarConsulta no devolvió consultaId');
      }

      await analitica.probar('obtenerEjecucion', {
        status: 200,
        parametros: { consultaId: lanzada.consultaId },
      });

      await esperarCondicion(async () => {
        const res = await pedirJson<{ estado: string }>(
          `${CONFIG_E2E.urlEnrutador}/api/analitica/consultas/ejecuciones/${lanzada.consultaId}`,
          { headers: { Authorization: `Bearer ${jwtAnalista}`, 'X-Region': 'region-1' } },
        );
        return res.datos?.estado === 'terminada' || res.datos?.estado === 'fallida'
          ? res.datos
          : undefined;
      }, 20_000);
    }, 90_000);
  },
);
