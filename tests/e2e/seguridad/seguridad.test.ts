// Pruebas E2E de seguridad (P3.3, QA-8, QA-9, ADR-005, ADR-014, ADR-015):
// 1. Recorrido automático de las rutas protegidas de los 7 contratos OpenAPI (401 sin token,
//    JWT expirado y firma inválida).
// 2. Aislamiento estricto entre usuarios (usuario A no lee ni modifica recursos de usuario B).
// 3. Itinerario compartido y auditoría en registro_accesos en menos de 1 s (QA-9).
// 4. Rol analista bloqueado en rutas de datos personales y habilitado en analítica (ADR-005).
// 5. Rutas /interna/* bloqueadas desde el exterior (404 + auditoría).
// 6. Cero contraseñas en texto plano ni tokens OAuth sin cifrar en las bases de datos (QA-8).
// 7. Cero contraseñas, tokens OAuth o JWT completos en los logs de los contenedores (QA-8).
import { execFileSync, spawnSync } from 'node:child_process';
import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargarSpec } from '@trotamundos/comun';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leerEnv } from '../../../infra/scripts/entorno.ts';
import {
  CONFIG_E2E,
  conectarOAuthMock,
  desconectarCuentasCorreo,
  eliminarReservasUsuario,
  idAleatorio,
  loginAnalista,
  pedirJson,
  registrarYLogin,
  sistemaDisponible,
  type SesionE2E,
} from '../comun.ts';

const RAIZ = fileURLToPath(new URL('../../../', import.meta.url));
const RUTA_ENV = resolve(RAIZ, '.env');
const ENV_ARCHIVO = existsSync(RUTA_ENV) ? leerEnv(readFileSync(RUTA_ENV, 'utf8')) : {};

const leerConfig = (clave: string): string => process.env[clave] ?? ENV_ARCHIVO[clave] ?? '';

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

const haySistema = (await sistemaDisponible()) && contenedorArriba('r1-postgres-1');

const SERVICIOS_CONTRATO = [
  'autenticacion',
  'usuarios',
  'correo',
  'viajes',
  'integraciones',
  'analitica',
  'asistente',
] as const;

const PARAMETROS_RUTA: Record<string, string> = {
  viajeId: '00000000-0000-4000-8000-000000000001',
  reservaId: '00000000-0000-4000-8000-000000000002',
  conversacionId: '00000000-0000-4000-8000-000000000003',
  cuentaId: '00000000-0000-4000-8000-000000000004',
  consultaId: '00000000-0000-4000-8000-000000000005',
  usuarioId: '00000000-0000-4000-8000-000000000006',
  email: 'otro@correo.example',
  proveedorCorreo: 'gmail',
  proveedor: 'aerolinea-andina',
  tipo: 'destinos',
  numeroReserva: 'RES-9999',
};

function materializarRuta(ruta: string): string {
  return ruta.replace(/\{([^}]+)\}/g, (_todo, nombre: string) => {
    const valor = PARAMETROS_RUTA[nombre];
    if (!valor) {
      throw new Error(`Parámetro de ruta sin valor de prueba en seguridad.test.ts: {${nombre}}`);
    }
    return encodeURIComponent(valor);
  });
}

function clavePrivadaRegion1(): { privada: KeyObject; kid: string } {
  const pemBase64 = leerConfig('JWT_CLAVE_PRIVADA_REGION_1');
  if (!pemBase64 || pemBase64.startsWith('cambiar-')) {
    const par = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return { privada: par.privateKey, kid: 'r1-clave-efimera' };
  }
  const privada = createPrivateKey(Buffer.from(pemBase64, 'base64').toString('utf8'));
  const { n, e } = createPublicKey(privada).export({ format: 'jwk' });
  if (!n || !e) throw new Error('No se pudo derivar JWK público de JWT_CLAVE_PRIVADA_REGION_1.');
  const huella = createHash('sha256')
    .update(JSON.stringify({ e, kty: 'RSA', n }))
    .digest('base64url')
    .slice(0, 12);
  return { privada, kid: `r1-${huella}` };
}

function firmarJwtRs256(privada: KeyObject, kid: string, payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const cuerpo = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const contenido = `${header}.${cuerpo}`;
  const firmador = createSign('RSA-SHA256');
  firmador.update(contenido);
  const firma = firmador.sign(privada).toString('base64url');
  return `${contenido}.${firma}`;
}

function descifrarAesGcmV1(claveBase64: string, paquete: string, aad: string): string {
  const clave = Buffer.from(claveBase64.trim(), 'base64');
  const partes = paquete.split('.');
  if (partes.length !== 4 || partes[0] !== 'v1') {
    throw new Error(`Formato AES-256-GCM inesperado: ${paquete}`);
  }
  const [, ivB64, tagB64, datosB64] = partes;
  if (!ivB64 || !tagB64 || !datosB64) {
    throw new Error('Paquete cifrado incompleto.');
  }
  const decipher = createDecipheriv('aes-256-gcm', clave, Buffer.from(ivB64, 'base64url'), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(datosB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function psql(contenedor: string, base: string, sql: string): string {
  return docker('exec', contenedor, 'psql', '-U', 'admin', '-d', base, '-tAc', sql);
}

/** Espera hasta 1 s a que `requestId` aparezca en `registro_accesos.accesos_rechazados` (QA-9). */
async function esperarAccesoRechazado(requestId: string): Promise<string> {
  if (!/^[a-zA-Z0-9-]+$/.test(requestId)) {
    throw new Error(`X-Request-Id inválido para consultar SQL: ${requestId}`);
  }
  const limite = Date.now() + 1000;
  for (;;) {
    const fila = psql(
      'r1-postgres-1',
      'registro_accesos',
      `SELECT servicio || ' ' || status || ' ' || motivo FROM accesos_rechazados
       WHERE request_id = '${requestId}'
       ORDER BY fecha DESC LIMIT 1`,
    );
    if (fila || Date.now() >= limite) return fila;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function pedirConRequestId(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; requestId: string; texto: string }> {
  const requestId = `seg-${randomUUID()}`;
  const headers = new Headers(init.headers);
  headers.set('X-Request-Id', requestId);
  const resp = await fetch(url, { ...init, headers });
  const texto = await resp.text();
  return {
    status: resp.status,
    requestId: resp.headers.get('x-request-id') ?? requestId,
    texto,
  };
}

describe.skipIf(!haySistema)('Pruebas de seguridad E2E (QA-8, QA-9)', () => {
  const contrasenaUnica = `SegE2E-${idAleatorio()}-Pwd!26`;
  const buzonA = `seg-a-${idAleatorio()}@gmail.example`;
  const buzonB = `seg-b-${idAleatorio()}@gmail.example`;

  let sesionA: SesionE2E;
  let sesionB: SesionE2E;
  let sesionDesignado: SesionE2E;
  let sesionTercero: SesionE2E;
  let analistaJwt: string;

  let viajeIdB = '';
  let reservaIdB = '';
  let cuentaIdB = '';
  let conversacionIdB = '';

  beforeAll(async () => {
    [sesionA, sesionB, sesionDesignado, sesionTercero] = await Promise.all([
      registrarYLogin({ nombre: 'Usuario Seg A', contrasena: contrasenaUnica }),
      registrarYLogin({ nombre: 'Usuario Seg B', contrasena: contrasenaUnica }),
      registrarYLogin({ nombre: 'Designado Seg' }),
      registrarYLogin({ nombre: 'Tercero Seg' }),
    ]);
    analistaJwt = (await loginAnalista('region-1')).jwt;

    // Usuario A y Usuario B conectan cuentas de correo por OAuth.
    await conectarOAuthMock({
      proveedor: 'gmail',
      emailBuzon: buzonA,
      jwt: sesionA.jwt,
      region: sesionA.region,
    });
    await conectarOAuthMock({
      proveedor: 'gmail',
      emailBuzon: buzonB,
      jwt: sesionB.jwt,
      region: sesionB.region,
    });

    const cuentasB = await pedirJson<{ cuentas: { id: string }[] }>(
      `${CONFIG_E2E.urlEnrutador}/api/correo/cuentas-correo`,
      { headers: { Authorization: `Bearer ${sesionB.jwt}`, 'X-Region': sesionB.region } },
    );
    expect(cuentasB.status).toBe(200);
    cuentaIdB = cuentasB.datos?.cuentas[0]?.id ?? '';
    expect(cuentaIdB).toBeTruthy();

    // Usuario B crea un viaje con una reserva manual.
    const alta = await pedirJson<{ reservaId: string; viajeId: string }>(
      `${CONFIG_E2E.urlEnrutador}/api/viajes/reservas`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sesionB.jwt}`,
          'X-Region': sesionB.region,
        },
        body: JSON.stringify({
          proveedor: 'aerolinea-andina',
          tipoReserva: 'vuelo',
          numeroReserva: `SEG-${idAleatorio()}`,
          inicio: '2026-12-22T09:00:00Z',
          fin: '2026-12-22T11:30:00Z',
          origen: 'Buenos Aires (EZE)',
          destino: 'Santiago (SCL)',
          detalle: { numeroVuelo: 'AN 4001', asiento: '8C' },
        }),
      },
    );
    expect(alta.status).toBe(201);
    viajeIdB = alta.datos?.viajeId ?? '';
    reservaIdB = alta.datos?.reservaId ?? '';
    expect(viajeIdB).toBeTruthy();
    expect(reservaIdB).toBeTruthy();

    // Usuario B crea una conversación con el asistente.
    const conv = await pedirJson<{ conversacionId: string }>(
      `${CONFIG_E2E.urlEnrutador}/api/asistente/conversaciones`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sesionB.jwt}`,
          'X-Region': sesionB.region,
        },
        body: JSON.stringify({ idioma: 'es' }),
      },
    );
    expect(conv.status).toBe(201);
    conversacionIdB = conv.datos?.conversacionId ?? '';
    expect(conversacionIdB).toBeTruthy();
  });

  afterAll(async () => {
    const sesiones = [sesionA, sesionB, sesionDesignado, sesionTercero].filter(
      (s): s is SesionE2E => s !== undefined,
    );
    await Promise.all(
      sesiones.flatMap((s) => [eliminarReservasUsuario(s), desconectarCuentasCorreo(s)]),
    );
  });

  it('todas las rutas protegidas de los 7 contratos rechazan sin token, con JWT vencido o con firma inválida (401)', async () => {
    const { privada, kid } = clavePrivadaRegion1();
    const ahoraSeg = Math.floor(Date.now() / 1000);
    const jwtExpirado = firmarJwtRs256(privada, kid, {
      sub: sesionA.usuarioId,
      region: 'region-1',
      roles: ['usuario'],
      idioma: 'es',
      iat: ahoraSeg - 600,
      exp: ahoraSeg - 60,
    });

    const claveDesconocida = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const jwtFirmaDesconocida = firmarJwtRs256(claveDesconocida, kid, {
      sub: sesionA.usuarioId,
      region: 'region-1',
      roles: ['usuario'],
      idioma: 'es',
      iat: ahoraSeg,
      exp: ahoraSeg + 900,
    });

    // También adulteramos la firma de un JWT emitido realmente por Autenticación.
    const partesJwtReal = sesionA.jwt.split('.');
    const firmaAdulterada =
      (partesJwtReal[2] ?? '').slice(0, -2) +
      ((partesJwtReal[2] ?? '').endsWith('AA') ? 'BB' : 'AA');
    const jwtAdulterado = `${partesJwtReal[0]}.${partesJwtReal[1]}.${firmaAdulterada}`;

    let rutasEvaluadas = 0;

    for (const servicio of SERVICIOS_CONTRATO) {
      const spec = cargarSpec(resolve(RAIZ, 'specs/openapi', `${servicio}.yaml`));
      const protegidas = spec.operaciones.filter(
        (op) => !op.ruta.startsWith('/interna') && op.seguridad.includes('bearerJWT'),
      );

      for (const op of protegidas) {
        rutasEvaluadas += 1;
        const url = `${CONFIG_E2E.urlEnrutador}/api/${servicio}${materializarRuta(op.ruta)}`;

        const casos: [string, string | undefined][] = [
          ['sin token', undefined],
          ['JWT expirado', jwtExpirado],
          ['JWT firma desconocida', jwtFirmaDesconocida],
          ['JWT firma adulterada', jwtAdulterado],
        ];

        for (const [etiqueta, token] of casos) {
          const resp = await fetch(url, {
            method: op.metodo,
            headers: {
              'X-Region': 'region-1',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
          });
          expect(
            resp.status,
            `${servicio} ${op.metodo} ${op.ruta} (${etiqueta}) respondió ${resp.status}`,
          ).toBe(401);
        }
      }
    }

    expect(rutasEvaluadas).toBeGreaterThan(20);
  });

  it('usuario A no puede leer ni modificar recursos de usuario B en ningún servicio', async () => {
    const headersA = {
      Authorization: `Bearer ${sesionA.jwt}`,
      'X-Region': sesionA.region,
      'Content-Type': 'application/json',
    };

    // 1. Viajes: lectura, edición, eliminación, publicación en red y agregado al viaje ajeno -> 403
    const verViajeB = await pedirConRequestId(
      `${CONFIG_E2E.urlEnrutador}/api/viajes/viajes/${viajeIdB}`,
      { headers: headersA },
    );
    expect(verViajeB.status).toBe(403);
    expect(await esperarAccesoRechazado(verViajeB.requestId)).toBe('viajes 403 sin-permiso');

    const patchReservaB = await pedirConRequestId(
      `${CONFIG_E2E.urlEnrutador}/api/viajes/reservas/${reservaIdB}`,
      {
        method: 'PATCH',
        headers: headersA,
        body: JSON.stringify({ estado: 'modificada' }),
      },
    );
    expect(patchReservaB.status).toBe(403);
    expect(await esperarAccesoRechazado(patchReservaB.requestId)).toBe('viajes 403 sin-permiso');

    const deleteReservaB = await pedirConRequestId(
      `${CONFIG_E2E.urlEnrutador}/api/viajes/reservas/${reservaIdB}`,
      { method: 'DELETE', headers: headersA },
    );
    expect(deleteReservaB.status).toBe(403);
    expect(await esperarAccesoRechazado(deleteReservaB.requestId)).toBe('viajes 403 sin-permiso');

    const compartirViajeB = await fetch(
      `${CONFIG_E2E.urlEnrutador}/api/viajes/viajes/${viajeIdB}/compartir-red`,
      {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({ red: 'redsocial' }),
      },
    );
    expect(compartirViajeB.status).toBe(403);

    const agregarEnViajeB = await fetch(`${CONFIG_E2E.urlEnrutador}/api/viajes/reservas`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({
        viajeId: viajeIdB,
        proveedor: 'hotel-cordillera',
        tipoReserva: 'hotel',
        numeroReserva: `AJENO-${idAleatorio()}`,
        inicio: '2026-12-22T15:00:00Z',
        fin: '2026-12-23T11:00:00Z',
        destino: 'Santiago',
      }),
    });
    expect(agregarEnViajeB.status).toBe(403);

    // 2. Usuarios (itinerarios compartidos): solo el dueño puede listar, designar o quitar -> 403
    const listarDesignados = await pedirConRequestId(
      `${CONFIG_E2E.urlEnrutador}/api/usuarios/itinerarios/${viajeIdB}/designados`,
      { headers: headersA },
    );
    expect(listarDesignados.status).toBe(403);
    expect(await esperarAccesoRechazado(listarDesignados.requestId)).toBe(
      'usuarios 403 sin-permiso',
    );

    const agregarDesignado = await fetch(
      `${CONFIG_E2E.urlEnrutador}/api/usuarios/itinerarios/${viajeIdB}/designados`,
      {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({ email: sesionTercero.email }),
      },
    );
    expect(agregarDesignado.status).toBe(403);

    const quitarDesignado = await fetch(
      `${CONFIG_E2E.urlEnrutador}/api/usuarios/itinerarios/${viajeIdB}/designados/${encodeURIComponent(sesionDesignado.email)}`,
      { method: 'DELETE', headers: headersA },
    );
    expect(quitarDesignado.status).toBe(403);

    // 3. Asistente: conversación ajena responde 404 (para no revelar existencia) y audita 403 QA-9
    const verConvB = await pedirConRequestId(
      `${CONFIG_E2E.urlEnrutador}/api/asistente/conversaciones/${conversacionIdB}`,
      { headers: headersA },
    );
    expect(verConvB.status).toBe(404);
    expect(await esperarAccesoRechazado(verConvB.requestId)).toBe('asistente 403 sin-permiso');

    const mensajesConvB = await fetch(
      `${CONFIG_E2E.urlEnrutador}/api/asistente/conversaciones/${conversacionIdB}/mensajes`,
      { headers: headersA },
    );
    expect(mensajesConvB.status).toBe(404);

    const enviarMensajeConvB = await pedirConRequestId(
      `${CONFIG_E2E.urlEnrutador}/api/asistente/conversaciones/${conversacionIdB}/mensajes`,
      {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({ texto: '¿Cuál es mi vuelo?' }),
      },
    );
    expect(enviarMensajeConvB.status).toBe(404);
    expect(await esperarAccesoRechazado(enviarMensajeConvB.requestId)).toBe(
      'asistente 403 sin-permiso',
    );

    const confirmarConvB = await fetch(
      `${CONFIG_E2E.urlEnrutador}/api/asistente/conversaciones/${conversacionIdB}/confirmaciones`,
      {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({ opcionId: 'opcion-inexistente' }),
      },
    );
    expect(confirmarConvB.status).toBe(404);

    // 4. Correo: usuario A no puede desconectar la casilla de usuario B -> 404
    const borrarCuentaB = await fetch(
      `${CONFIG_E2E.urlEnrutador}/api/correo/cuentas-correo/${cuentaIdB}`,
      { method: 'DELETE', headers: headersA },
    );
    expect(borrarCuentaB.status).toBe(404);

    // 5. Lecturas propias de usuario A nunca exponen datos de usuario B
    const perfilA = await pedirJson<{ usuarioId: string; email: string }>(
      `${CONFIG_E2E.urlEnrutador}/api/usuarios/perfil`,
      { headers: headersA },
    );
    expect(perfilA.status).toBe(200);
    expect(perfilA.datos?.usuarioId).toBe(sesionA.usuarioId);
    expect(perfilA.datos?.email).toBe(sesionA.email.toLowerCase());

    const panelA = await pedirJson<{ viajes: { viajeId: string }[] }>(
      `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
      { headers: headersA },
    );
    expect(panelA.status).toBe(200);
    expect((panelA.datos?.viajes ?? []).some((v) => v.viajeId === viajeIdB)).toBe(false);

    const cuentasA = await pedirJson<{ cuentas: { id: string; email: string }[] }>(
      `${CONFIG_E2E.urlEnrutador}/api/correo/cuentas-correo`,
      { headers: headersA },
    );
    expect(cuentasA.status).toBe(200);
    expect((cuentasA.datos?.cuentas ?? []).some((c) => c.id === cuentaIdB)).toBe(false);
  });

  it('itinerario compartido: solo dueño o designado acceden, y un tercero queda auditado en menos de 1 s (QA-9)', async () => {
    // 1. Usuario B designa a sesionDesignado para ver viajeIdB.
    const designacion = await fetch(
      `${CONFIG_E2E.urlEnrutador}/api/usuarios/itinerarios/${viajeIdB}/designados`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sesionB.jwt}`,
          'X-Region': sesionB.region,
        },
        body: JSON.stringify({ email: sesionDesignado.email }),
      },
    );
    expect(designacion.status).toBe(201);

    // 2. La persona designada puede leer el viaje completo (200).
    const lecturaDesignado = await pedirJson<{ viajeId: string }>(
      `${CONFIG_E2E.urlEnrutador}/api/viajes/viajes/${viajeIdB}`,
      {
        headers: {
          Authorization: `Bearer ${sesionDesignado.jwt}`,
          'X-Region': sesionDesignado.region,
        },
      },
    );
    expect(lecturaDesignado.status).toBe(200);
    expect(lecturaDesignado.datos?.viajeId).toBe(viajeIdB);

    // 3. Un tercero no designado recibe 403 y queda registrado en < 1 s en accesos_rechazados.
    const inicioMedicion = Date.now();
    const intentoTercero = await pedirConRequestId(
      `${CONFIG_E2E.urlEnrutador}/api/viajes/viajes/${viajeIdB}`,
      {
        headers: {
          Authorization: `Bearer ${sesionTercero.jwt}`,
          'X-Region': sesionTercero.region,
        },
      },
    );
    expect(intentoTercero.status).toBe(403);

    const filaAuditoria = await esperarAccesoRechazado(intentoTercero.requestId);
    const demoraMs = Date.now() - inicioMedicion;

    expect(filaAuditoria).toBe('viajes 403 sin-permiso');
    expect(demoraMs).toBeLessThan(1000);

    // Confirmar además que el usuarioId registrado coincide con sesionTercero.usuarioId.
    const usuarioRegistrado = psql(
      'r1-postgres-1',
      'registro_accesos',
      `SELECT usuario_id FROM accesos_rechazados WHERE request_id = '${intentoTercero.requestId}'`,
    );
    expect(usuarioRegistrado).toBe(sesionTercero.usuarioId);
  });

  it('el rol analista está bloqueado en todas las rutas de datos personales pero accede a analítica (ADR-005)', async () => {
    const headersAnalista = {
      Authorization: `Bearer ${analistaJwt}`,
      'X-Region': 'region-1',
    };

    // 1. El analista sí puede consultar reportes anonimizados de Analítica.
    const consultaAnalitica = await fetch(
      `${CONFIG_E2E.urlEnrutador}/api/analitica/consultas/destinos?desde=2026-01-01&hasta=2026-12-31`,
      { headers: headersAnalista },
    );
    expect(consultaAnalitica.status).toBe(200);

    // 2. El analista está bloqueado en TODAS las rutas protegidas de servicios de datos personales.
    const serviciosPersonales = [
      'usuarios',
      'correo',
      'viajes',
      'integraciones',
      'asistente',
    ] as const;

    let primerRequestId = '';
    for (const servicio of serviciosPersonales) {
      const spec = cargarSpec(resolve(RAIZ, 'specs/openapi', `${servicio}.yaml`));
      const rutasUsuario = spec.operaciones.filter(
        (op) => !op.ruta.startsWith('/interna') && op.seguridad.includes('bearerJWT'),
      );
      for (const op of rutasUsuario) {
        const url = `${CONFIG_E2E.urlEnrutador}/api/${servicio}${materializarRuta(op.ruta)}`;
        const resp = await pedirConRequestId(url, {
          method: op.metodo,
          headers: headersAnalista,
        });
        if (!primerRequestId) primerRequestId = resp.requestId;
        expect(
          resp.status,
          `analista en ${servicio} ${op.metodo} ${op.ruta} respondió ${resp.status}`,
        ).toBe(403);
      }
    }

    expect(primerRequestId).toBeTruthy();
    expect(await esperarAccesoRechazado(primerRequestId)).toBe('gateway 403 sin-permiso');
  });

  it('las rutas /interna/* de todos los contratos son inaccesibles desde el enrutador (404 y auditadas)', async () => {
    let internasProbadas = 0;

    for (const servicio of SERVICIOS_CONTRATO) {
      const spec = cargarSpec(resolve(RAIZ, 'specs/openapi', `${servicio}.yaml`));
      const internas = spec.operaciones.filter((op) => op.ruta.startsWith('/interna'));

      for (const op of internas) {
        internasProbadas += 1;
        const url = `${CONFIG_E2E.urlEnrutador}/api/${servicio}${materializarRuta(op.ruta)}`;

        // Sin token y con JWT válido de usuario deben recibir 404.
        const sinToken = await pedirConRequestId(url, {
          method: op.metodo,
          headers: { 'X-Region': 'region-1' },
        });
        expect(sinToken.status, `${servicio} ${op.metodo} ${op.ruta} sin token`).toBe(404);
        expect(await esperarAccesoRechazado(sinToken.requestId)).toBe('gateway 404 ruta-interna');

        const conJwt = await fetch(url, {
          method: op.metodo,
          headers: {
            Authorization: `Bearer ${sesionA.jwt}`,
            'X-Region': sesionA.region,
          },
        });
        expect(conJwt.status, `${servicio} ${op.metodo} ${op.ruta} con JWT`).toBe(404);
      }
    }

    // Variantes con encoding / mayúsculas también bloqueadas por esRutaInterna.
    const encoding = await pedirConRequestId(
      `${CONFIG_E2E.urlEnrutador}/api/usuarios/%69nterna/cuentas`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${sesionA.jwt}`, 'X-Region': 'region-1' },
      },
    );
    expect(encoding.status).toBe(404);
    expect(await esperarAccesoRechazado(encoding.requestId)).toBe('gateway 404 ruta-interna');

    const mayusculas = await fetch(`${CONFIG_E2E.urlEnrutador}/api/viajes/INTERNA/reservas`, {
      headers: { Authorization: `Bearer ${sesionA.jwt}`, 'X-Region': 'region-1' },
    });
    expect(mayusculas.status).toBe(404);

    expect(internasProbadas).toBeGreaterThan(10);
  });

  it('las bases de datos no almacenan contraseñas en texto plano ni tokens OAuth sin encriptar (QA-8)', () => {
    // 1. Autenticación: contraseña únicamente como hash Argon2id; refresh tokens como SHA-256 hex.
    const hashCredencial = psql(
      'r1-postgres-1',
      'autenticacion',
      `SELECT hash_contrasena FROM credenciales WHERE usuario_id = '${sesionA.usuarioId}'`,
    );
    expect(hashCredencial).toMatch(/^\$argon2id\$/);
    expect(hashCredencial).not.toContain(contrasenaUnica);

    const estadoRefresh = psql(
      'r1-postgres-1',
      'autenticacion',
      `SELECT count(*) || ':' || coalesce(bool_and(hash ~ '^[0-9a-f]{64}$'), false)
       FROM tokens_renovacion WHERE usuario_id = '${sesionA.usuarioId}'`,
    );
    const [cantRefresh = '0', todosSha256 = 'false'] = estadoRefresh.split(':');
    expect(Number(cantRefresh)).toBeGreaterThanOrEqual(1);
    expect(todosSha256).toBe('true');

    // 2. Correo: access_token_cifrado y refresh_token_cifrado cifrados con AES-256-GCM (v1.iv.tag.cipher)
    //    y sin ninguna columna de contraseña de correo.
    const columnasContrasenaCorreo = psql(
      'r1-postgres-1',
      'correo',
      `SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (column_name ILIKE '%contrasena%' OR column_name ILIKE '%password%')`,
    );
    expect(Number(columnasContrasenaCorreo)).toBe(0);

    const filaCorreo = psql(
      'r1-postgres-1',
      'correo',
      `SELECT access_token_cifrado || '|' || refresh_token_cifrado
       FROM cuentas_correo WHERE usuario_id = '${sesionA.usuarioId}' LIMIT 1`,
    );
    const [accessCifrado = '', refreshCifrado = ''] = filaCorreo.split('|');
    const regexAesGcm = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/;
    expect(accessCifrado).toMatch(regexAesGcm);
    expect(refreshCifrado).toMatch(regexAesGcm);

    // 3. Ninguna base de datos regional contiene la contraseña en texto plano.
    const literalSql = contrasenaUnica.replace(/'/g, "''");
    const sqlBuscarTexto = `
      DO $$
      DECLARE
        r record;
        c integer;
      BEGIN
        FOR r IN
          SELECT table_schema, table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
        LOOP
          EXECUTE format(
            'SELECT count(*) FROM %I.%I WHERE position($1 in coalesce(%I::text, '''')) > 0',
            r.table_schema, r.table_name, r.column_name
          ) INTO c USING '${literalSql}';
          IF c > 0 THEN
            RAISE EXCEPTION 'Contraseña encontrada en claro en %.%.%', r.table_schema, r.table_name, r.column_name;
          END IF;
        END LOOP;
      END $$;
    `;

    for (const db of [
      'autenticacion',
      'usuarios',
      'correo',
      'integraciones',
      'analitica',
      'asistente',
      'registro_accesos',
    ]) {
      expect(() => psql('r1-postgres-1', db, sqlBuscarTexto)).not.toThrow();
    }
    expect(() => psql('r1-postgres-viajes-1', 'viajes', sqlBuscarTexto)).not.toThrow();
  });

  it('los logs de los contenedores no contienen contraseñas, tokens OAuth en claro ni JWT completos (QA-8)', () => {
    const claveCorreo = leerConfig('CLAVE_TOKENS_CORREO');
    const secretosOAuthPlanos: string[] = [];

    if (claveCorreo && !claveCorreo.startsWith('cambiar-')) {
      const filaCorreo = psql(
        'r1-postgres-1',
        'correo',
        `SELECT access_token_cifrado || '|' || refresh_token_cifrado
         FROM cuentas_correo WHERE usuario_id = '${sesionA.usuarioId}' LIMIT 1`,
      );
      const [accessCifrado = '', refreshCifrado = ''] = filaCorreo.split('|');
      if (accessCifrado && refreshCifrado) {
        const accessPlano = descifrarAesGcmV1(claveCorreo, accessCifrado, sesionA.usuarioId);
        const refreshPlano = descifrarAesGcmV1(claveCorreo, refreshCifrado, sesionA.usuarioId);
        expect(accessPlano.length).toBeGreaterThan(8);
        expect(refreshPlano.length).toBeGreaterThan(8);
        secretosOAuthPlanos.push(accessPlano, refreshPlano);

        // Verificar también que esos tokens OAuth descifrados tampoco figuran en claro en Postgres.
        const rowCorreoCompleta = psql(
          'r1-postgres-1',
          'correo',
          `SELECT row_to_json(t)::text FROM cuentas_correo t WHERE usuario_id = '${sesionA.usuarioId}'`,
        );
        expect(rowCorreoCompleta).not.toContain(accessPlano);
        expect(rowCorreoCompleta).not.toContain(refreshPlano);
      }
    }

    const contenedores = [
      'global-enrutador-1',
      'r1-gateway-1',
      'r1-gateway-2',
      'r1-autenticacion-1',
      'r1-usuarios-1',
      'r1-correo-1',
      'r1-viajes-1',
      'r1-integraciones-1',
      'r1-analitica-1',
      'r1-asistente-1',
    ];

    const cadenasProhibidas = [
      contrasenaUnica,
      sesionA.jwt,
      sesionB.jwt,
      analistaJwt,
      ...secretosOAuthPlanos,
    ];

    for (const contenedor of contenedores) {
      if (!contenedorArriba(contenedor)) continue;
      const res = spawnSync('docker', ['logs', '--tail', '1000', contenedor], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      });
      const salida = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
      for (const secreto of cadenasProhibidas) {
        expect(salida, `El secreto apareció en logs de ${contenedor}`).not.toContain(secreto);
      }
      // Ningún header Authorization con JWT Bearer completo en texto plano.
      expect(salida, `JWT Bearer crudo en logs de ${contenedor}`).not.toMatch(
        /Bearer\s+eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
      );
    }
  });
});
