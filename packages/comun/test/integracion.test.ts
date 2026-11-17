// Pruebas con PostgreSQL y RabbitMQ reales (testcontainers). Necesitan Docker: en CI siempre
// corren; en una máquina sin Docker se saltean.
import { randomUUID } from 'node:crypto';
import { connect } from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conectarBroker, EXCHANGE, type Broker } from '../src/broker.ts';
import {
  crearPool,
  enTransaccion,
  migrar,
  MIGRACIONES_EVENTOS,
  MIGRACIONES_REGISTRO_ACCESOS,
  type Pool,
} from '../src/db.ts';
import { crearEvento, type Sobre } from '../src/eventos.ts';
import { guardarEnOutbox, iniciarPublicadorOutbox } from '../src/outbox.ts';
import {
  dockerDisponible,
  levantarPostgres,
  levantarRabbit,
  loggerDePrueba,
  type ContenedorPostgres,
  type ContenedorRabbit,
} from '../src/pruebas/index.ts';
import { registroEnBase, type AccesoRechazado } from '../src/registro-accesos.ts';

const hayDocker = await dockerDisponible();
const USUARIO = '6c1e8a2f-4b3d-4e5f-9a0b-1c2d3e4f5a6b';

let postgres: ContenedorPostgres;
let rabbit: ContenedorRabbit;
let pool: Pool;
const brokers: Broker[] = [];
const { logger, lineas } = loggerDePrueba('viajes');

function filtros(usuarioId = USUARIO): Sobre<unknown> {
  return crearEvento(
    'FiltrosActualizados',
    { usuarioId, remitentesPermitidos: ['@aerolinea.com'], filtrosActivos: true },
    'region-1',
  );
}

async function nuevoBroker(servicio = 'viajes'): Promise<Broker> {
  const broker = await conectarBroker({
    url: rabbit.url,
    servicio,
    region: 'region-1',
    logger,
    reconexion: { esperaInicialMs: 100, esperaMaximaMs: 500 },
  });
  brokers.push(broker);
  return broker;
}

/** Espera hasta que la condición se cumpla (o falla a los 10 s). */
async function esperarQue(
  condicion: () => Promise<boolean> | boolean,
  tiempoMs = 10_000,
): Promise<void> {
  const limite = Date.now() + tiempoMs;
  while (!(await condicion())) {
    if (Date.now() > limite) throw new Error('No se cumplió a tiempo');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Mensajes (como texto) que quedaron en una cola (por ejemplo la .dlq). */
async function leerCola(cola: string): Promise<string[]> {
  const conexion = await connect(rabbit.url);
  try {
    const canal = await conexion.createChannel();
    const mensajes: string[] = [];
    for (;;) {
      const m = await canal.get(cola, { noAck: true });
      if (!m) break;
      mensajes.push(m.content.toString('utf8'));
    }
    return mensajes;
  } finally {
    await conexion.close();
  }
}

/** Publica bytes crudos al exchange, sin pasar por la validación del kit. */
async function publicarCrudo(tipo: string, contenido: string): Promise<void> {
  const conexion = await connect(rabbit.url);
  const canal = await conexion.createConfirmChannel();
  canal.publish(EXCHANGE, tipo, Buffer.from(contenido), { persistent: true });
  await canal.waitForConfirms();
  await conexion.close();
}

describe.skipIf(!hayDocker)('con PostgreSQL y RabbitMQ', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    [postgres, rabbit] = await Promise.all([levantarPostgres(), levantarRabbit()]);
    pool = crearPool({ url: postgres.url });
    await pool.query('CREATE TABLE filtros (usuario_id uuid PRIMARY KEY, veces int NOT NULL)');
  }, 180_000);

  afterAll(async () => {
    for (const b of brokers) await b.cerrar();
    await pool?.end();
    await Promise.all([postgres?.detener(), rabbit?.detener()]);
  }, 60_000);

  describe('db', () => {
    it('aplica las migraciones una sola vez, aunque arranquen dos instancias juntas', async () => {
      const carpetas = [MIGRACIONES_EVENTOS, MIGRACIONES_REGISTRO_ACCESOS];
      const [a, b] = await Promise.all([
        migrar(pool, carpetas, logger),
        migrar(pool, carpetas, logger),
      ]);
      expect([...a, ...b].sort()).toEqual([
        '000_comun_accesos_rechazados.sql',
        '000_comun_eventos.sql',
      ]);
      expect(await migrar(pool, carpetas)).toEqual([]);
    });

    it('enTransaccion deshace todo si algo falla', async () => {
      await expect(
        enTransaccion(pool, async (c) => {
          await c.query('INSERT INTO filtros VALUES ($1, 1)', [randomUUID()]);
          throw new Error('falla');
        }),
      ).rejects.toThrow('falla');
      expect((await pool.query('SELECT count(*)::int AS n FROM filtros')).rows[0]).toEqual({
        n: 0,
      });
    });

    it('registroEnBase guarda el rechazo en accesos_rechazados sin hacer esperar', async () => {
      const rechazo: AccesoRechazado = {
        servicio: 'gateway',
        metodo: 'GET',
        ruta: '/api/viajes',
        status: 401,
        motivo: 'sin-token',
        ip: '10.0.0.7',
        requestId: randomUUID(),
      };
      registroEnBase(pool, logger)(rechazo);
      await esperarQue(
        async () =>
          (
            await pool.query('SELECT 1 FROM accesos_rechazados WHERE request_id = $1', [
              rechazo.requestId,
            ])
          ).rowCount === 1,
      );
    });
  });

  describe('broker', () => {
    it('publica y consume; un evento duplicado se ignora', async () => {
      const broker = await nuevoBroker();
      const recibidos: string[] = [];
      await broker.consumir<{ usuarioId: string }>({
        tipo: 'FiltrosActualizados',
        pool,
        manejar: async (evento, cliente) => {
          recibidos.push(evento.eventId);
          await cliente.query(
            'INSERT INTO filtros VALUES ($1, 1) ON CONFLICT (usuario_id) DO UPDATE SET veces = filtros.veces + 1',
            [evento.datos.usuarioId],
          );
        },
      });
      const evento = filtros();
      await broker.publicar(evento);
      await broker.publicar(evento);
      await esperarQue(() =>
        lineas.some(
          (l) => l.mensaje === 'Evento repetido: se ignora' && l.eventId === evento.eventId,
        ),
      );
      expect(recibidos).toEqual([evento.eventId]);
      expect(
        (await pool.query('SELECT veces FROM filtros WHERE usuario_id = $1', [USUARIO])).rows[0],
      ).toEqual({ veces: 1 });
    });

    it('no publica un evento que no cumple su esquema', async () => {
      const broker = await nuevoBroker();
      await expect(
        broker.publicarEvento('FiltrosActualizados', { usuarioId: 'x' }),
      ).rejects.toThrow(/Evento inválido/);
    });

    it('un evento inválido va directo a la DLQ, sin reintentos', async () => {
      const broker = await nuevoBroker('usuarios');
      let llamadas = 0;
      await broker.consumir({
        tipo: 'ViajeActualizado',
        pool,
        manejar: async () => {
          llamadas++;
        },
      });
      await publicarCrudo(
        'ViajeActualizado',
        JSON.stringify({ ...crearEvento('ViajeActualizado', { estado: 'archivado' }, 'region-1') }),
      );
      await publicarCrudo('ViajeActualizado', 'no es json');
      let dlq: string[] = [];
      await esperarQue(async () => {
        dlq = [...dlq, ...(await leerCola('usuarios.ViajeActualizado.dlq'))];
        return dlq.length === 2;
      });
      expect(dlq).toContain('no es json');
      expect(llamadas).toBe(0);
    });

    it('si el manejo falla reintenta 3 veces con espera y después lo manda a la DLQ', async () => {
      const broker = await nuevoBroker('correo');
      const intentos: number[] = [];
      await broker.consumir({
        tipo: 'FiltrosActualizados',
        pool,
        esperasReintentoMs: [50, 100, 150],
        manejar: async () => {
          intentos.push(Date.now());
          throw new Error('base caída');
        },
      });
      const evento = filtros();
      await broker.publicar(evento);
      let dlq: Sobre<unknown>[] = [];
      await esperarQue(async () => {
        const nuevos = await leerCola('correo.FiltrosActualizados.dlq');
        dlq = [...dlq, ...nuevos.map((m) => JSON.parse(m) as Sobre<unknown>)];
        return dlq.length === 1;
      });
      expect(dlq[0]?.eventId).toBe(evento.eventId);
      expect(intentos).toHaveLength(4);
      expect((intentos[3] ?? 0) - (intentos[0] ?? 0)).toBeGreaterThanOrEqual(300);
      // Ningún intento quedó marcado como procesado: el cambio y la marca se deshicieron juntos.
      const marca = await pool.query(
        'SELECT 1 FROM eventos_procesados WHERE event_id = $1 AND cola = $2',
        [evento.eventId, 'correo.FiltrosActualizados'],
      );
      expect(marca.rowCount).toBe(0);
    });

    it('se reconecta solo si se cae la conexión con el broker y sigue consumiendo', async () => {
      const broker = await nuevoBroker('analitica');
      const recibidos: string[] = [];
      await broker.consumir({
        tipo: 'FiltrosActualizados',
        pool,
        manejar: async (evento) => {
          recibidos.push(evento.eventId);
        },
      });
      await rabbit.cortarConexiones();
      await esperarQue(() => !broker.conectado());
      await esperarQue(() => broker.conectado());
      const evento = filtros();
      await esperarQue(async () => {
        try {
          await broker.publicar(evento);
          return true;
        } catch {
          return false;
        }
      });
      await esperarQue(() => recibidos.includes(evento.eventId));
    });
  });

  describe('outbox', () => {
    it('un evento guardado en el outbox se publica aunque el servicio se reinicie antes de enviarlo', async () => {
      const consumidor = await nuevoBroker('asistente');
      const recibidos: string[] = [];
      await consumidor.consumir({
        tipo: 'FiltrosActualizados',
        pool,
        manejar: async (evento) => {
          recibidos.push(evento.eventId);
        },
      });
      // El servicio guarda el cambio y su evento en la misma transacción y "se cae" antes de publicar.
      const evento = filtros();
      await enTransaccion(pool, (cliente) => guardarEnOutbox(cliente, evento));
      // Al volver a arrancar, el publicador encuentra el pendiente y lo envía.
      const publicador = iniciarPublicadorOutbox({
        pool,
        broker: await nuevoBroker(),
        logger,
        intervaloMs: 50,
      });
      await esperarQue(() => recibidos.includes(evento.eventId));
      await publicador.detener();
      const fila = await pool.query(
        'SELECT enviado_en FROM eventos_salientes WHERE event_id = $1',
        [evento.eventId],
      );
      expect(fila.rows[0]?.enviado_en).toBeInstanceOf(Date);
    });

    it('si la transacción del servicio falla, el evento tampoco queda guardado', async () => {
      const evento = filtros();
      await expect(
        enTransaccion(pool, async (cliente) => {
          await guardarEnOutbox(cliente, evento);
          throw new Error('falla el cambio');
        }),
      ).rejects.toThrow();
      expect(
        (await pool.query('SELECT 1 FROM eventos_salientes WHERE event_id = $1', [evento.eventId]))
          .rowCount,
      ).toBe(0);
    });
  });
});
