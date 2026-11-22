import { describe, expect, it, vi } from 'vitest';
import {
  crearLogger,
  type Broker,
  type ClienteDb,
  type EfectoPostCommit,
  type OpcionesConsumidor,
  type Pool,
} from '@trotamundos/comun';
import { registrarConsumidoresViajes } from '../src/consumidores.ts';
import type { GestorViajes } from '../src/gestor.ts';
import type { Reserva } from '../src/modelo.ts';

const reservaEjemplo: Reserva = {
  reservaId: 'r-1',
  viajeId: 'v-1',
  usuarioId: 'u-1',
  proveedor: 'aerolinea',
  tipoReserva: 'vuelo',
  numeroReserva: 'RES-1',
  inicio: '2026-06-10T10:00:00Z',
  fin: '2026-06-10T13:00:00Z',
  destino: 'Mendoza',
  estado: 'confirmada',
  detalle: {},
  origenCambio: 'correo',
  actualizadoEn: '2026-06-01T00:00:00Z',
};

describe('registrarConsumidoresViajes', () => {
  it('registra alCambiarUsuario en alConfirmar (post-commit) y no lo ejecuta dentro de manejar', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- los tests capturan ambos tipos de consumidor
    const registrados: OpcionesConsumidor<any>[] = [];
    const broker = {
      consumir: vi.fn(async (opciones) => {
        registrados.push(opciones);
      }),
    } as unknown as Broker;
    const pool = {} as Pool;
    const cliente = {} as ClienteDb;
    const alCambiarUsuario = vi.fn();

    const gestor = {
      procesarReservaDetectada: vi
        .fn()
        .mockResolvedValueOnce({
          accion: 'creada' as const,
          reserva: reservaEjemplo,
          viajeId: 'v-1',
          usuarioId: 'u-1',
        })
        .mockResolvedValueOnce({
          accion: 'conflicto-usuario' as const,
          reservaId: 'r-1',
          viajeId: 'v-1',
        }),
      procesarReservaActualizada: vi
        .fn()
        .mockResolvedValueOnce({
          accion: 'actualizada' as const,
          reserva: reservaEjemplo,
          viajeId: 'v-1',
          usuarioId: 'u-2',
        })
        .mockResolvedValueOnce({ accion: 'ignorada' as const }),
    } as unknown as GestorViajes;

    await registrarConsumidoresViajes({
      broker,
      pool,
      gestor,
      logger: crearLogger({ servicio: 'viajes-test', region: 'region-1', nivel: 'silent' }),
      cantidadConsumidores: 1,
      alCambiarUsuario,
    });

    const detectada = registrados.find((c) => c.tipo === 'ReservaDetectada');
    const actualizada = registrados.find((c) => c.tipo === 'ReservaActualizada');
    expect(detectada).toBeDefined();
    expect(actualizada).toBeDefined();
    if (!detectada || !actualizada) return;

    const efectos: EfectoPostCommit[] = [];
    await detectada.manejar({ datos: {} } as never, cliente, (ef) => efectos.push(ef));
    expect(alCambiarUsuario).not.toHaveBeenCalled();
    expect(efectos).toHaveLength(1);

    await efectos.shift()?.();
    expect(alCambiarUsuario).toHaveBeenCalledTimes(1);
    expect(alCambiarUsuario).toHaveBeenCalledWith('u-1');

    await actualizada.manejar({ datos: {} } as never, cliente, (ef) => efectos.push(ef));
    expect(alCambiarUsuario).toHaveBeenCalledTimes(1);
    expect(efectos).toHaveLength(1);

    await efectos.shift()?.();
    expect(alCambiarUsuario).toHaveBeenCalledTimes(2);
    expect(alCambiarUsuario).toHaveBeenLastCalledWith('u-2');

    await detectada.manejar({ datos: {} } as never, cliente, (ef) => efectos.push(ef));
    await actualizada.manejar({ datos: {} } as never, cliente, (ef) => efectos.push(ef));
    expect(efectos).toHaveLength(0);
    expect(alCambiarUsuario).toHaveBeenCalledTimes(2);
  });
});
