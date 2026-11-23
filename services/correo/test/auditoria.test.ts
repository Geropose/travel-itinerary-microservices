import { randomBytes, randomUUID } from 'node:crypto';
import {
  crearValidador,
  ErrorEventoInvalido,
  type ClienteDb,
  type Pool,
  type ValidadorEventos,
} from '@trotamundos/comun';
import { firmarJwt, generarClaves, loggerDePrueba } from '@trotamundos/comun/pruebas';
import type { ConsumeMessage } from 'amqplib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crearRegistroAdaptadores } from '../src/adaptadores/registro.ts';
import { ErrorProveedorCorreo, type AdaptadorCorreo } from '../src/adaptadores/tipos.ts';
import { crearApp } from '../src/app.ts';
import { encriptarTexto } from '../src/cifrado.ts';
import {
  ErrorColaNoDisponible,
  ErrorProcesadorDeteniendo,
  procesarMensajeCola,
} from '../src/cola.ts';
import { crearExaminador } from '../src/examinador.ts';
import { crearProcesadorCorreo } from '../src/procesador.ts';
import { guardarCuentaConectada, guardarResultadosCorreosProcesados } from '../src/repositorio.ts';
import type { GestorTokens } from '../src/tokens.ts';

function jsonLdVuelo(codigo: string) {
  return `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FlightReservation',
    reservationNumber: codigo,
    reservationStatus: 'https://schema.org/ReservationConfirmed',
    reservationFor: {
      '@type': 'Flight',
      flightNumber: 'AN 123',
      departureTime: '2026-12-10T10:00:00Z',
      arrivalTime: '2026-12-10T13:00:00Z',
      departureAirport: { iataCode: 'EZE' },
      arrivalAirport: { iataCode: 'SCL' },
    },
  })}</script>`;
}

describe('Auditoría de Correo (sin Docker)', () => {
  const { logger } = loggerDePrueba('correo-auditoria');
  const claveTokens = randomBytes(32);
  const cuentaId = randomUUID();
  const usuarioId = randomUUID();
  const cierres: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cierres.length > 0) {
      await cierres.pop()?.();
    }
  });

  it('B1: ErrorProcesadorDeteniendo no avanza ultimo_cursor y procesa nack(requeue=true) en cola', async () => {
    const canal = { ack: vi.fn(), nack: vi.fn() };
    const mensaje = {
      content: Buffer.from(
        JSON.stringify({
          trabajoId: randomUUID(),
          cuentaId,
          usuarioId,
          proveedor: 'gmail',
          email: 'ana@gmail.example',
          origen: 'periodica',
          prioridad: 3,
          creadoEn: new Date().toISOString(),
        }),
        'utf8',
      ),
    } as ConsumeMessage;

    await procesarMensajeCola(
      canal,
      mensaje,
      {
        manejar: async () => {
          throw new ErrorProcesadorDeteniendo();
        },
        esperasReintentoMs: [0],
      },
      logger,
    );
    expect(canal.ack).not.toHaveBeenCalled();
    expect(canal.nack).toHaveBeenCalledWith(mensaje, false, true);

    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('INSERT INTO correos_procesados')) {
          return { rows: [{ cuenta_id: cuentaId, correo_id: 'm1' }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM cuentas_correo') && sql.includes('WHERE id = $1')) {
          return {
            rows: [
              {
                id: cuentaId,
                usuario_id: usuarioId,
                proveedor: 'gmail',
                email: 'ana@gmail.example',
                estado: 'conectada',
                ultimo_cursor: '100',
                ultima_revision: null,
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as Pool;

    const procesadorRef: { actual?: ReturnType<typeof crearProcesadorCorreo> } = {};
    const adaptadorMock = {
      proveedor: 'gmail',
      leerMensaje: vi.fn(async (_token: string, id: string) => {
        if (id === 'm1') {
          void procesadorRef.actual?.detener();
        }
        return {
          id,
          remitente: 'reservas@aerolinea-andina.example',
          asunto: 'Reserva',
          recibidoEn: new Date('2026-11-20T10:00:00Z'),
          cuerpoHtml: jsonLdVuelo(`RES-${id}`),
        };
      }),
    } as unknown as AdaptadorCorreo;

    const ids60 = Array.from({ length: 60 }, (_, i) => `m${i + 1}`);
    const gestorTokens = {
      listarNuevosCuenta: vi.fn(async () => ({
        mensajes: ids60.map((id) => ({ id })),
        nuevoCursor: '9999',
      })),
      ejecutarConToken: vi.fn((_cId, fn) => fn(adaptadorMock, 'tok')),
    } as unknown as GestorTokens;

    const procesador = crearProcesadorCorreo({
      pool,
      region: 'region-1',
      gestorTokens,
      logger,
      cantidadProcesadores: 1,
      concurrenciaLectura: 1,
    });
    procesadorRef.actual = procesador;

    await expect(
      procesador.procesarTrabajo({
        trabajoId: randomUUID(),
        cuentaId,
        usuarioId,
        proveedor: 'gmail',
        email: 'ana@gmail.example',
        origen: 'periodica',
        prioridad: 3,
        creadoEn: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(ErrorProcesadorDeteniendo);

    expect(queries.some((q) => q.includes('SET ultima_revision'))).toBe(false);
  });

  it('B2: aviso push puntual de Outlook conserva revision_prioritaria y no adelanta ultimo_cursor', async () => {
    const consultasExaminador: Array<{ sql: string; params: unknown[] }> = [];
    const poolExaminador = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        consultasExaminador.push({ sql, params });
        return { rows: [] };
      }),
    } as unknown as Pool;
    const examinador = crearExaminador({
      pool: poolExaminador,
      cola: {
        encolar: vi.fn(async () => undefined),
        consumir: vi.fn(async () => undefined),
        conectado: () => true,
        verificar: async () => undefined,
        cerrar: async () => undefined,
      },
      adaptadores: {
        obtener: () => undefined,
        listar: () => [],
      },
      logger,
      intervalos: { cicloMs: 30_000, viajeProximoMs: 300_000, normalMs: 3_600_000 },
      backoff429: { inicialMs: 1000, maxMs: 60_000 },
    });

    await examinador.encolarPorPush({
      cuentaId,
      usuarioId,
      proveedor: 'outlook',
      email: 'ana@outlook.example',
      bloqueadoHasta: null,
      push: { mensajeIds: ['msg-push-1'] },
    });

    const updateEncolada = consultasExaminador.find((q) => q.sql.includes('UPDATE cuentas_correo'));
    expect(updateEncolada?.params[2]).toBe(false);

    let cursorGuardado: unknown = 'NO-SETEADO';
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO correos_procesados')) {
          return { rows: [{ cuenta_id: cuentaId, correo_id: 'msg-push-1' }] };
        }
        if (sql.includes('SELECT ultimo_cursor, ultima_revision')) {
          return { rows: [{ ultimo_cursor: null, ultima_revision: null }] };
        }
        if (sql.includes('SET ultima_revision')) {
          cursorGuardado = params?.[2];
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const poolProc = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM cuentas_correo') && sql.includes('WHERE id = $1')) {
          return {
            rows: [
              {
                id: cuentaId,
                usuario_id: usuarioId,
                proveedor: 'outlook',
                email: 'ana@outlook.example',
                estado: 'conectada',
                ultimo_cursor: null,
                ultima_revision: null,
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as Pool;

    const adaptador = {
      proveedor: 'outlook',
      leerMensaje: vi.fn(async () => ({
        id: 'msg-push-1',
        remitente: 'hola@ejemplo.invalid',
        asunto: 'Hola',
        recibidoEn: new Date('2026-11-22T12:00:00Z'),
        cursor: '2026-11-22T12:00:00Z',
        cuerpoTexto: 'Sin reserva',
      })),
    } as unknown as AdaptadorCorreo;

    const procesador = crearProcesadorCorreo({
      pool: poolProc,
      region: 'region-1',
      gestorTokens: {
        listarNuevosCuenta: vi.fn(),
        ejecutarConToken: vi.fn((_id, fn) => fn(adaptador, 'tok')),
      } as unknown as GestorTokens,
      logger,
      cantidadProcesadores: 1,
    });

    await procesador.procesarTrabajo({
      trabajoId: randomUUID(),
      cuentaId,
      usuarioId,
      proveedor: 'outlook',
      email: 'ana@outlook.example',
      origen: 'push',
      prioridad: 1,
      creadoEn: new Date().toISOString(),
      push: { mensajeIds: ['msg-push-1'] },
    });

    expect(cursorGuardado).toBeNull();
  });

  it('B3 y B7: aísla evento inválido en no_procesados y omite correos eliminados (404) sin abortar el lote', async () => {
    const outboxPayloads: unknown[] = [];
    const noProcesadosInsertados: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO correos_procesados')) {
          return {
            rows: [
              { cuenta_id: cuentaId, correo_id: 'venenoso' },
              { cuenta_id: cuentaId, correo_id: 'valido' },
            ],
          };
        }
        if (sql.includes('INSERT INTO no_procesados')) {
          noProcesadosInsertados.push(...((params?.[4] as string[]) ?? []));
        }
        if (sql.includes('INSERT INTO eventos_salientes')) {
          outboxPayloads.push(params);
        }
        if (sql.includes('SELECT ultimo_cursor, ultima_revision')) {
          return { rows: [{ ultimo_cursor: null, ultima_revision: null }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM cuentas_correo') && sql.includes('WHERE id = $1')) {
          return {
            rows: [
              {
                id: cuentaId,
                usuario_id: usuarioId,
                proveedor: 'gmail',
                email: 'ana@gmail.example',
                estado: 'conectada',
                ultimo_cursor: null,
                ultima_revision: null,
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as Pool;

    const adaptador = {
      proveedor: 'gmail',
      leerMensaje: vi.fn(async (_t: string, id: string) => {
        if (id === 'borrado') {
          throw new ErrorProveedorCorreo('mensaje-no-encontrado', 'No existe');
        }
        return {
          id,
          remitente: 'reservas@aerolinea-andina.example',
          asunto: 'Reserva',
          recibidoEn: new Date('2026-11-22T10:00:00Z'),
          cuerpoHtml: jsonLdVuelo(id === 'venenoso' ? 'VEN1' : 'VAL2'),
        };
      }),
    } as unknown as AdaptadorCorreo;

    let llamadasValidador = 0;
    const validadorFalso = {
      validar: vi.fn((sobre: unknown) => {
        llamadasValidador++;
        if (llamadasValidador === 1) {
          throw new ErrorEventoInvalido(['/datos/inicio inválido']);
        }
        return sobre;
      }),
    } as unknown as ValidadorEventos;

    const procesador = crearProcesadorCorreo({
      pool,
      region: 'region-1',
      gestorTokens: {
        listarNuevosCuenta: vi.fn(async () => ({
          mensajes: [{ id: 'borrado' }, { id: 'venenoso' }, { id: 'valido' }],
          nuevoCursor: '200',
        })),
        ejecutarConToken: vi.fn((_id, fn) => fn(adaptador, 'tok')),
      } as unknown as GestorTokens,
      logger,
      cantidadProcesadores: 1,
      validador: validadorFalso,
    });

    await procesador.procesarTrabajo({
      trabajoId: randomUUID(),
      cuentaId,
      usuarioId,
      proveedor: 'gmail',
      email: 'ana@gmail.example',
      origen: 'periodica',
      prioridad: 3,
      creadoEn: new Date().toISOString(),
    });

    expect(noProcesadosInsertados).toEqual(['venenoso']);
    expect(outboxPayloads).toHaveLength(1);
  });

  it('B5 y B12: fallo de Outlook push en cuenta A no pierde avisos de cuenta B y DELETE usa ejecutarConToken', async () => {
    const vistas = new Set<string>();
    const encoladas: string[] = [];
    let fallarPrimera = true;
    const claves = await generarClaves('correo-test');
    const c1 = randomUUID();
    const c2 = randomUUID();
    const sub1 = randomUUID();
    const sub2 = randomUUID();
    const sec1 = encriptarTexto(claveTokens, 'sec-1', usuarioId);
    const sec2 = encriptarTexto(claveTokens, 'sec-2', usuarioId);

    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('suscripcion_id = $2')) {
          const sub = String(params?.[1] ?? '');
          return {
            rows: [
              sub === sub1
                ? {
                    id: c1,
                    usuario_id: usuarioId,
                    email: 'u1@outlook.example',
                    suscripcion_secreto_cifrado: sec1,
                    bloqueado_hasta: null,
                  }
                : {
                    id: c2,
                    usuario_id: usuarioId,
                    email: 'u2@outlook.example',
                    suscripcion_secreto_cifrado: sec2,
                    bloqueado_hasta: null,
                  },
            ],
          };
        }
        if (sql.includes('INSERT INTO avisos_push_vistos')) {
          const id = String(params?.[1] ?? '');
          if (vistas.has(id)) return { rowCount: 0, rows: [] };
          vistas.add(id);
          return { rowCount: 1, rows: [{ aviso_id: id }] };
        }
        if (sql.includes('DELETE FROM avisos_push_vistos')) {
          vistas.delete(String(params?.[1] ?? ''));
          return { rows: [] };
        }
        if (sql.includes('SELECT id, proveedor, suscripcion_id')) {
          return { rows: [{ id: c1, proveedor: 'outlook', suscripcion_id: sub1 }] };
        }
        if (sql.includes('DELETE FROM cuentas_correo')) return { rowCount: 1, rows: [] };
        return { rows: [] };
      }),
    } as unknown as Pool;

    const adaptadorOutlook = {
      proveedor: 'outlook',
      soportaPush: true,
      urlAutorizacion: () => 'http://x',
      canjearCodigo: vi.fn(),
      renovarToken: vi.fn(),
      listarNuevos: vi.fn(),
      leerMensaje: vi.fn(),
      desuscribirAvisos: vi.fn(async () => undefined),
    } as unknown as AdaptadorCorreo;
    const registro = crearRegistroAdaptadores([adaptadorOutlook]);

    const ejecutarConToken = vi.fn(
      async (_id: string, fn: (a: AdaptadorCorreo, t: string) => Promise<void>) =>
        fn(adaptadorOutlook, 'tok-renovado'),
    );
    const validador = crearValidador({
      servicio: 'correo',
      region: 'region-1',
      logger,
      claves: { 'region-1': { claves: claves.jwks } },
      registrar: () => undefined,
    });
    await validador.iniciar();
    cierres.push(async () => validador.detener());

    const app = crearApp({
      region: 'region-1',
      puerto: 0,
      logger,
      manejarSenales: false,
      validador,
      negocio: {
        pool,
        claveTokens,
        adaptadores: registro,
        gestorTokens: { ejecutarConToken } as unknown as GestorTokens,
        urlWeb: 'http://localhost:5173',
        logger,
        examinador: {
          encolarPorPush: vi.fn(async ({ cuentaId: id }) => {
            if (fallarPrimera) {
              fallarPrimera = false;
              throw new ErrorColaNoDisponible();
            }
            encoladas.push(id);
            return { encolado: true };
          }),
          ejecutarCiclo: vi.fn(async () => []),
          registrarLimiteCuota: vi.fn(),
          limpiarLimiteCuota: vi.fn(),
          iniciar: vi.fn(),
          detener: vi.fn(async () => undefined),
        },
      },
    });
    const base = `http://127.0.0.1:${await app.iniciar()}`;
    cierres.push(() => app.detener());

    const lote = {
      value: [
        {
          id: 'aviso-a',
          subscriptionId: sub1,
          clientState: 'sec-1',
          changeType: 'created',
          resource: 'Users/u1/Messages/msg-a',
          resourceData: { id: 'msg-a' },
        },
        {
          id: 'aviso-b',
          subscriptionId: sub2,
          clientState: 'sec-2',
          changeType: 'created',
          resource: 'Users/u2/Messages/msg-b',
          resourceData: { id: 'msg-b' },
        },
      ],
    };

    const r1 = await fetch(`${base}/notificaciones/outlook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lote),
    });
    expect(r1.status).toBe(503);

    const r2 = await fetch(`${base}/notificaciones/outlook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lote),
    });
    expect(r2.status).toBe(202);
    expect(encoladas).toEqual([c1, c2]);

    const jwt = await firmarJwt(claves, { sub: usuarioId, roles: ['usuario'] });
    const rDel = await fetch(`${base}/cuentas-correo/${c1}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(rDel.status).toBe(204);
    expect(ejecutarConToken).toHaveBeenCalledTimes(1);
    expect(adaptadorOutlook.desuscribirAvisos).toHaveBeenCalledWith('tok-renovado', sub1);
  });

  it('B6 y B13: carrera al conectar cuenta devuelve cuenta-de-otro-usuario y no_procesados normaliza remitente inválido', async () => {
    const otroUsuario = randomUUID();
    let selects = 0;
    const dbCarrera = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT id, usuario_id')) {
          selects++;
          return selects === 1
            ? { rows: [] }
            : { rows: [{ id: randomUUID(), usuario_id: otroUsuario }] };
        }
        if (sql.includes('INSERT INTO cuentas_correo')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    } as unknown as ClienteDb;

    const resultado = await guardarCuentaConectada(dbCarrera, claveTokens, {
      usuarioId,
      proveedor: 'gmail',
      email: 'compartida@gmail.example',
      credenciales: {
        accessToken: 'acc',
        refreshToken: 'ref',
        expiraEn: new Date(Date.now() + 3600_000),
        scope: 'readonly',
      },
    });
    expect(resultado).toEqual({ resultado: 'cuenta-de-otro-usuario' });

    let remitentesInsertados: string[] = [];
    const dbNoProc = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO correos_procesados')) {
          return { rows: [{ cuenta_id: cuentaId, correo_id: 'c-bad-from' }] };
        }
        if (sql.includes('INSERT INTO no_procesados')) {
          remitentesInsertados = (params?.[5] as string[]) ?? [];
        }
        return { rows: [] };
      }),
    } as unknown as ClienteDb;

    await guardarResultadosCorreosProcesados(dbNoProc, [
      {
        cuentaId,
        usuarioId,
        proveedorCorreo: 'gmail',
        correoId: 'c-bad-from',
        remitente: 'Mailer-Daemon',
        asunto: 'Confirmación de reserva',
        recibidoEn: new Date('2026-11-22T10:00:00Z'),
        ahora: new Date('2026-11-22T10:00:05Z'),
        noProcesado: { motivo: 'sin-regla', detalle: 'Sin regla' },
      },
    ]);
    expect(remitentesInsertados).toEqual(['desconocido@remitente.invalid']);
  });
});
