// Caso de Uso 6 (UC-6, Iteración 3): Resolución de problemas.
// El sistema deriva el problema del usuario a su agencia de viajes preferida con el resumen
// escrito por el usuario y los datos de contacto del perfil (ADR-003, ADR-019).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONFIG_E2E,
  idAleatorio,
  pedirJson,
  registrarYLogin,
  reiniciarMock,
  sistemaDisponible,
  type SesionE2E,
} from './comun.ts';

const haySistema = await sistemaDisponible();

describe.skipIf(!haySistema)('UC-6: Derivación de problemas a la agencia preferida', () => {
  let sesion: SesionE2E;
  const agencia = 'viajes-del-plata';
  const resumenProblema = `Conexión perdida en EZE por vuelo demorado (${idAleatorio()}).`;

  beforeAll(async () => {
    sesion = await registrarYLogin({ nombre: 'Viajero UC6' });
  });

  afterAll(async () => {
    await reiniciarMock(CONFIG_E2E.urlMockAgencia);
  });

  it('crea un caso en la agencia preferida del perfil con el resumen y los datos de contacto', async () => {
    // 1. Configurar agencia preferida en el perfil de Usuarios.
    const respPerfil = await pedirJson(`${CONFIG_E2E.urlEnrutador}/api/usuarios/perfil`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sesion.jwt}`,
        'X-Region': sesion.region,
      },
      body: JSON.stringify({ agenciaPreferida: agencia }),
    });
    expect(respPerfil.status).toBe(200);

    // 2. Derivar problema: POST /api/integraciones/agencias/casos
    const respCaso = await pedirJson<{
      agencia: string;
      numeroCaso: string;
      creadoEn: string;
    }>(`${CONFIG_E2E.urlEnrutador}/api/integraciones/agencias/casos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sesion.jwt}`,
        'X-Region': sesion.region,
      },
      body: JSON.stringify({ resumen: resumenProblema }),
    });
    expect(respCaso.status).toBe(201);
    expect(respCaso.datos?.agencia).toBe(agencia);
    const numeroCaso = respCaso.datos?.numeroCaso ?? '';
    expect(numeroCaso).toBeTruthy();

    // 3. Verificar en mock-agencia (GET /admin/casos) que el ticket fue recibido con los datos esperados.
    interface CasoAdmin {
      id: string | number;
      asunto?: string;
      subject?: string;
      descripcion?: string;
      description?: string;
      contacto?: { nombre?: string; email?: string };
      requester?: { name?: string; email?: string };
    }
    interface ListaCasos {
      casos: CasoAdmin[];
    }

    const respAdmin = await pedirJson<ListaCasos>(`${CONFIG_E2E.urlMockAgencia}/admin/casos`);
    expect(respAdmin.status).toBe(200);

    const casos = respAdmin.datos?.casos ?? [];
    const casoEncontrado = casos.find((c) => String(c.id) === numeroCaso);
    expect(casoEncontrado).toBeDefined();

    const textoCaso = JSON.stringify(casoEncontrado);
    expect(textoCaso).toContain(resumenProblema);
  });
});
