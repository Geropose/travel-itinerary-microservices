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
import { crearApp, SERVICIO } from '../src/app.ts';
import { crearTareaArchivado } from '../src/archivado.ts';
import { crearCacheNula, type CachePanel } from '../src/cache.ts';
import { crearGestorViajes, type ErrorNegocioViajes } from '../src/gestor.ts';
import { crearNegocioViajes, REGLAS_VALIDADOR_VIAJES } from '../src/rutas.ts';

describe('Auditoría de Viajes (sin Docker)', () => {
  const cierres: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cierres.length > 0) {
      await cierres.pop()?.();
    }
  });

  it('C5: omite numeroReserva, usuarioId y viajeId en logs operativos de gestor y rutas', async () => {
    const { logger, lineas } = loggerDePrueba('viajes-logs');
    const usuarioDueno = randomUUID();
    const usuarioAjeno = randomUUID();
    const viajePrivadoId = randomUUID();
    const numeroSecreto = 'RES-CONFIDENCIAL-999';

    const gestor = crearGestorViajes({ region: 'region-1', logger });

    const dbConflicto = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (
          sql.includes('FROM reservas') &&
          sql.includes('WHERE proveedor = $1') &&
          params?.[1] === numeroSecreto
        ) {
          return {
            rows: [
              {
                id: randomUUID(),
                viaje_id: viajePrivadoId,
                usuario_id: usuarioAjeno,
                proveedor: 'aerolinea-andina',
                tipo_reserva: 'vuelo',
                numero_reserva: numeroSecreto,
                inicio: new Date('2026-12-10T10:00:00Z'),
                fin: new Date('2026-12-10T13:00:00Z'),
                origen: 'EZE',
                destino: 'SCL',
                detalle: {},
                estado: 'confirmada',
                origen_cambio: 'correo',
                correo_id: null,
                actualizado_en: new Date('2026-11-22T10:00:00Z'),
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as ClienteDb;

    await gestor.procesarReservaDetectada(dbConflicto, {
      usuarioId: usuarioDueno,
      proveedor: 'aerolinea-andina',
      tipoReserva: 'vuelo',
      numeroReserva: numeroSecreto,
      inicio: '2026-12-10T10:00:00Z',
      fin: '2026-12-10T13:00:00Z',
      origen: 'EZE',
      destino: 'SCL',
      estado: 'confirmada',
      detalle: {},
      correoId: 'msg-1',
    });

    await gestor.procesarReservaActualizada(dbConflicto, {
      proveedor: 'aerolinea-andina',
      numeroReserva: 'RES-INEXISTENTE-888',
      estado: 'cancelada',
      origenCambio: 'proveedor',
      cambios: {},
    });

    const poolViaje = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM viajes')) {
          return {
            rows: [
              {
                id: viajePrivadoId,
                usuario_id: usuarioDueno,
                nombre: 'Viaje a SCL',
                destino: 'SCL',
                inicio: new Date('2026-12-10T10:00:00Z'),
                fin: new Date('2026-12-12T10:00:00Z'),
                estado: 'activo',
              },
            ],
          };
        }
        if (sql.includes('FROM reservas')) {
          return {
            rows: [
              {
                id: randomUUID(),
                viaje_id: viajePrivadoId,
                usuario_id: usuarioDueno,
                proveedor: 'aerolinea-andina',
                tipo_reserva: 'vuelo',
                numero_reserva: numeroSecreto,
                inicio: new Date('2026-12-10T10:00:00Z'),
                fin: new Date('2026-12-10T13:00:00Z'),
                origen: 'EZE',
                destino: 'SCL',
                detalle: {},
                estado: 'confirmada',
                origen_cambio: 'manual',
                correo_id: null,
                actualizado_en: new Date('2026-11-22T10:00:00Z'),
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as Pool;

    const negocio = crearNegocioViajes({
      poolPrincipal: poolViaje,
      cache: crearCacheNula(),
      gestor,
      logger,
      clienteIntegraciones: {
        post: async () => {
          throw new Error('ECONNREFUSED');
        },
        get: async () => {
          throw new Error('unused');
        },
        patch: async () => {
          throw new Error('unused');
        },
        delete: async () => {
          throw new Error('unused');
        },
      } as never,
    });

    await expect(
      negocio.compartirEnRed(usuarioDueno, viajePrivadoId, 'redsocial', 'tok'),
    ).rejects.toThrow();

    const serializado = JSON.stringify(lineas);
    expect(serializado).not.toContain(numeroSecreto);
    expect(serializado).not.toContain('RES-INEXISTENTE-888');
    expect(serializado).not.toContain(usuarioDueno);
    expect(serializado).not.toContain(usuarioAjeno);
    expect(serializado).not.toContain(viajePrivadoId);
  });

  it('C6: obtenerPanel lee de principal durante mutacionReciente y pasa versionAntes al guardar cache', async () => {
    const { logger } = loggerDePrueba('viajes-cache');
    const usuarioId = randomUUID();
    const viajePrincipalId = randomUUID();

    const poolPrincipal = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM viajes')) {
          return {
            rows: [
              {
                id: viajePrincipalId,
                usuario_id: usuarioId,
                nombre: 'Principal',
                destino: 'Principal',
                inicio: new Date('2026-12-10T10:00:00Z'),
                fin: new Date('2026-12-12T10:00:00Z'),
                estado: 'activo',
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as Pool;

    const poolLectura = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;

    const cache: CachePanel = {
      obtener: vi.fn(async () => null),
      obtenerVersion: vi.fn(async () => '42'),
      mutacionReciente: vi.fn(async () => true),
      guardar: vi.fn(async () => undefined),
      invalidar: vi.fn(async () => undefined),
      cerrar: vi.fn(async () => undefined),
    };

    const negocio = crearNegocioViajes({
      poolPrincipal,
      poolLectura,
      cache,
      gestor: crearGestorViajes({ region: 'region-1', logger }),
      logger,
    });

    const res = await negocio.obtenerPanel(usuarioId);
    expect(res.panel.viajes[0]?.destino).toBe('Principal');
    expect(poolLectura.query).not.toHaveBeenCalled();
    expect(cache.guardar).toHaveBeenCalledWith(usuarioId, res.panel, '42');
  });

  it('C7: archivado destruye la conexión (release(true)) si falla ROLLBACK o pg_advisory_unlock', async () => {
    const { logger } = loggerDePrueba('viajes-archivado');

    const clienteFallaRollback = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ adquirido: true }] };
        if (sql.includes('FROM viajes')) throw new Error('Error de lectura en archivado');
        if (sql === 'ROLLBACK') throw new Error('ROLLBACK falló');
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const tareaA = crearTareaArchivado({
      pool: { connect: vi.fn(async () => clienteFallaRollback) } as unknown as Pool,
      cache: crearCacheNula(),
      region: 'region-1',
      logger,
    });
    await expect(tareaA.ejecutar()).rejects.toThrow(/Error de lectura/);
    expect(clienteFallaRollback.release).toHaveBeenCalledWith(true);

    const clienteFallaUnlock = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ adquirido: true }] };
        if (sql.includes('pg_advisory_unlock')) throw new Error('unlock falló');
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const tareaB = crearTareaArchivado({
      pool: { connect: vi.fn(async () => clienteFallaUnlock) } as unknown as Pool,
      cache: crearCacheNula(),
      region: 'region-1',
      logger,
    });
    await tareaB.ejecutar();
    expect(clienteFallaUnlock.release).toHaveBeenCalledWith(true);

    const clienteOk = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ adquirido: true }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const tareaC = crearTareaArchivado({
      pool: { connect: vi.fn(async () => clienteOk) } as unknown as Pool,
      cache: crearCacheNula(),
      region: 'region-1',
      logger,
    });
    await tareaC.ejecutar();
    expect(clienteOk.release).toHaveBeenCalledWith(false);
  });

  it('C9: registrarProhibido valida ipDe(req) y omite X-Forwarded-For falso para AccesoRechazado', async () => {
    const { logger } = loggerDePrueba('viajes-ip');
    const claves = await generarClaves('v1');
    const rechazos: AccesoRechazado[] = [];
    const validador = crearValidador({
      servicio: SERVICIO,
      region: 'region-1',
      logger,
      claves: { 'region-1': { claves: claves.jwks } },
      registrar: (r) => rechazos.push(r),
      reglas: REGLAS_VALIDADOR_VIAJES,
    });
    await validador.iniciar();
    cierres.push(async () => validador.detener());

    const app = crearApp({
      region: 'region-1',
      puerto: 0,
      logger,
      manejarSenales: false,
      validador,
      negocio: crearNegocioViajes({
        poolPrincipal: {} as Pool,
        cache: crearCacheNula(),
        gestor: crearGestorViajes({ region: 'region-1', logger }),
        logger,
        registrar: (r) => rechazos.push(r),
      }),
    });
    const base = `http://127.0.0.1:${await app.iniciar()}`;
    cierres.push(() => app.detener());

    const jwt = await firmarJwt(claves, { sub: randomUUID(), roles: ['usuario'] });
    const res = await fetch(`${base}/interna/reservas?usuarioId=${randomUUID()}`, {
      headers: {
        authorization: `Bearer ${jwt}`,
        'x-forwarded-for': 'ip-forjada',
      },
    });
    expect(res.status).toBe(403);
    expect(rechazos).toHaveLength(1);
    expect(rechazos[0]?.ip).toBeUndefined();
    const schema = validadorEventos();
    expect(() =>
      schema.validar(crearEvento('AccesoRechazado', rechazos[0], 'region-1')),
    ).not.toThrow();
  });

  it('C13 y C14: recorta textos, rechaza blancos con 400 y valida dueño sin FOR UPDATE en viaje ajeno', async () => {
    const { logger } = loggerDePrueba('viajes-validacion');
    const gestor = crearGestorViajes({ region: 'region-1', logger });
    const usuarioId = randomUUID();
    const otroUsuario = randomUUID();
    const viajeAjenoId = randomUUID();
    const consultas: string[] = [];

    const db = {
      query: vi.fn(async (sql: string) => {
        consultas.push(sql);
        if (sql.includes('FROM viajes') && sql.includes('WHERE id = $1')) {
          return {
            rows: [
              {
                id: viajeAjenoId,
                usuario_id: otroUsuario,
                nombre: 'Ajeno',
                destino: 'Cordoba',
                inicio: new Date('2026-12-10T10:00:00Z'),
                fin: new Date('2026-12-12T10:00:00Z'),
                estado: 'activo',
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as ClienteDb;

    await expect(
      gestor.crearReservaManual(db, usuarioId, {
        proveedor: '   ',
        tipoReserva: 'hotel',
        numeroReserva: 'HTL-1',
        inicio: '2026-12-10T10:00:00Z',
        fin: '2026-12-12T10:00:00Z',
        destino: 'Cordoba',
      }),
    ).rejects.toMatchObject<Partial<ErrorNegocioViajes>>({ codigo: 'solicitud-invalida' });

    await expect(
      gestor.crearReservaManual(db, usuarioId, {
        proveedor: 'aerolinea-andina',
        tipoReserva: 'vuelo',
        numeroReserva: 'FLT-1',
        inicio: '2026-12-10T10:00:00Z',
        fin: '2026-12-10T12:00:00Z',
        origen: '   ',
        destino: 'Santiago',
      }),
    ).rejects.toMatchObject<Partial<ErrorNegocioViajes>>({ codigo: 'solicitud-invalida' });

    await expect(
      gestor.crearReservaManual(db, usuarioId, {
        viajeId: viajeAjenoId,
        proveedor: 'hotel-cordillera',
        tipoReserva: 'hotel',
        numeroReserva: 'HTL-2',
        inicio: '2026-12-10T10:00:00Z',
        fin: '2026-12-12T10:00:00Z',
        destino: 'Cordoba',
      }),
    ).rejects.toMatchObject<Partial<ErrorNegocioViajes>>({ codigo: 'prohibido' });

    expect(consultas.some((sql) => sql.includes('FROM viajes') && sql.includes('FOR UPDATE'))).toBe(
      false,
    );

    let insertParams: unknown[] = [];
    const dbAlta = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO viajes')) {
          return {
            rows: [
              {
                id: randomUUID(),
                usuario_id: usuarioId,
                nombre: 'Viaje a Bariloche',
                destino: 'Bariloche',
                inicio: new Date('2026-12-10T10:00:00Z'),
                fin: new Date('2026-12-10T12:00:00Z'),
                estado: 'activo',
              },
            ],
          };
        }
        if (sql.includes('INSERT INTO reservas')) {
          insertParams = params ?? [];
          return {
            rows: [
              {
                id: randomUUID(),
                viaje_id: randomUUID(),
                usuario_id: usuarioId,
                proveedor: 'aerolinea-andina',
                tipo_reserva: 'vuelo',
                numero_reserva: 'FLT-TRIM',
                inicio: new Date('2026-12-10T10:00:00Z'),
                fin: new Date('2026-12-10T12:00:00Z'),
                origen: 'AEP',
                destino: 'BRC',
                detalle: {},
                estado: 'confirmada',
                origen_cambio: 'manual',
                correo_id: null,
                actualizado_en: new Date('2026-11-22T10:00:00Z'),
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as ClienteDb;

    await gestor.crearReservaManual(dbAlta, usuarioId, {
      proveedor: '  aerolinea-andina  ',
      tipoReserva: 'vuelo',
      numeroReserva: '  FLT-TRIM ',
      inicio: '2026-12-10T10:00:00Z',
      fin: '2026-12-10T12:00:00Z',
      origen: '  AEP ',
      destino: ' BRC  ',
    });
    expect(insertParams).toContain('aerolinea-andina');
    expect(insertParams).toContain('FLT-TRIM');
    expect(insertParams).toContain('AEP');
    expect(insertParams).toContain('BRC');
  });
});
