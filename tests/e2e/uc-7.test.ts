// Caso de Uso 7 (UC-7, Iteración 6): Analítica de datos y privacidad.
// El analista consulta tendencias, destinos y cancelaciones sin que los resultados contengan
// datos personales de los viajeros (ADR-016, ADR-017, CONST-6).
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CONFIG_E2E,
  esperarCondicion,
  loginAnalista,
  pedirJson,
  registrarYLogin,
  sistemaDisponible,
} from './comun.ts';

const haySistema = await sistemaDisponible();

describe.skipIf(!haySistema)('UC-7: Consultas analíticas pesadas y anonimización', () => {
  let jwtAnalista: string;

  beforeAll(async () => {
    const sesion = await loginAnalista('region-1');
    jwtAnalista = sesion.jwt;
  });

  it('el analista ejecuta consultas síncronas y Map-Reduce obteniendo datos agregados sin información personal', async () => {
    // 1. Consulta síncrona de destinos populares.
    const respDestinos = await pedirJson<{ destinos: { destino: string; total: number }[] }>(
      `${CONFIG_E2E.urlEnrutador}/api/analitica/consultas/destinos`,
      { headers: { Authorization: `Bearer ${jwtAnalista}` } },
    );
    expect(respDestinos.status).toBe(200);
    expect(respDestinos.datos?.destinos).toBeDefined();

    // 2. Consulta síncrona de cancelaciones.
    const respCancelaciones = await pedirJson<{
      cancelaciones: { proveedor: string; porcentaje: number }[];
    }>(`${CONFIG_E2E.urlEnrutador}/api/analitica/consultas/cancelaciones`, {
      headers: { Authorization: `Bearer ${jwtAnalista}` },
    });
    expect(respCancelaciones.status).toBe(200);
    expect(respCancelaciones.datos?.cancelaciones).toBeDefined();

    // 3. Consulta asíncrona pesada de tendencias con Map-Reduce (worker_threads).
    const ejecucion = await pedirJson<{ consultaId: string; estado: string }>(
      `${CONFIG_E2E.urlEnrutador}/api/analitica/consultas/tendencias/ejecutar`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwtAnalista}`,
        },
        body: JSON.stringify({ anio: 2026, procesadores: 2 }),
      },
    );
    expect(ejecucion.status).toBe(202);
    const consultaId = ejecucion.datos?.consultaId ?? '';
    expect(consultaId).toBeTruthy();

    interface ResultadoEjecucion {
      consultaId: string;
      estado: 'en-curso' | 'completada' | 'fallida';
      resultado?: {
        anio: number;
        periodos: { mes: number; total: number }[];
      };
    }

    const resultadoFinal = await esperarCondicion<ResultadoEjecucion>(
      async () => {
        const resp = await pedirJson<ResultadoEjecucion>(
          `${CONFIG_E2E.urlEnrutador}/api/analitica/consultas/ejecuciones/${consultaId}`,
          { headers: { Authorization: `Bearer ${jwtAnalista}` } },
        );
        return resp.datos?.estado === 'completada' ? resp.datos : undefined;
      },
      20_000,
      1_000,
    );
    expect(resultadoFinal.estado).toBe('completada');
    expect(resultadoFinal.resultado?.periodos).toBeDefined();

    // 4. Verificación de privacidad: ningún resultado analítico debe contener datos personales
    // (nombres de personas, direcciones de correo, documentos, etc.).
    const volcados = [
      JSON.stringify(respDestinos.datos),
      JSON.stringify(respCancelaciones.datos),
      JSON.stringify(resultadoFinal.resultado),
    ].join('\n');

    // No debe contener direcciones de email ni nombres de personas de prueba.
    expect(volcados).not.toMatch(/@/);
    expect(volcados).not.toMatch(/correo\.example/i);
    expect(volcados).not.toMatch(/gmail\.example/i);
    expect(volcados).not.toMatch(/outlook\.example/i);
    expect(volcados).not.toMatch(/Ana García/i);
    expect(volcados).not.toMatch(/Bruno Díaz/i);
  });

  it('un usuario común no tiene permiso para consultar analítica (403)', async () => {
    const usuarioComun = await registrarYLogin();
    const resp = await pedirJson(`${CONFIG_E2E.urlEnrutador}/api/analitica/consultas/destinos`, {
      headers: { Authorization: `Bearer ${usuarioComun.jwt}` },
    });
    expect(resp.status).toBe(403);
  });
});
