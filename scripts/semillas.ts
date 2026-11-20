// Semillas de todo el sistema (P3.1): crea 10 usuarios en region-1 y 10 en region-2 (más verifica
// al analista), conecta sus buzones de Gmail/Outlook por OAuth, carga whitelist y designados, y
// asegura reservas coherentes entre los mocks de correo y los mocks de proveedores.
//
//   npm run semillas
//
// Es idempotente: se puede volver a correr contra un entorno ya sembrado sin duplicar cuentas.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emailDe, NOMBRES, PROVEEDORES } from '@trotamundos/mocks-comun';
import { leerEnv } from '../infra/scripts/entorno.ts';

export type Region = 'region-1' | 'region-2';
export type ProveedorCorreo = 'gmail' | 'outlook';

export interface UsuarioSemilla {
  nombre: string;
  email: string;
  contrasena: string;
  region: Region;
  idioma: 'es' | 'en';
  moneda: string;
  agenciaPreferida: string | null;
  proveedorCorreo: ProveedorCorreo;
  emailBuzon: string;
  whitelist?: {
    filtrosActivos: boolean;
    remitentesPermitidos: string[];
  };
  designadoEmail?: string;
}

export interface ConfigSemillas {
  urlEnrutador: string;
  urlMockGmail: string;
  urlMockOutlook: string;
  urlMockAerolinea: string;
  contrasenaUsuarios: string;
  contrasenaAnalista: string;
  esperarPanelMs: number;
}

export interface ResumenSemillas {
  usuariosCreados: number;
  usuariosExistentes: number;
  correosConectados: number;
  whitelistsCargadas: number;
  designadosCargados: number;
  viajesDetectados: number;
  analistaVerificado: boolean;
}

export const CONTRASENA_USUARIOS_DEFECTO = 'Viajar-2026!';
export const EMAIL_ANALISTA = 'analista@trotamundos.example';
export const REMITENTES_PROVEEDORES = [
  PROVEEDORES.vuelo.remitente,
  PROVEEDORES.hotel.remitente,
  PROVEEDORES.auto.remitente,
] as const;

const INDICES_INGLES = new Set([4, 9, 14, 19]);
const INDICES_SIN_AGENCIA = new Set([9, 19]);
const INDICES_WHITELIST_ACTIVA = new Set([1, 11]);
const INDICES_WHITELIST_INACTIVA = new Set([2, 12]);

/**
 * Plan determinista de los 20 usuarios de prueba: 10 en region-1 y 10 en region-2, alineados 1 a 1
 * con los 20 buzones semilla de mocks/gmail y mocks/outlook y las reservas de mocks/proveedores.
 */
export function planUsuariosSemilla(contrasena = CONTRASENA_USUARIOS_DEFECTO): UsuarioSemilla[] {
  const usuarios: UsuarioSemilla[] = NOMBRES.map((nombre, indice) => {
    const region: Region = indice < 10 ? 'region-1' : 'region-2';
    const proveedorCorreo: ProveedorCorreo = indice % 2 === 0 ? 'gmail' : 'outlook';
    const idioma: 'es' | 'en' = INDICES_INGLES.has(indice) ? 'en' : 'es';
    const moneda = idioma === 'en' ? 'USD' : region === 'region-1' ? 'ARS' : 'EUR';
    const agenciaPreferida = INDICES_SIN_AGENCIA.has(indice) ? null : 'viajes-del-plata';

    let whitelist: UsuarioSemilla['whitelist'];
    if (INDICES_WHITELIST_ACTIVA.has(indice)) {
      whitelist = { filtrosActivos: true, remitentesPermitidos: [...REMITENTES_PROVEEDORES] };
    } else if (INDICES_WHITELIST_INACTIVA.has(indice)) {
      whitelist = { filtrosActivos: false, remitentesPermitidos: [PROVEEDORES.vuelo.remitente] };
    }

    return {
      nombre,
      email: emailDe(nombre, 'correo.example'),
      contrasena,
      region,
      idioma,
      moneda,
      agenciaPreferida,
      proveedorCorreo,
      emailBuzon: emailDe(
        nombre,
        proveedorCorreo === 'gmail' ? 'gmail.example' : 'outlook.example',
      ),
      ...(whitelist ? { whitelist } : {}),
    };
  });

  // Pares de itinerarios compartidos dentro de cada región (CONST-6).
  const paresDesignados: [number, number][] = [
    [0, 1], // Ana García -> Bruno Díaz (region-1)
    [2, 3], // Carla Méndez -> Diego Fernández (region-1)
    [10, 11], // Karina Molina -> Lucas Herrera (region-2)
  ];
  for (const [duenoIdx, designadoIdx] of paresDesignados) {
    const dueno = usuarios[duenoIdx];
    const designado = usuarios[designadoIdx];
    if (dueno && designado) dueno.designadoEmail = designado.email;
  }

  return usuarios;
}

/**
 * Construye un correo HTML con marcado JSON-LD schema.org para una reserva canónica que existe en
 * mocks/aerolinea (`XKQ7PL`), de modo que correo, viajes, aerolínea y asistente compartan el mismo
 * código de reserva de forma determinista.
 */
export function correoCanonicoVuelo(para: string, nombre: string) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FlightReservation',
    reservationNumber: 'XKQ7PL',
    reservationStatus: 'https://schema.org/ReservationConfirmed',
    underName: { '@type': 'Person', name: nombre },
    reservationFor: {
      '@type': 'Flight',
      flightNumber: 'AN 1234',
      airline: { '@type': 'Airline', name: 'Aerolínea Andina', iataCode: 'AN' },
      departureAirport: { '@type': 'Airport', name: 'Buenos Aires', iataCode: 'EZE' },
      arrivalAirport: { '@type': 'Airport', name: 'Santiago', iataCode: 'SCL' },
      departureTime: '2026-12-10T08:30:00-03:00',
      arrivalTime: '2026-12-10T10:40:00-03:00',
    },
    airplaneSeat: '14C',
  };
  return {
    de: `Aerolínea Andina <${PROVEEDORES.vuelo.remitente}>`,
    asunto: 'Confirmación de vuelo AN 1234 — Reserva XKQ7PL',
    texto: `Hola ${nombre}, tu vuelo AN 1234 EZE -> SCL del 10/12/2026 (código XKQ7PL) está confirmado.`,
    html: `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body><p>Reserva XKQ7PL confirmada.</p></body></html>`,
  };
}

/** Construye un correo HTML con marcado JSON-LD para la reserva canónica de Hotel Cordillera (`HC-48291`). */
export function correoCanonicoHotel(para: string, nombre: string) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'LodgingReservation',
    reservationNumber: 'HC-48291',
    reservationStatus: 'https://schema.org/ReservationConfirmed',
    underName: { '@type': 'Person', name: nombre },
    reservationFor: {
      '@type': 'LodgingBusiness',
      name: 'Hotel Cordillera',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'Av. Providencia 1200',
        addressLocality: 'Santiago',
        addressCountry: 'CL',
      },
    },
    checkinTime: '2026-12-10T15:00:00-03:00',
    checkoutTime: '2026-12-14T11:00:00-03:00',
  };
  return {
    de: `Hotel Cordillera <${PROVEEDORES.hotel.remitente}>`,
    asunto: 'Confirmación de estadía en Hotel Cordillera — HC-48291',
    texto: `Hola ${nombre}, tu reserva HC-48291 en Hotel Cordillera (Santiago) del 10/12/2026 al 14/12/2026 está confirmada.`,
    html: `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body><p>Reserva HC-48291 confirmada.</p></body></html>`,
  };
}

async function pedirJson<T>(
  url: string,
  init: RequestInit = {},
  reintentos503 = 3,
): Promise<{ status: number; datos: T | undefined; texto: string }> {
  for (let intento = 0; intento <= reintentos503; intento += 1) {
    const resp = await fetch(url, init);
    const texto = await resp.text();
    let datos: T | undefined;
    if (texto) {
      try {
        datos = JSON.parse(texto) as T;
      } catch {
        datos = undefined;
      }
    }
    if (resp.status !== 503 || intento === reintentos503) {
      return { status: resp.status, datos, texto };
    }
    await new Promise((r) => setTimeout(r, 500 * (intento + 1)));
  }
  throw new Error('Inalcanzable');
}

/**
 * Completa el flujo OAuth 2.0 real contra mock-gmail o mock-outlook sin navegador, respetando el
 * mismo recorrido HTTP que haría el usuario: /conectar → /decision → /oauth/callback.
 */
export async function completarOAuthEnMock(params: {
  urlEnrutador: string;
  urlMock: string;
  proveedor: ProveedorCorreo;
  emailBuzon: string;
  jwt: string;
  region: Region;
}): Promise<void> {
  const { urlEnrutador, urlMock, proveedor, emailBuzon, jwt, region } = params;

  const { status, datos, texto } = await pedirJson<{ urlAutorizacion: string }>(
    `${urlEnrutador}/api/correo/cuentas-correo/${proveedor}/conectar`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'X-Region': region },
    },
  );
  if (status !== 200 || !datos?.urlAutorizacion) {
    throw new Error(
      `No se pudo iniciar OAuth (${proveedor}) para ${emailBuzon}: HTTP ${status} ${texto}`,
    );
  }

  const urlAuth = new URL(datos.urlAutorizacion);
  const rutaDecision =
    proveedor === 'gmail' ? '/o/oauth2/v2/auth/decision' : '/common/oauth2/v2.0/authorize/decision';
  const formulario = new URLSearchParams();
  for (const clave of ['client_id', 'redirect_uri', 'scope', 'state', 'access_type']) {
    const valor = urlAuth.searchParams.get(clave);
    if (valor !== null) formulario.set(clave, valor);
  }
  formulario.set('email', emailBuzon);
  formulario.set('decision', 'permitir');

  const respDecision = await fetch(`${urlMock}${rutaDecision}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formulario.toString(),
    redirect: 'manual',
  });
  const urlCallback = respDecision.headers.get('location');
  if (respDecision.status !== 302 || !urlCallback) {
    const detalle = await respDecision.text();
    throw new Error(
      `El mock ${proveedor} no redirigió al callback para ${emailBuzon}: HTTP ${respDecision.status} ${detalle}`,
    );
  }

  const respCallback = await fetch(urlCallback, { redirect: 'manual' });
  const destinoFinal = respCallback.headers.get('location') ?? '';
  if (respCallback.status !== 302 || !destinoFinal.includes('resultado=conectada')) {
    const detalle = await respCallback.text();
    throw new Error(
      `El callback OAuth (${proveedor}) no conectó ${emailBuzon}: HTTP ${respCallback.status} Location=${destinoFinal} ${detalle}`,
    );
  }
}

interface SesionUsuario {
  usuario: UsuarioSemilla;
  usuarioId: string;
  jwt: string;
}

function subDeJwt(jwt: string): string {
  const carga = jwt.split('.')[1];
  if (!carga) throw new Error('JWT sin payload');
  const claims = JSON.parse(Buffer.from(carga, 'base64url').toString('utf8')) as { sub?: string };
  if (!claims.sub) throw new Error('JWT sin claim sub');
  return claims.sub;
}

async function registrarOIniciarSesion(
  urlEnrutador: string,
  usuario: UsuarioSemilla,
): Promise<{ sesion: SesionUsuario; creado: boolean }> {
  const reg = await pedirJson<{ usuarioId: string }>(`${urlEnrutador}/api/autenticacion/registro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Region': usuario.region },
    body: JSON.stringify({
      nombre: usuario.nombre,
      email: usuario.email,
      contrasena: usuario.contrasena,
      region: usuario.region,
      idioma: usuario.idioma,
    }),
  });
  if (reg.status !== 201 && reg.status !== 409) {
    throw new Error(
      `Falló el registro de ${usuario.email} (${usuario.region}): HTTP ${reg.status} ${reg.texto}`,
    );
  }

  const login = await pedirJson<{ jwt: string }>(`${urlEnrutador}/api/autenticacion/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Region': usuario.region },
    body: JSON.stringify({ email: usuario.email, contrasena: usuario.contrasena }),
  });
  if (login.status !== 200 || !login.datos?.jwt) {
    throw new Error(`Falló el login de ${usuario.email}: HTTP ${login.status} ${login.texto}`);
  }

  return {
    sesion: { usuario, usuarioId: subDeJwt(login.datos.jwt), jwt: login.datos.jwt },
    creado: reg.status === 201,
  };
}

async function esperarPrimerViaje(
  urlEnrutador: string,
  jwt: string,
  region: Region,
  timeoutMs: number,
): Promise<string | undefined> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const panel = await pedirJson<{ viajes: { viajeId: string }[] }>(
      `${urlEnrutador}/api/viajes/panel`,
      { headers: { Authorization: `Bearer ${jwt}`, 'X-Region': region } },
    );
    const primerViaje = panel.datos?.viajes[0]?.viajeId;
    if (panel.status === 200 && primerViaje) return primerViaje;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return undefined;
}

export async function ejecutarSemillas(config: ConfigSemillas): Promise<ResumenSemillas> {
  const { urlEnrutador, urlMockGmail, urlMockOutlook } = config;
  const salud = await pedirJson<{ estado: string }>(`${urlEnrutador}/health`);
  if (salud.status !== 200) {
    throw new Error(
      `El enrutador global no responde sano en ${urlEnrutador}/health (HTTP ${salud.status}). Corré primero: npm run infra:levantar`,
    );
  }

  const plan = planUsuariosSemilla(config.contrasenaUsuarios);
  const sesiones: SesionUsuario[] = [];
  let usuariosCreados = 0;
  let usuariosExistentes = 0;
  let correosConectados = 0;
  let whitelistsCargadas = 0;
  let designadosCargados = 0;

  process.stdout.write(`▶ Creando/verificando ${plan.length} usuarios (10 en r1, 10 en r2)...\n`);
  for (const usuario of plan) {
    const { sesion, creado } = await registrarOIniciarSesion(urlEnrutador, usuario);
    sesiones.push(sesion);
    if (creado) usuariosCreados += 1;
    else usuariosExistentes += 1;

    // Perfil: agencia preferida y moneda.
    const patch = await pedirJson(`${urlEnrutador}/api/usuarios/perfil`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sesion.jwt}`,
        'X-Region': usuario.region,
      },
      body: JSON.stringify({
        idioma: usuario.idioma,
        moneda: usuario.moneda,
        agenciaPreferida: usuario.agenciaPreferida,
      }),
    });
    if (patch.status !== 200) {
      throw new Error(
        `No se pudo actualizar perfil de ${usuario.email}: HTTP ${patch.status} ${patch.texto}`,
      );
    }

    // Whitelist si corresponde.
    if (usuario.whitelist) {
      const wl = await pedirJson(`${urlEnrutador}/api/usuarios/whitelist`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sesion.jwt}`,
          'X-Region': usuario.region,
        },
        body: JSON.stringify(usuario.whitelist),
      });
      if (wl.status !== 200) {
        throw new Error(
          `No se pudo cargar whitelist de ${usuario.email}: HTTP ${wl.status} ${wl.texto}`,
        );
      }
      whitelistsCargadas += 1;
    }
  }

  // Verificar analista en ambas regiones.
  let analistaVerificado = false;
  if (config.contrasenaAnalista) {
    for (const region of ['region-1', 'region-2'] as const) {
      const loginAnalista = await pedirJson<{ jwt: string }>(
        `${urlEnrutador}/api/autenticacion/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Region': region },
          body: JSON.stringify({
            email: EMAIL_ANALISTA,
            contrasena: config.contrasenaAnalista,
          }),
        },
      );
      if (loginAnalista.status !== 200) {
        throw new Error(
          `El analista no pudo iniciar sesión en ${region}: HTTP ${loginAnalista.status} ${loginAnalista.texto}`,
        );
      }
    }
    analistaVerificado = true;
  }

  // Conectar buzones de correo (OAuth real contra mock-gmail y mock-outlook).
  process.stdout.write('▶ Conectando buzones de Gmail y Outlook por OAuth...\n');
  for (const { usuario, jwt } of sesiones) {
    const existentes = await pedirJson<{ cuentas: { email: string }[] }>(
      `${urlEnrutador}/api/correo/cuentas-correo`,
      { headers: { Authorization: `Bearer ${jwt}`, 'X-Region': usuario.region } },
    );
    const yaConectada = existentes.datos?.cuentas.some(
      (c) => c.email.toLowerCase() === usuario.emailBuzon.toLowerCase(),
    );
    if (!yaConectada) {
      await completarOAuthEnMock({
        urlEnrutador,
        urlMock: usuario.proveedorCorreo === 'gmail' ? urlMockGmail : urlMockOutlook,
        proveedor: usuario.proveedorCorreo,
        emailBuzon: usuario.emailBuzon,
        jwt,
        region: usuario.region,
      });
      correosConectados += 1;
    }
  }

  // Inyectar en Ana García (region-1) los correos de las reservas canónicas XKQ7PL y HC-48291
  // (que ya existen en mocks/aerolinea y mocks/hotel) para facilitar demos y pruebas reproducibles.
  const ana = sesiones[0];
  if (ana) {
    const buzonAna = encodeURIComponent(ana.usuario.emailBuzon);
    const existentesAna = await pedirJson<{ asunto: string }[]>(
      `${urlMockGmail}/admin/buzones/${buzonAna}/correos`,
    );
    const asuntos = new Set((existentesAna.datos ?? []).map((c) => c.asunto));
    const correoVuelo = correoCanonicoVuelo(ana.usuario.emailBuzon, ana.usuario.nombre);
    if (!asuntos.has(correoVuelo.asunto)) {
      await fetch(`${urlMockGmail}/admin/buzones/${buzonAna}/correos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(correoVuelo),
      });
    }
    const correoHotel = correoCanonicoHotel(ana.usuario.emailBuzon, ana.usuario.nombre);
    if (!asuntos.has(correoHotel.asunto)) {
      await fetch(`${urlMockGmail}/admin/buzones/${buzonAna}/correos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(correoHotel),
      });
    }
  }

  // Esperar a que Correo → Viajes procese los buzones nuevos (prioridad 1) y compartir itinerarios.
  process.stdout.write(
    '▶ Esperando detección automática de reservas (Correo → Viajes) y configurando designados...\n',
  );
  let viajesDetectados = 0;
  for (const { usuario, jwt } of sesiones) {
    if (!usuario.designadoEmail) continue;
    const viajeId = await esperarPrimerViaje(
      urlEnrutador,
      jwt,
      usuario.region,
      config.esperarPanelMs,
    );
    if (!viajeId) {
      process.stderr.write(
        `  ⚠ ${usuario.email} todavía no mostró viajes en el panel dentro de ${config.esperarPanelMs} ms; se omitió designado.\n`,
      );
      continue;
    }
    viajesDetectados += 1;
    const respDesignado = await pedirJson(
      `${urlEnrutador}/api/usuarios/itinerarios/${viajeId}/designados`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'X-Region': usuario.region,
        },
        body: JSON.stringify({ email: usuario.designadoEmail }),
      },
    );
    if (respDesignado.status === 201 || respDesignado.status === 409) {
      designadosCargados += 1;
    } else {
      throw new Error(
        `No se pudo designar a ${usuario.designadoEmail} en ${viajeId}: HTTP ${respDesignado.status} ${respDesignado.texto}`,
      );
    }
  }

  // Contabilizar viajes presentes en el resto de los usuarios (sin bloquear).
  for (const { usuario, jwt } of sesiones) {
    if (usuario.designadoEmail) continue;
    const panel = await pedirJson<{ viajes: { viajeId: string }[] }>(
      `${urlEnrutador}/api/viajes/panel`,
      { headers: { Authorization: `Bearer ${jwt}`, 'X-Region': usuario.region } },
    );
    if (panel.status === 200 && (panel.datos?.viajes.length ?? 0) > 0) {
      viajesDetectados += 1;
    }
  }

  return {
    usuariosCreados,
    usuariosExistentes,
    correosConectados,
    whitelistsCargadas,
    designadosCargados,
    viajesDetectados,
    analistaVerificado,
  };
}

function cargarConfigDesdeEntorno(): ConfigSemillas {
  const raiz = fileURLToPath(new URL('../', import.meta.url));
  const rutaEnv = resolve(raiz, '.env');
  const archivo = existsSync(rutaEnv) ? leerEnv(readFileSync(rutaEnv, 'utf8')) : {};
  const val = (clave: string, defecto: string) => process.env[clave] ?? archivo[clave] ?? defecto;

  return {
    urlEnrutador: `http://localhost:${val('PUERTO_ENRUTADOR', '8000')}`,
    urlMockGmail: `http://localhost:${val('PUERTO_MOCK_GMAIL', '4001')}`,
    urlMockOutlook: `http://localhost:${val('PUERTO_MOCK_OUTLOOK', '4002')}`,
    urlMockAerolinea: `http://localhost:${val('PUERTO_MOCK_AEROLINEA', '4003')}`,
    contrasenaUsuarios: val('CONTRASENA_SEMILLAS', CONTRASENA_USUARIOS_DEFECTO),
    contrasenaAnalista: val('CONTRASENA_ANALISTA', ''),
    esperarPanelMs: Number(val('SEMILLAS_ESPERA_PANEL_MS', '60000')),
  };
}

const esPrincipal =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (esPrincipal) {
  const config = cargarConfigDesdeEntorno();
  try {
    const resumen = await ejecutarSemillas(config);
    process.stdout.write(
      [
        '',
        '✓ Semillas completadas:',
        `  - Usuarios creados: ${resumen.usuariosCreados} (ya existentes: ${resumen.usuariosExistentes})`,
        `  - Analista verificado (${EMAIL_ANALISTA}): ${resumen.analistaVerificado ? 'sí' : 'omitido (sin CONTRASENA_ANALISTA)'}`,
        `  - Buzones conectados por OAuth: ${resumen.correosConectados}`,
        `  - Whitelists configuradas: ${resumen.whitelistsCargadas}`,
        `  - Itinerarios compartidos (designados): ${resumen.designadosCargados}`,
        `  - Usuarios con viajes detectados en panel: ${resumen.viajesDetectados}/20`,
        `  - Contraseña de los 20 usuarios de prueba: ${config.contrasenaUsuarios}`,
        '  - Usuario demo region-1: ana.garcia@correo.example (Gmail, reservas XKQ7PL y HC-48291, comparte con bruno.diaz@correo.example)',
        '  - Usuario demo region-2: karina.molina@correo.example (Gmail, comparte con lucas.herrera@correo.example)',
        '',
      ].join('\n'),
    );
  } catch (error) {
    process.stderr.write(`✗ Error en semillas: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
