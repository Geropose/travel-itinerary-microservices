import { randomUUID } from 'node:crypto';
import {
  crearEvento,
  crearValidador,
  validadorEventos,
  type AccesoRechazado,
  type ClienteDb,
  type Pool,
} from '@trotamundos/comun';
import { firmarJwt, generarClaves, loggerDePrueba } from '@trotamundos/comun/pruebas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crearApp, reglasDeRutas } from '../src/app.ts';
import { crearCuenta, designarPersonaConCuenta } from '../src/repositorio.ts';

describe('Auditoría de Usuarios (sin Docker)', () => {
  const { logger } = loggerDePrueba('usuarios-auditoria');
  const cierres: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cierres.length > 0) {
      await cierres.pop()?.();
    }
  });

  it('B8: rechazo con X-Forwarded-For falso omite ip inválida para cumplir AccesoRechazado', async () => {
    const claves = await generarClaves('u1');
    const rechazos: AccesoRechazado[] = [];
    const validador = crearValidadorPrueba(claves, logger, rechazos);
    await validador.iniciar();
    cierres.push(async () => validador.detener());

    const app = crearApp({
      region: 'region-1',
      puerto: 0,
      logger,
      manejarSenales: false,
      validador,
      negocio: {
        pool: {} as Pool,
        viajes: { esDueno: async () => false },
        agencias: new Set(['viajes-del-plata']),
        registrar: (r) => rechazos.push(r),
      },
    });
    const base = `http://127.0.0.1:${await app.iniciar()}`;
    cierres.push(() => app.detener());

    const usuarioA = randomUUID();
    const usuarioB = randomUUID();
    const token = await firmarJwt(claves, { sub: usuarioA, roles: ['usuario'] });
    const res = await fetch(
      `${base}/interna/permisos/itinerarios/${randomUUID()}?usuarioId=${usuarioB}`,
      { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': 'forged-ip' } },
    );
    expect(res.status).toBe(403);
    expect(rechazos).toHaveLength(1);
    expect(rechazos[0]?.ip).toBeUndefined();
    const schema = validadorEventos();
    expect(() =>
      schema.validar(crearEvento('AccesoRechazado', rechazos[0], 'region-1')),
    ).not.toThrow();
  });

  it('B9 y A5: designarPersonaConCuenta serializa con advisory lock y crearCuenta es idempotente', async () => {
    const consultas: string[] = [];
    const mariaId = randomUUID();
    const dbDesignado = {
      query: vi.fn(async (sql: string) => {
        consultas.push(sql);
        if (sql.includes('SELECT usuario_id AS "usuarioId", email FROM cuentas')) {
          return { rows: [{ usuarioId: mariaId, email: 'maria@correo.example' }] };
        }
        if (sql.includes('INSERT INTO designados_itinerario')) {
          return {
            rows: [
              {
                email: 'maria@correo.example',
                usuarioId: mariaId,
                designadoEn: new Date('2026-11-22T12:00:00Z'),
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as ClienteDb;

    const designado = await designarPersonaConCuenta(
      dbDesignado,
      randomUUID(),
      '  Maria@Correo.Example ',
    );
    expect(consultas[0]).toContain('pg_advisory_xact_lock');
    expect(designado.usuarioId).toBe(mariaId);

    const dbIdempotente = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM cuentas')) {
          return {
            rows: [
              {
                usuarioId: mariaId,
                email: 'maria@correo.example',
                nombre: 'María',
                region: 'region-1',
                idioma: 'es',
                moneda: 'USD',
                agenciaPreferida: null,
                creadoEn: new Date('2026-11-22T12:00:00Z'),
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as ClienteDb;

    const perfil = await crearCuenta(dbIdempotente, {
      usuarioId: mariaId,
      email: 'Maria@Correo.Example',
      nombre: 'María',
      region: 'region-1',
      idioma: 'es',
    });
    expect(perfil.usuarioId).toBe(mariaId);
  });
});

function crearValidadorPrueba(
  claves: Awaited<ReturnType<typeof generarClaves>>,
  logger: ReturnType<typeof loggerDePrueba>['logger'],
  rechazos: AccesoRechazado[],
) {
  return crearValidador({
    servicio: 'usuarios',
    region: 'region-1',
    logger,
    claves: { 'region-1': { claves: claves.jwks } },
    registrar: (r) => rechazos.push(r),
    reglas: reglasDeRutas(),
  });
}
