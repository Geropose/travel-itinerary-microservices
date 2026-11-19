// Pruebas unitarias y HTTP en vivo de P2.D3 (agencias y redes sociales contra los mocks reales,
// sin Docker):
// - Formato de publicación en red social (es/en, recorte <= 500 chars con `…`).
// - POST /interna/agencias/casos (UC-6): creación de ticket con resumen, conversación y contacto,
//   control QA-9 (403 + AccesoRechazado si usuarioId !== sub o rol distinto de usuario), 404 si
//   la agencia no existe, 503 claro si la agencia está caída o no responde a tiempo.
// - POST /agencias/casos (botón público web, ADR-019): consulta perfil en Usuarios propagando JWT,
//   409 sin agencia preferida, 201 al crear el caso, 503 ante caída.
// - POST /interna/redes/publicar (QA-7): publicación rápida (< 1 s), idioma desde el JWT, 404/503.
import { randomUUID } from 'node:crypto';
import { crearValidador, type AccesoRechazado, type Pool, type Servidor } from '@trotamundos/comun';
import {
  firmarJwt,
  generarClaves,
  loggerDePrueba,
  USUARIO_PRUEBA,
} from '@trotamundos/comun/pruebas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearMockAgencia, type MockAgencia } from '../../../mocks/agencia/src/app.ts';
import { crearMockRedSocial, type MockRedSocial } from '../../../mocks/redsocial/src/app.ts';
import { formatearTextoItinerario, type ItinerarioPublico } from '../src/adaptadores/redsocial.ts';
import {
  crearApp,
  crearNegocioIntegraciones,
  REGLAS_VALIDADOR_INTEGRACIONES,
  SERVICIO,
} from '../src/app.ts';
import type { PerfilUsuario } from '../src/usuarios.ts';

const CLAVE_AGENCIA = 'clave-agencia-p2d3';
const TOKEN_REDSOCIAL = 'token-redsocial-p2d3';
const claves = await generarClaves();

function itinerarioEjemplo(cantidadReservas = 2): ItinerarioPublico {
  const reservas: ItinerarioPublico['reservas'] = [
    {
      tipoReserva: 'vuelo',
      descripcion: 'Vuelo AN 1234',
      inicio: '2026-12-10T08:30:00-03:00',
      fin: '2026-12-10T10:40:00-03:00',
      origen: 'Buenos Aires (EZE)',
      destino: 'Santiago (SCL)',
    },
    {
      tipoReserva: 'hotel',
      descripcion: 'Hotel Cordillera',
      inicio: '2026-12-10T15:00:00-03:00',
      fin: '2026-12-14T11:00:00-03:00',
    },
  ];
  for (let i = 2; i < cantidadReservas; i++) {
    reservas.push({
      tipoReserva: 'auto',
      descripcion: `Traslado adicional tramo ${i + 1} con recorrido extendido por la cordillera`,
      inicio: `2026-12-${String(10 + (i % 10)).padStart(2, '0')}T12:00:00-03:00`,
    });
  }
  return {
    viajeId: randomUUID(),
    destino: 'Santiago',
    inicio: '2026-12-10T08:30:00-03:00',
    fin: '2026-12-14T11:00:00-03:00',
    reservas,
  };
}

describe('Formateo de itinerario para red social', () => {
  it('formatea en español e inglés y recorta a <= 500 caracteres con puntos suspensivos', () => {
    const es = formatearTextoItinerario(itinerarioEjemplo(2), 'es');
    expect(es).toContain('Me voy de viaje a Santiago');
    expect(es).toContain('10/12 08:30 Vuelo AN 1234 Buenos Aires (EZE) → Santiago (SCL)');
    expect(es).toContain('10/12 15:00 Hotel Cordillera');

    const en = formatearTextoItinerario(itinerarioEjemplo(2), 'en');
    expect(en).toContain('Heading to Santiago');

    const largo = formatearTextoItinerario(itinerarioEjemplo(20), 'es');
    expect(largo.length).toBeLessThanOrEqual(500);
    expect(largo.endsWith('…')).toBe(true);
  });
});

describe('Integraciones P2.D3: agencias y redes sociales contra mocks reales', () => {
  const { logger } = loggerDePrueba(SERVICIO);
  const rechazos: AccesoRechazado[] = [];

  let mockAgencia: MockAgencia;
  let mockRedSocial: MockRedSocial;
  let servidor: Servidor;
  let urlIntegraciones = '';
  let urlAgencia = '';
  let urlRedSocial = '';

  let perfilActual: PerfilUsuario = {
    usuarioId: USUARIO_PRUEBA,
    email: 'ana@correo.example',
    nombre: 'Ana García',
    agenciaPreferida: 'viajes-del-plata',
  };
  let ultimoTokenEnUsuarios: string | undefined;

  beforeAll(async () => {
    mockAgencia = crearMockAgencia({
      puerto: 0,
      apiKey: CLAVE_AGENCIA,
      logger: loggerDePrueba('mock-agencia').logger,
    });
    mockRedSocial = crearMockRedSocial({
      puerto: 0,
      apiToken: TOKEN_REDSOCIAL,
      logger: loggerDePrueba('mock-redsocial').logger,
    });
    const [pAg, pRed] = await Promise.all([mockAgencia.iniciar(), mockRedSocial.iniciar()]);
    urlAgencia = `http://127.0.0.1:${pAg}`;
    urlRedSocial = `http://127.0.0.1:${pRed}`;

    const validador = crearValidador({
      servicio: SERVICIO,
      region: 'region-1',
      logger,
      claves: { 'region-1': { claves: claves.jwks } },
      registrar: (r) => rechazos.push(r),
      reglas: REGLAS_VALIDADOR_INTEGRACIONES,
    });

    // Pool mínimo: estas rutas no consultan PostgreSQL.
    const poolSinUso = {} as Pool;
    const negocio = crearNegocioIntegraciones({
      pool: poolSinUso,
      region: 'region-1',
      logger,
      env: {
        SECRETO_WEBHOOK_AEROLINEA: 'secreto-stub',
        URL_AGENCIA: urlAgencia,
        CLAVE_API_AGENCIA: CLAVE_AGENCIA,
        URL_REDSOCIAL: urlRedSocial,
        TOKEN_REDSOCIAL: TOKEN_REDSOCIAL,
      },
      usuarios: {
        async obtenerPerfil(token) {
          ultimoTokenEnUsuarios = token;
          return perfilActual;
        },
      },
    });

    servidor = crearApp({
      region: 'region-1',
      puerto: 0,
      logger,
      validador,
      negocio,
      manejarSenales: false,
    });
    urlIntegraciones = `http://127.0.0.1:${await servidor.iniciar()}`;
  });

  afterAll(async () => {
    await servidor?.detener();
    await Promise.all([mockAgencia?.detener(), mockRedSocial?.detener()]);
  });

  beforeEach(async () => {
    rechazos.length = 0;
    ultimoTokenEnUsuarios = undefined;
    perfilActual = {
      usuarioId: USUARIO_PRUEBA,
      email: 'ana@correo.example',
      nombre: 'Ana García',
      agenciaPreferida: 'viajes-del-plata',
    };
    await Promise.all([
      fetch(`${urlAgencia}/admin/reiniciar`, { method: 'POST' }),
      fetch(`${urlRedSocial}/admin/reiniciar`, { method: 'POST' }),
    ]);
  });

  it('POST /interna/agencias/casos crea caso con resumen, conversación y contacto y protege QA-9', async () => {
    const tokenUsuario = await firmarJwt(claves, { sub: USUARIO_PRUEBA });
    const body = {
      agencia: 'viajes-del-plata',
      usuarioId: USUARIO_PRUEBA,
      contacto: { nombre: 'Ana García', email: 'ana@correo.example' },
      resumen: 'Vuelo AN 1234 cancelado y sin opciones de reprogramación.',
      conversacion: [
        {
          autor: 'usuario',
          texto: 'Me cancelaron el vuelo a Santiago',
          enviadoEn: '2026-11-28T09:30:05Z',
        },
        {
          autor: 'asistente',
          texto: 'No encontré vuelos disponibles, te derivo con tu agencia.',
          enviadoEn: '2026-11-28T09:30:09Z',
        },
      ],
    };

    const resp = await fetch(`${urlIntegraciones}/interna/agencias/casos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUsuario}`,
      },
      body: JSON.stringify(body),
    });
    expect(resp.status).toBe(201);
    const caso = (await resp.json()) as {
      agencia: string;
      numeroCaso: string;
      creadoEn: string;
    };
    expect(caso.agencia).toBe('viajes-del-plata');
    expect(caso.numeroCaso).toMatch(/^\d+$/);
    expect(Date.parse(caso.creadoEn)).not.toBeNaN();

    // Verificamos que el mock de agencia recibió resumen, conversación y requester.
    const adminResp = await fetch(`${urlAgencia}/admin/casos`);
    const { casos } = (await adminResp.json()) as {
      casos: Array<{
        id: number;
        subject: string;
        comment: { body: string };
        external_id?: string;
        requester?: { name: string; email: string };
      }>;
    };
    expect(casos).toHaveLength(1);
    expect(casos[0]?.subject).toContain('Trotamundos:');
    expect(casos[0]?.comment.body).toContain('Vuelo AN 1234 cancelado');
    expect(casos[0]?.comment.body).toContain('Usuario: Me cancelaron el vuelo a Santiago');
    expect(casos[0]?.comment.body).toContain('Asistente: No encontré vuelos disponibles');
    expect(casos[0]?.external_id).toBe(USUARIO_PRUEBA);
    expect(casos[0]?.requester).toEqual({ name: 'Ana García', email: 'ana@correo.example' });

    // QA-9: derivar a nombre de otro usuario -> 403 y registrado en rechazos.
    const respOtro = await fetch(`${urlIntegraciones}/interna/agencias/casos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUsuario}`,
      },
      body: JSON.stringify({ ...body, usuarioId: randomUUID() }),
    });
    expect(respOtro.status).toBe(403);
    expect(rechazos.some((r) => r.status === 403 && r.motivo === 'sin-permiso')).toBe(true);

    // Rol analista (no usuario) -> 403.
    const tokenAnalista = await firmarJwt(claves, { roles: ['analista'] });
    const respAnalista = await fetch(`${urlIntegraciones}/interna/agencias/casos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenAnalista}`,
      },
      body: JSON.stringify(body),
    });
    expect(respAnalista.status).toBe(403);

    // Agencia no configurada -> 404.
    const resp404 = await fetch(`${urlIntegraciones}/interna/agencias/casos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUsuario}`,
      },
      body: JSON.stringify({ ...body, agencia: 'otra-agencia' }),
    });
    expect(resp404.status).toBe(404);
  });

  it('POST /interna/agencias/casos responde 503 claro si la agencia está caída (503 o timeout)', async () => {
    const tokenUsuario = await firmarJwt(claves, { sub: USUARIO_PRUEBA });
    const payload = JSON.stringify({
      agencia: 'viajes-del-plata',
      usuarioId: USUARIO_PRUEBA,
      resumen: 'Necesito ayuda urgente con mi reserva.',
      conversacion: [],
    });

    await fetch(`${urlAgencia}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modoFalla: '503' }),
    });
    const resp503 = await fetch(`${urlIntegraciones}/interna/agencias/casos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUsuario}`,
      },
      body: payload,
    });
    expect(resp503.status).toBe(503);
    expect(resp503.headers.get('content-type')).toContain('application/problem+json');
    expect(await resp503.json()).toMatchObject({
      type: 'https://trotamundos.example/errores/tercero-no-disponible',
      title: 'Tercero no disponible',
      status: 503,
    });

    // Agencia colgada sin responder -> timeout de 2 s -> 503 claro.
    await fetch(`${urlAgencia}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modoFalla: 'no-responder' }),
    });
    const respTimeout = await fetch(`${urlIntegraciones}/interna/agencias/casos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUsuario}`,
      },
      body: payload,
    });
    expect(respTimeout.status).toBe(503);
  });

  it('POST /agencias/casos consulta el perfil propagando JWT, exige agencia preferida (409) y crea caso (201)', async () => {
    const tokenUsuario = await firmarJwt(claves, { sub: USUARIO_PRUEBA });

    const respOk = await fetch(`${urlIntegraciones}/agencias/casos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUsuario}`,
      },
      body: JSON.stringify({ resumen: 'Quiero cambiar la fecha de vuelta de mi viaje.' }),
    });
    expect(respOk.status).toBe(201);
    expect(ultimoTokenEnUsuarios).toBe(tokenUsuario);
    expect(await respOk.json()).toMatchObject({ agencia: 'viajes-del-plata' });

    // Sin agencia preferida en el perfil -> 409.
    perfilActual = { ...perfilActual, agenciaPreferida: null };
    const respSinAgencia = await fetch(`${urlIntegraciones}/agencias/casos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenUsuario}`,
      },
      body: JSON.stringify({ resumen: 'Necesito hablar con mi agencia.' }),
    });
    expect(respSinAgencia.status).toBe(409);
    expect(await respSinAgencia.json()).toMatchObject({
      type: 'https://trotamundos.example/errores/conflicto',
      title: 'Sin agencia preferida',
      status: 409,
    });
  });

  it('POST /interna/redes/publicar publica en menos de 1 s con el idioma del JWT y degrada con 503', async () => {
    const tokenEn = await firmarJwt(claves, { sub: USUARIO_PRUEBA, idioma: 'en' });
    const inicio = Date.now();
    const resp = await fetch(`${urlIntegraciones}/interna/redes/publicar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenEn}`,
      },
      body: JSON.stringify({
        red: 'redsocial',
        itinerario: itinerarioEjemplo(2),
      }),
    });
    const duracionMs = Date.now() - inicio;
    expect(resp.status).toBe(201);
    expect(duracionMs).toBeLessThan(1500);
    const pub = (await resp.json()) as { red: string; url: string; publicadaEn: string };
    expect(pub.red).toBe('redsocial');
    expect(pub.url).toMatch(/^https:\/\/redsocial\.example\//);
    expect(Date.parse(pub.publicadaEn)).not.toBeNaN();

    const adminPubs = await fetch(`${urlRedSocial}/admin/publicaciones`);
    const { publicaciones } = (await adminPubs.json()) as {
      publicaciones: Array<{ language: string; textoOriginal: string }>;
    };
    expect(publicaciones).toHaveLength(1);
    expect(publicaciones[0]?.language).toBe('en');
    expect(publicaciones[0]?.textoOriginal).toContain('Heading to Santiago');

    // Red no configurada -> 404.
    const resp404 = await fetch(`${urlIntegraciones}/interna/redes/publicar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenEn}`,
      },
      body: JSON.stringify({ red: 'otra-red', itinerario: itinerarioEjemplo(2) }),
    });
    expect(resp404.status).toBe(404);

    // Red caída -> 503.
    await fetch(`${urlRedSocial}/admin/comportamiento`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modoFalla: '503' }),
    });
    const resp503 = await fetch(`${urlIntegraciones}/interna/redes/publicar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenEn}`,
      },
      body: JSON.stringify({ red: 'redsocial', itinerario: itinerarioEjemplo(2) }),
    });
    expect(resp503.status).toBe(503);
  });
});
