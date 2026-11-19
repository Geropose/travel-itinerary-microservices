// Pruebas de integración de P2.D4 (Asistente Virtual contra PostgreSQL 17 real):
// - Cada intención en español e inglés (estado, reprogramar, problemaMenor, derivar).
// - Historial persistido en la base regional (GET /conversaciones/:id y GET /mensajes?desde=).
// - 2 intentos fallidos consecutivos derivan automáticamente a la agencia preferida.
// - Reprogramación en 2 pasos: sin confirmación no aplica nada; opción inventada -> 409;
//   confirmación válida aplica y limpia pendientes; opción rechazada -> resultado opcionRechazada.
// - QA-9: otro usuario recibe 404 + AccesoRechazado al tocar conversación ajena, y no puede ver
//   reservas de otro usuario a través del chat; rol analista recibe 403.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  crearPool,
  crearValidador,
  migrar,
  MIGRACIONES_EVENTOS,
  type AccesoRechazado,
  type Pool,
  type Servidor,
} from '@trotamundos/comun';
import {
  dockerDisponible,
  firmarJwt,
  generarClaves,
  levantarPostgres,
  loggerDePrueba,
  USUARIO_PRUEBA,
  type ContenedorPostgres,
} from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { crearApp, crearNegocioAsistente, SERVICIO } from '../src/app.ts';
import {
  ErrorOpcionRechazada,
  type ClientesAsistente,
  type OpcionDeIntegraciones,
  type ReservaDeViajes,
} from '../src/clientes.ts';

const hayDocker = await dockerDisponible();
const claves = await generarClaves();
const OTRO_USUARIO = '11111111-2222-4333-8444-555555555555';

const RESERVAS_POR_USUARIO: Record<string, ReservaDeViajes[]> = {
  [USUARIO_PRUEBA]: [
    {
      reservaId: 'res-ana-1',
      proveedor: 'aerolinea-andina',
      numeroReserva: 'XKQ7PL',
      tipoReserva: 'vuelo',
      estado: 'confirmada',
      inicio: '2026-12-10T08:30:00Z',
      fin: '2026-12-10T10:40:00Z',
      origen: 'EZE',
      destino: 'SCL',
    },
    {
      reservaId: 'res-ana-2',
      proveedor: 'hotel-cordillera',
      numeroReserva: 'HC-48213',
      tipoReserva: 'hotel',
      estado: 'confirmada',
      inicio: '2026-12-10T15:00:00Z',
      fin: '2026-12-14T11:00:00Z',
      destino: 'Santiago',
    },
  ],
  [OTRO_USUARIO]: [
    {
      reservaId: 'res-otro-1',
      proveedor: 'aerolinea-andina',
      numeroReserva: 'OTRO99',
      tipoReserva: 'vuelo',
      estado: 'confirmada',
      inicio: '2026-12-20T09:00:00Z',
      fin: '2026-12-20T11:00:00Z',
      origen: 'AEP',
      destino: 'MDZ',
    },
  ],
};

const OFERTAS_POR_DEFECTO: OpcionDeIntegraciones[] = [
  {
    opcionId: 'oco_0000AN0000000101',
    venceEn: '2026-12-01T10:00:00Z',
    costo: { monto: '0.00', moneda: 'USD' },
    inicio: '2026-12-10T14:00:00Z',
    fin: '2026-12-10T16:10:00Z',
    origen: 'EZE',
    destino: 'SCL',
    detalle: { numeroVuelo: 'AN 1240' },
  },
];

describe.skipIf(!hayDocker)(
  'Asistente Virtual: núcleo, reglas es/en, historial y plug-ins (PostgreSQL 17)',
  { timeout: 120_000 },
  () => {
    const { logger } = loggerDePrueba(SERVICIO);
    const rechazos: AccesoRechazado[] = [];

    let postgres: ContenedorPostgres;
    let pool: Pool;
    let servidor: Servidor;
    let url = '';

    const aplicarSpy = vi.fn<ClientesAsistente['integraciones']['aplicarReprogramacion']>();
    const crearCasoSpy = vi.fn<ClientesAsistente['integraciones']['crearCasoAgencia']>();
    let rechazarProximaOpcion = false;

    beforeAll(async () => {
      postgres = await levantarPostgres();
      pool = crearPool({ url: postgres.url });
      await migrar(
        pool,
        [MIGRACIONES_EVENTOS, fileURLToPath(new URL('../migrations/', import.meta.url))],
        logger,
      );

      const registrarRechazo = (r: AccesoRechazado) => {
        rechazos.push(r);
      };

      const validador = crearValidador({
        servicio: SERVICIO,
        region: 'region-1',
        logger,
        claves: { 'region-1': { claves: claves.jwks } },
        registrar: registrarRechazo,
        reglas: {},
      });

      const clientes: ClientesAsistente = {
        viajes: {
          async listarReservas(usuarioId, _token) {
            return RESERVAS_POR_USUARIO[usuarioId] ?? [];
          },
        },
        usuarios: {
          async obtenerPerfil(_token) {
            return {
              usuarioId: USUARIO_PRUEBA,
              email: 'ana@correo.example',
              nombre: 'Ana García',
              agenciaPreferida: 'viajes-del-plata',
            };
          },
        },
        integraciones: {
          async pedirOpcionesReprogramacion(_proveedor, numeroReserva, _token) {
            return numeroReserva === 'XKQ7PL' ? OFERTAS_POR_DEFECTO : [];
          },
          async aplicarReprogramacion(proveedor, numeroReserva, opcionId, token) {
            aplicarSpy(proveedor, numeroReserva, opcionId, token);
            if (rechazarProximaOpcion) {
              rechazarProximaOpcion = false;
              throw new ErrorOpcionRechazada('Oferta vencida');
            }
            return {
              proveedor,
              numeroReserva,
              opcionId,
              estado: 'aplicada',
              aplicadaEn: '2026-11-28T09:21:10Z',
            };
          },
          async crearCasoAgencia(datos, token) {
            crearCasoSpy(datos, token);
            return {
              agencia: datos.agencia,
              numeroCaso: '35436',
              creadoEn: '2026-11-28T09:31:12Z',
            };
          },
        },
      };

      const negocio = crearNegocioAsistente({
        pool,
        region: 'region-1',
        logger,
        clientes,
        registrarRechazo,
      });

      servidor = crearApp({
        region: 'region-1',
        puerto: 0,
        logger,
        validador,
        nucleo: negocio.nucleo,
        manejarSenales: false,
        chequeos: {
          base: () => pool.query('SELECT 1'),
          reglas: async () => {
            if (!negocio.reglas.estaCargado()) throw new Error('Sin reglas');
          },
        },
      });
      url = `http://127.0.0.1:${await servidor.iniciar()}`;
    }, 120_000);

    afterAll(async () => {
      await servidor?.detener();
      await pool?.end();
      await postgres?.detener();
    }, 60_000);

    beforeEach(async () => {
      rechazos.length = 0;
      aplicarSpy.mockClear();
      crearCasoSpy.mockClear();
      rechazarProximaOpcion = false;
      await pool.query('TRUNCATE opciones_pendientes, mensajes, conversaciones');
    });

    async function abrirConversacion(token: string, idioma?: 'es' | 'en') {
      const resp = await fetch(`${url}/conversaciones`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(idioma ? { idioma } : {}),
      });
      expect(resp.status).toBe(201);
      expect(resp.headers.get('location')).toMatch(/^\/api\/asistente\/conversaciones\//);
      return (await resp.json()) as {
        conversacionId: string;
        idioma: 'es' | 'en';
        mensajes: Array<{ secuencia: number; texto: string }>;
      };
    }

    it('atiende estado, problema menor, reprogramación con confirmación y derivación en español', async () => {
      const token = await firmarJwt(claves, { sub: USUARIO_PRUEBA, idioma: 'es' });
      const conv = await abrirConversacion(token);
      expect(conv.idioma).toBe('es');
      expect(conv.mensajes).toHaveLength(1);

      // 1) Consulta de estado.
      const rEstado = await fetch(`${url}/conversaciones/${conv.conversacionId}/mensajes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: '¿Cuál es el estado de mi vuelo XKQ7PL?' }),
      });
      expect(rEstado.status).toBe(200);
      const bEstado = (await rEstado.json()) as {
        estado: string;
        respuesta: { intencion: string; resultado: string; reservas?: unknown[] };
      };
      expect(bEstado.estado).toBe('respondido');
      expect(bEstado.respuesta.intencion).toBe('estado');
      expect(bEstado.respuesta.resultado).toBe('respondido');
      expect(bEstado.respuesta.reservas).toHaveLength(1);

      // 2) Problema menor (equipaje).
      const rMenor = await fetch(`${url}/conversaciones/${conv.conversacionId}/mensajes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: '¿Cuánto equipaje puedo llevar?' }),
      });
      expect(rMenor.status).toBe(200);
      const bMenor = (await rMenor.json()) as {
        respuesta: { intencion: string; resultado: string; texto: string };
      };
      expect(bMenor.respuesta.intencion).toBe('problemaMenor');
      expect(bMenor.respuesta.texto).toContain('8 kg');

      // 3) Reprogramación: primero muestra opciones y NO aplica nada todavía.
      const rOpciones = await fetch(`${url}/conversaciones/${conv.conversacionId}/mensajes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: 'Quiero cambiar mi vuelo XKQ7PL para más tarde' }),
      });
      expect(rOpciones.status).toBe(200);
      const bOpciones = (await rOpciones.json()) as {
        respuesta: {
          secuencia: number;
          intencion: string;
          resultado: string;
          opciones?: Array<{ opcionId: string }>;
        };
      };
      expect(bOpciones.respuesta.intencion).toBe('reprogramar');
      expect(bOpciones.respuesta.resultado).toBe('opciones');
      expect(bOpciones.respuesta.opciones?.[0]?.opcionId).toBe('oco_0000AN0000000101');
      expect(aplicarSpy).not.toHaveBeenCalled();

      // Confirmar opción inventada -> 409 opcion-no-pendiente.
      const rInventada = await fetch(
        `${url}/conversaciones/${conv.conversacionId}/confirmaciones`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ opcionId: 'oco_inventada' }),
        },
      );
      expect(rInventada.status).toBe(409);
      expect(aplicarSpy).not.toHaveBeenCalled();

      // Confirmar opción válida -> aplica y limpia opciones pendientes.
      const rConfirm = await fetch(`${url}/conversaciones/${conv.conversacionId}/confirmaciones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ opcionId: 'oco_0000AN0000000101' }),
      });
      expect(rConfirm.status).toBe(200);
      const bConfirm = (await rConfirm.json()) as {
        mensajeUsuario: { confirmacion?: { opcionId: string } };
        respuesta: { resultado: string; intencion: string };
      };
      expect(bConfirm.mensajeUsuario.confirmacion).toEqual({ opcionId: 'oco_0000AN0000000101' });
      expect(bConfirm.respuesta.resultado).toBe('reprogramado');
      expect(aplicarSpy).toHaveBeenCalledTimes(1);

      // Re-confirmar ya aplicada -> 409 (ya no está pendiente).
      const rRepetida = await fetch(`${url}/conversaciones/${conv.conversacionId}/confirmaciones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ opcionId: 'oco_0000AN0000000101' }),
      });
      expect(rRepetida.status).toBe(409);

      // 4) GET /mensajes?desde= devuelve solo mensajes posteriores en orden.
      const rNuevos = await fetch(
        `${url}/conversaciones/${conv.conversacionId}/mensajes?desde=${bOpciones.respuesta.secuencia}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(rNuevos.status).toBe(200);
      const lista = (await rNuevos.json()) as {
        consultando: boolean;
        ultimaSecuencia: number;
        mensajes: Array<{ secuencia: number }>;
      };
      expect(lista.consultando).toBe(false);
      expect(lista.mensajes).toHaveLength(2);
      expect(lista.ultimaSecuencia).toBe(bOpciones.respuesta.secuencia + 2);
    });

    it('atiende conversaciones en inglés y maneja 2 intentos fallidos derivando automáticamente', async () => {
      const token = await firmarJwt(claves, { sub: USUARIO_PRUEBA, idioma: 'en' });
      const conv = await abrirConversacion(token, 'en');
      expect(conv.idioma).toBe('en');
      expect(conv.mensajes[0]?.texto).toContain('Trotamundos assistant');

      // Problema menor en inglés.
      const rEn = await fetch(`${url}/conversaciones/${conv.conversacionId}/mensajes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: 'How do I share my itinerary?' }),
      });
      expect(rEn.status).toBe(200);
      expect(
        ((await rEn.json()) as { respuesta: { intencion: string; texto: string } }).respuesta,
      ).toMatchObject({
        intencion: 'problemaMenor',
      });

      // Primer intento fallido -> repregunta.
      const rFallo1 = await fetch(`${url}/conversaciones/${conv.conversacionId}/mensajes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: 'blah blah something unclear' }),
      });
      expect(rFallo1.status).toBe(200);
      const bFallo1 = (await rFallo1.json()) as {
        respuesta: { intencion: string; resultado: string };
      };
      expect(bFallo1.respuesta).toMatchObject({
        intencion: 'desconocida',
        resultado: 'repregunta',
      });
      expect(crearCasoSpy).not.toHaveBeenCalled();

      // Segundo intento fallido consecutivo -> deriva automáticamente a la agencia preferida.
      const rFallo2 = await fetch(`${url}/conversaciones/${conv.conversacionId}/mensajes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: 'still unclear gibberish' }),
      });
      expect(rFallo2.status).toBe(200);
      const bFallo2 = (await rFallo2.json()) as {
        respuesta: {
          intencion: string;
          resultado: string;
          caso?: { agencia: string; numeroCaso: string };
        };
      };
      expect(bFallo2.respuesta.intencion).toBe('derivar');
      expect(bFallo2.respuesta.resultado).toBe('derivado');
      expect(bFallo2.respuesta.caso).toEqual({ agencia: 'viajes-del-plata', numeroCaso: '35436' });
      expect(crearCasoSpy).toHaveBeenCalledTimes(1);
    });

    it('QA-9: aísla conversaciones (404 + AccesoRechazado) e impide consultar reservas de otro usuario', async () => {
      const tokenAna = await firmarJwt(claves, { sub: USUARIO_PRUEBA, idioma: 'es' });
      const tokenOtro = await firmarJwt(claves, { sub: OTRO_USUARIO, idioma: 'es' });
      const tokenAnalista = await firmarJwt(claves, { roles: ['analista'] });

      const convAna = await abrirConversacion(tokenAna);

      // Otro usuario intenta leer la conversación de Ana -> 404 y registrado como rechazo.
      const rAjena = await fetch(`${url}/conversaciones/${convAna.conversacionId}`, {
        headers: { Authorization: `Bearer ${tokenOtro}` },
      });
      expect(rAjena.status).toBe(404);
      expect(rechazos.some((r) => r.usuarioId === OTRO_USUARIO && r.motivo === 'sin-permiso')).toBe(
        true,
      );

      // Otro usuario abre su propia conversación y pregunta por la reserva XKQ7PL de Ana.
      const convOtro = await abrirConversacion(tokenOtro);
      const rEspia = await fetch(`${url}/conversaciones/${convOtro.conversacionId}/mensajes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOtro}` },
        body: JSON.stringify({ texto: '¿Cuál es el estado de mi vuelo XKQ7PL?' }),
      });
      expect(rEspia.status).toBe(200);
      const bEspia = (await rEspia.json()) as {
        respuesta: { reservas?: unknown[]; texto: string };
      };
      expect(bEspia.respuesta.reservas).toEqual([]);
      expect(bEspia.respuesta.texto).toContain('No encontré');

      // Analista no tiene rol usuario -> 403.
      const rAnalista = await fetch(`${url}/conversaciones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenAnalista}` },
        body: JSON.stringify({}),
      });
      expect(rAnalista.status).toBe(403);

      // Conversación inexistente -> 404 sin registrar rechazo de acceso indebido.
      const antes = rechazos.length;
      const rInexistente = await fetch(`${url}/conversaciones/${randomUUID()}`, {
        headers: { Authorization: `Bearer ${tokenAna}` },
      });
      expect(rInexistente.status).toBe(404);
      expect(rechazos).toHaveLength(antes);
    });

    it('si el proveedor rechaza una opción confirmada devuelve opcionRechazada y ofrece derivar', async () => {
      const token = await firmarJwt(claves, { sub: USUARIO_PRUEBA, idioma: 'es' });
      const conv = await abrirConversacion(token);

      await fetch(`${url}/conversaciones/${conv.conversacionId}/mensajes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: 'Reprogramar mi vuelo XKQ7PL' }),
      });

      rechazarProximaOpcion = true;
      const rConfirm = await fetch(`${url}/conversaciones/${conv.conversacionId}/confirmaciones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ opcionId: 'oco_0000AN0000000101' }),
      });
      expect(rConfirm.status).toBe(200);
      const body = (await rConfirm.json()) as {
        respuesta: { resultado: string; ofreceDerivar?: boolean };
      };
      expect(body.respuesta.resultado).toBe('opcionRechazada');
      expect(body.respuesta.ofreceDerivar).toBe(true);

      // Responder "sí" cuando ofreceDerivar está activo -> deriva automáticamente.
      const rSi = await fetch(`${url}/conversaciones/${conv.conversacionId}/mensajes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ texto: 'Sí, por favor' }),
      });
      expect(rSi.status).toBe(200);
      const bSi = (await rSi.json()) as { respuesta: { intencion: string; resultado: string } };
      expect(bSi.respuesta).toMatchObject({ intencion: 'derivar', resultado: 'derivado' });
    });
  },
);
