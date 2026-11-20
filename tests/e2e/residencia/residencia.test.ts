// Pruebas E2E de residencia de datos (P3.4, CONST-6, Iteración 6, ADR-012, ADR-016, ADR-017):
// 1. Aislamiento estricto por región: datos personales de usuario de region-1 solo en bases y
//    cache de region-1, y los de region-2 solo en region-2 (cuentas, credenciales, correos
//    procesados, viajes/reservas y conversaciones del asistente).
// 2. Base global de analítica sin datos personales: escaneo con expresiones regulares en todas las
//    columnas de texto de toda la base (emails, nombres, usuarioId, códigos reales de reserva).
// 3. Login desde un dispositivo nuevo en la otra región: autentica en su región de origen vía 307
//    del enrutador sin dejar ningún dato en la región equivocada.
// 4. Read replicas de Viajes aisladas en su propia región (redes, etiquetas, streaming y datos).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, beforeAll, afterAll, it } from 'vitest';
import {
  CONFIG_E2E,
  conectarOAuthMock,
  desconectarCuentasCorreo,
  eliminarReservasUsuario,
  esperarCondicion,
  idAleatorio,
  inyectarCorreo,
  pedirJson,
  registrarYLogin,
  sistemaDisponible,
  subDeJwt,
  type Region,
  type SesionE2E,
} from '../comun.ts';

type Proyecto = 'r1' | 'r2';

const BASES_POR_SERVIDOR_REGION = [
  'autenticacion',
  'usuarios',
  'correo',
  'integraciones',
  'analitica',
  'asistente',
  'registro_accesos',
] as const;

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function contenedorArriba(nombre: string): boolean {
  try {
    return docker('ps', '-q', '--filter', `name=^${nombre}$`) !== '';
  } catch {
    return false;
  }
}

const haySistema =
  (await sistemaDisponible()) &&
  contenedorArriba('r1-postgres-1') &&
  contenedorArriba('r2-postgres-1') &&
  contenedorArriba('global-postgres-analitica-1');

function psql(contenedor: string, base: string, sql: string): string {
  return docker('exec', contenedor, 'psql', '-U', 'admin', '-d', base, '-tAc', sql);
}

function escaparRegexSql(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "''");
}

/**
 * Busca en todas las columnas de todas las tablas del esquema `public` usando `~*` (regex
 * case-insensitive de PostgreSQL). Lanza un error indicando tabla y columna ante el primer hallazgo.
 */
function verificarCeroCoincidenciasRegexEnBase(
  contenedor: string,
  base: string,
  patrones: { etiqueta: string; regexSql: string }[],
  excluirTablas: string[] = [],
): void {
  const listaExcluidas =
    excluirTablas.length > 0
      ? `AND c.table_name NOT IN (${excluirTablas.map((t) => `'${t}'`).join(', ')})`
      : '';

  for (const { etiqueta, regexSql } of patrones) {
    const filtroColumna =
      etiqueta === 'uuid'
        ? "AND c.data_type IN ('text', 'character varying', 'json', 'jsonb', 'character')"
        : '';

    const sql = `
      DO $$
      DECLARE
        r record;
        c_hallazgos integer;
      BEGIN
        FOR r IN
          SELECT c.table_schema, c.table_name, c.column_name
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public'
            AND t.table_type = 'BASE TABLE'
            AND NOT EXISTS (
              SELECT 1 FROM pg_inherits i
              WHERE i.inhrelid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass
            )
            ${listaExcluidas}
            ${filtroColumna}
        LOOP
          EXECUTE format(
            'SELECT count(*) FROM %I.%I WHERE coalesce(%I::text, '''') ~* $1',
            r.table_schema, r.table_name, r.column_name
          ) INTO c_hallazgos USING '${regexSql.replace(/'/g, "''")}';
          IF c_hallazgos > 0 THEN
            RAISE EXCEPTION 'Patrón % encontrado (% filas) en %.%.%',
              '${etiqueta.replace(/'/g, "''")}', c_hallazgos, r.table_schema, r.table_name, r.column_name;
          END IF;
        END LOOP;
      END $$;
    `;
    psql(contenedor, base, sql);
  }
}

function esperarVueloEnPanel(sesion: SesionE2E, codigoReserva: string): Promise<string> {
  interface Panel {
    viajes: { viajeId: string; reservas: { numeroReserva: string }[] }[];
  }
  return esperarCondicion<string>(
    async () => {
      const resp = await pedirJson<Panel>(`${CONFIG_E2E.urlEnrutador}/api/viajes/panel`, {
        headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
      });
      if (resp.status !== 200 || !resp.datos) return undefined;
      const viaje = resp.datos.viajes.find((v) =>
        v.reservas.some((r) => r.numeroReserva === codigoReserva),
      );
      return viaje?.viajeId;
    },
    25_000,
    1_000,
  );
}

async function sembrarDatosUsuario(opciones: {
  region: Region;
  prefijo: string;
  codigoReserva: string;
  buzon: string;
}): Promise<{ sesion: SesionE2E; viajeId: string }> {
  const sesion = await registrarYLogin({
    nombre: `Viajero Residencia ${opciones.prefijo} ${idAleatorio()}`,
    email: `res-${opciones.prefijo}-${idAleatorio()}@correo.example`,
    region: opciones.region,
  });

  await conectarOAuthMock({
    proveedor: 'gmail',
    emailBuzon: opciones.buzon,
    jwt: sesion.jwt,
    region: sesion.region,
  });

  const esR1 = opciones.region === 'region-1';
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FlightReservation',
    reservationNumber: opciones.codigoReserva,
    reservationStatus: 'https://schema.org/ReservationConfirmed',
    underName: { '@type': 'Person', name: sesion.nombre },
    reservationFor: {
      '@type': 'Flight',
      flightNumber: esR1 ? 'AN 6101' : 'AN 6202',
      airline: { '@type': 'Airline', name: 'Aerolínea Andina', iataCode: 'AN' },
      departureAirport: {
        '@type': 'Airport',
        name: esR1 ? 'Buenos Aires' : 'Madrid',
        iataCode: esR1 ? 'EZE' : 'MAD',
      },
      arrivalAirport: {
        '@type': 'Airport',
        name: esR1 ? 'Santiago' : 'París',
        iataCode: esR1 ? 'SCL' : 'CDG',
      },
      departureTime: '2026-12-26T10:00:00Z',
      arrivalTime: '2026-12-26T12:15:00Z',
    },
    airplaneSeat: '7A',
  };

  await inyectarCorreo(CONFIG_E2E.urlMockGmail, opciones.buzon, {
    de: 'Aerolínea Andina <reservas@aerolinea-andina.example>',
    asunto: `Confirmación vuelo — ${opciones.codigoReserva}`,
    texto: `Reserva ${opciones.codigoReserva} confirmada.`,
    html:
      '<!doctype html><html><head><script type="application/ld+json">' +
      JSON.stringify(jsonLd) +
      '</script></head><body>Confirmado</body></html>',
  });

  const viajeId = await esperarVueloEnPanel(sesion, opciones.codigoReserva);

  // Crear conversación y mensaje en Asistente para validar también residencia de conversaciones.
  const conv = await pedirJson<{ conversacionId: string }>(
    `${CONFIG_E2E.urlEnrutador}/api/asistente/conversaciones`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sesion.jwt}`,
        'X-Region': sesion.region,
      },
      body: JSON.stringify({ idioma: 'es' }),
    },
  );
  expect(conv.status).toBe(201);
  const convId = conv.datos?.conversacionId ?? '';
  expect(convId).toBeTruthy();

  const msg = await pedirJson(
    `${CONFIG_E2E.urlEnrutador}/api/asistente/conversaciones/${convId}/mensajes`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sesion.jwt}`,
        'X-Region': sesion.region,
      },
      body: JSON.stringify({ texto: `¿Cuál es mi reserva ${opciones.codigoReserva}?` }),
    },
  );
  expect([200, 202]).toContain(msg.status);

  return { sesion, viajeId };
}

function resumenPresenciaUsuario(
  proyecto: Proyecto,
  sesion: SesionE2E,
  codigoReserva: string,
): Record<string, number> {
  const pgPrincipal = `${proyecto}-postgres-1`;
  const pgViajes = `${proyecto}-postgres-viajes-1`;
  const emailMin = sesion.email.toLowerCase();
  const uid = sesion.usuarioId;
  const cod = codigoReserva.replace(/'/g, "''");

  return {
    credenciales: Number(
      psql(
        pgPrincipal,
        'autenticacion',
        `SELECT count(*) FROM credenciales WHERE usuario_id = '${uid}' OR email = '${emailMin}'`,
      ),
    ),
    cuentasUsuario: Number(
      psql(
        pgPrincipal,
        'usuarios',
        `SELECT count(*) FROM cuentas WHERE usuario_id = '${uid}' OR email = '${emailMin}'`,
      ),
    ),
    cuentasCorreo: Number(
      psql(
        pgPrincipal,
        'correo',
        `SELECT count(*) FROM cuentas_correo WHERE usuario_id = '${uid}'`,
      ),
    ),
    correosProcesados: Number(
      psql(
        pgPrincipal,
        'correo',
        `SELECT count(*) FROM correos_procesados cp
         JOIN cuentas_correo cc ON cc.id = cp.cuenta_id
         WHERE cc.usuario_id = '${uid}'`,
      ),
    ),
    viajes: Number(
      psql(pgViajes, 'viajes', `SELECT count(*) FROM viajes WHERE usuario_id = '${uid}'`),
    ),
    reservas: Number(
      psql(
        pgViajes,
        'viajes',
        `SELECT count(*) FROM reservas WHERE usuario_id = '${uid}' OR numero_reserva = '${cod}'`,
      ),
    ),
    conversaciones: Number(
      psql(
        pgPrincipal,
        'asistente',
        `SELECT count(*) FROM conversaciones WHERE usuario_id = '${uid}'`,
      ),
    ),
    mensajes: Number(
      psql(
        pgPrincipal,
        'asistente',
        `SELECT count(*) FROM mensajes m
         JOIN conversaciones c ON c.conversacion_id = m.conversacion_id
         WHERE c.usuario_id = '${uid}'`,
      ),
    ),
  };
}

function verificarCeroRastrosEnRegion(
  proyectoAjeno: Proyecto,
  sesion: SesionE2E,
  buzon: string,
  codigoReserva: string,
): void {
  const patrones = [
    { etiqueta: 'usuarioId', regexSql: escaparRegexSql(sesion.usuarioId) },
    { etiqueta: 'email', regexSql: escaparRegexSql(sesion.email) },
    { etiqueta: 'nombre', regexSql: escaparRegexSql(sesion.nombre) },
    { etiqueta: 'buzon', regexSql: escaparRegexSql(buzon) },
    { etiqueta: 'numeroReserva', regexSql: escaparRegexSql(codigoReserva) },
  ];

  for (const base of BASES_POR_SERVIDOR_REGION) {
    verificarCeroCoincidenciasRegexEnBase(`${proyectoAjeno}-postgres-1`, base, patrones);
  }
  verificarCeroCoincidenciasRegexEnBase(`${proyectoAjeno}-postgres-viajes-1`, 'viajes', patrones);

  const clavesRedis = docker(
    'exec',
    `${proyectoAjeno}-redis-1`,
    'redis-cli',
    'KEYS',
    `*${sesion.usuarioId}*`,
  );
  expect(clavesRedis).toBe('');
}

describe.skipIf(!haySistema)('Pruebas E2E de residencia de datos (CONST-6)', () => {
  const buzonR1 = `res-r1-${idAleatorio()}@gmail.example`;
  const buzonR2 = `res-r2-${idAleatorio()}@gmail.example`;
  const codigoR1 = `RES1-VUE-${idAleatorio()}`;
  const codigoR2 = `RES2-VUE-${idAleatorio()}`;

  let usuarioR1: SesionE2E;
  let usuarioR2: SesionE2E;

  beforeAll(async () => {
    const [r1, r2] = await Promise.all([
      sembrarDatosUsuario({
        region: 'region-1',
        prefijo: 'r1',
        codigoReserva: codigoR1,
        buzon: buzonR1,
      }),
      sembrarDatosUsuario({
        region: 'region-2',
        prefijo: 'r2',
        codigoReserva: codigoR2,
        buzon: buzonR2,
      }),
    ]);
    usuarioR1 = r1.sesion;
    usuarioR2 = r2.sesion;
  }, 60_000);

  afterAll(async () => {
    const sesiones = [usuarioR1, usuarioR2].filter((s): s is SesionE2E => s !== undefined);
    await Promise.all(
      sesiones.flatMap((s) => [eliminarReservasUsuario(s), desconectarCuentasCorreo(s)]),
    );
  });

  it('los datos personales de region-1 solo existen en r1 y los de region-2 solo en r2 (CONST-6)', () => {
    // 1. Usuario de region-1: presente en todas las tablas correspondientes de r1 y ausente en r2.
    const enR1Usuario1 = resumenPresenciaUsuario('r1', usuarioR1, codigoR1);
    expect(enR1Usuario1.credenciales).toBe(1);
    expect(enR1Usuario1.cuentasUsuario).toBe(1);
    expect(enR1Usuario1.cuentasCorreo).toBe(1);
    expect(enR1Usuario1.correosProcesados).toBeGreaterThanOrEqual(1);
    expect(enR1Usuario1.viajes).toBeGreaterThanOrEqual(1);
    expect(enR1Usuario1.reservas).toBeGreaterThanOrEqual(1);
    expect(enR1Usuario1.conversaciones).toBeGreaterThanOrEqual(1);
    expect(enR1Usuario1.mensajes).toBeGreaterThanOrEqual(1);

    const enR2Usuario1 = resumenPresenciaUsuario('r2', usuarioR1, codigoR1);
    expect(enR2Usuario1).toEqual({
      credenciales: 0,
      cuentasUsuario: 0,
      cuentasCorreo: 0,
      correosProcesados: 0,
      viajes: 0,
      reservas: 0,
      conversaciones: 0,
      mensajes: 0,
    });
    verificarCeroRastrosEnRegion('r2', usuarioR1, buzonR1, codigoR1);

    // 2. Usuario de region-2: presente en todas las tablas correspondientes de r2 y ausente en r1.
    const enR2Usuario2 = resumenPresenciaUsuario('r2', usuarioR2, codigoR2);
    expect(enR2Usuario2.credenciales).toBe(1);
    expect(enR2Usuario2.cuentasUsuario).toBe(1);
    expect(enR2Usuario2.cuentasCorreo).toBe(1);
    expect(enR2Usuario2.correosProcesados).toBeGreaterThanOrEqual(1);
    expect(enR2Usuario2.viajes).toBeGreaterThanOrEqual(1);
    expect(enR2Usuario2.reservas).toBeGreaterThanOrEqual(1);
    expect(enR2Usuario2.conversaciones).toBeGreaterThanOrEqual(1);
    expect(enR2Usuario2.mensajes).toBeGreaterThanOrEqual(1);

    const enR1Usuario2 = resumenPresenciaUsuario('r1', usuarioR2, codigoR2);
    expect(enR1Usuario2).toEqual({
      credenciales: 0,
      cuentasUsuario: 0,
      cuentasCorreo: 0,
      correosProcesados: 0,
      viajes: 0,
      reservas: 0,
      conversaciones: 0,
      mensajes: 0,
    });
    verificarCeroRastrosEnRegion('r1', usuarioR2, buzonR2, codigoR2);
  });

  it('la base global de analítica no contiene ningún dato personal (regex en todas las columnas de texto)', async () => {
    // Esperar a que los Anonimizadores de ambas regiones publiquen en global-postgres-analitica-1.
    const conteos = await esperarCondicion<{ r1: number; r2: number }>(
      async () => {
        const fila = psql(
          'global-postgres-analitica-1',
          'analitica',
          `SELECT count(*) FILTER (WHERE region = 'region-1') || ':' ||
                  count(*) FILTER (WHERE region = 'region-2')
           FROM reservas_anonimizadas`,
        );
        const [r1 = '0', r2 = '0'] = fila.split(':');
        const c1 = Number(r1);
        const c2 = Number(r2);
        return c1 >= 1 && c2 >= 1 ? { r1: c1, r2: c2 } : undefined;
      },
      25_000,
      1_000,
    );
    expect(conteos.r1).toBeGreaterThanOrEqual(1);
    expect(conteos.r2).toBeGreaterThanOrEqual(1);

    // Todas las filas anonimizadas tienen codigo_reserva HMAC-SHA256 de 64 hexadecimales.
    const codigosInvalidos = psql(
      'global-postgres-analitica-1',
      'analitica',
      `SELECT count(*) FROM reservas_anonimizadas WHERE codigo_reserva !~ '^[0-9a-f]{64}$'`,
    );
    expect(Number(codigosInvalidos)).toBe(0);

    // En reservas_anonimizadas no puede haber emails ni UUIDs (usuarioId, viajeId, reservaId).
    verificarCeroCoincidenciasRegexEnBase(
      'global-postgres-analitica-1',
      'analitica',
      [
        {
          etiqueta: 'email',
          regexSql: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
        },
        {
          etiqueta: 'uuid',
          regexSql: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
        },
      ],
      ['ejecuciones_consultas', 'eventos_procesados', 'migraciones'],
    );

    // En TODA la base de analítica no aparecen emails, nombres, usuarioId ni códigos reales.
    const patronesPersonales = [
      { etiqueta: 'email-patron', regexSql: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' },
      { etiqueta: 'usuarioId-r1', regexSql: escaparRegexSql(usuarioR1.usuarioId) },
      { etiqueta: 'usuarioId-r2', regexSql: escaparRegexSql(usuarioR2.usuarioId) },
      { etiqueta: 'email-r1', regexSql: escaparRegexSql(usuarioR1.email) },
      { etiqueta: 'email-r2', regexSql: escaparRegexSql(usuarioR2.email) },
      { etiqueta: 'nombre-r1', regexSql: escaparRegexSql(usuarioR1.nombre) },
      { etiqueta: 'nombre-r2', regexSql: escaparRegexSql(usuarioR2.nombre) },
      { etiqueta: 'buzon-r1', regexSql: escaparRegexSql(buzonR1) },
      { etiqueta: 'buzon-r2', regexSql: escaparRegexSql(buzonR2) },
      { etiqueta: 'reserva-r1', regexSql: escaparRegexSql(codigoR1) },
      { etiqueta: 'reserva-r2', regexSql: escaparRegexSql(codigoR2) },
      { etiqueta: 'semilla-xkq7pl', regexSql: 'XKQ7PL' },
      { etiqueta: 'semilla-hc48291', regexSql: 'HC-48291' },
    ];
    verificarCeroCoincidenciasRegexEnBase(
      'global-postgres-analitica-1',
      'analitica',
      patronesPersonales,
    );
  });

  it('un usuario de region-1 que inicia sesión desde un dispositivo nuevo en region-2 entra igual sin dejar datos en r2 (ADR-017)', async () => {
    const reqHeader = `res-dev-hdr-${randomUUID()}`;
    const loginHeader = await pedirJson<{ jwt: string; region: string }>(
      `${CONFIG_E2E.urlEnrutador}/api/autenticacion/login`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Region': 'region-2',
          'X-Request-Id': reqHeader,
        },
        body: JSON.stringify({
          email: usuarioR1.email,
          contrasena: usuarioR1.contrasena,
        }),
      },
    );
    expect(loginHeader.status).toBe(200);
    expect(loginHeader.datos?.region).toBe('region-1');
    expect(subDeJwt(loginHeader.datos?.jwt ?? '')).toBe(usuarioR1.usuarioId);

    // También probando el prefijo regional explícito /region-2 en el enrutador global.
    const loginPrefijo = await pedirJson<{ jwt: string; region: string }>(
      `${CONFIG_E2E.urlEnrutador}/region-2/api/autenticacion/login`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: usuarioR1.email,
          contrasena: usuarioR1.contrasena,
        }),
      },
    );
    expect(loginPrefijo.status).toBe(200);
    expect(loginPrefijo.datos?.region).toBe('region-1');
    expect(subDeJwt(loginPrefijo.datos?.jwt ?? '')).toBe(usuarioR1.usuarioId);

    // Luego de ambos inicios de sesión, en region-2 sigue habiendo 0 datos de usuarioR1.
    verificarCeroRastrosEnRegion('r2', usuarioR1, buzonR1, codigoR1);
  });

  it('las read replicas de cada región están en su propia región y solo replican datos de su región (ADR-012, ADR-017)', () => {
    const casos: {
      proyecto: Proyecto;
      sesionPropia: SesionE2E;
      sesionAjena: SesionE2E;
    }[] = [
      { proyecto: 'r1', sesionPropia: usuarioR1, sesionAjena: usuarioR2 },
      { proyecto: 'r2', sesionPropia: usuarioR2, sesionAjena: usuarioR1 },
    ];

    for (const { proyecto, sesionPropia, sesionAjena } of casos) {
      const principal = `${proyecto}-postgres-viajes-1`;
      const replica = `${proyecto}-postgres-viajes-replica-1`;
      const otraRed = proyecto === 'r1' ? 'r2_region' : 'r1_region';

      const etiquetaPrincipal = docker(
        'inspect',
        '-f',
        '{{index .Config.Labels "com.docker.compose.project"}}:{{index .Config.Labels "trotamundos.centro-datos"}}',
        principal,
      );
      const etiquetaReplica = docker(
        'inspect',
        '-f',
        '{{index .Config.Labels "com.docker.compose.project"}}:{{index .Config.Labels "trotamundos.centro-datos"}}',
        replica,
      );
      expect(etiquetaPrincipal).toBe(`${proyecto}:a`);
      expect(etiquetaReplica).toBe(`${proyecto}:b`);

      const redesReplica = docker(
        'inspect',
        '-f',
        '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}',
        replica,
      )
        .split(' ')
        .filter(Boolean);
      expect(redesReplica).toEqual([`${proyecto}_region`]);
      expect(redesReplica).not.toContain(otraRed);
      expect(redesReplica).not.toContain('trotamundos-global');

      // Estado de streaming replication dentro de la misma región.
      expect(psql(replica, 'postgres', 'SELECT pg_is_in_recovery()')).toBe('t');
      expect(psql(principal, 'postgres', 'SELECT state FROM pg_stat_replication')).toBe(
        'streaming',
      );

      const ipReplica = docker(
        'inspect',
        '-f',
        `{{(index .NetworkSettings.Networks "${proyecto}_region").IPAddress}}`,
        replica,
      );
      const ipClienteReplicacion = psql(
        principal,
        'postgres',
        'SELECT host(client_addr) FROM pg_stat_replication LIMIT 1',
      );
      expect(ipClienteReplicacion).toBe(ipReplica);

      // La réplica contiene únicamente las reservas de su región y cero de la otra región.
      const propiasEnReplica = Number(
        psql(
          replica,
          'viajes',
          `SELECT count(*) FROM reservas WHERE usuario_id = '${sesionPropia.usuarioId}'`,
        ),
      );
      const ajenasEnReplica = Number(
        psql(
          replica,
          'viajes',
          `SELECT count(*) FROM reservas WHERE usuario_id = '${sesionAjena.usuarioId}'`,
        ),
      );
      expect(propiasEnReplica).toBeGreaterThanOrEqual(1);
      expect(ajenasEnReplica).toBe(0);
    }
  });
});
