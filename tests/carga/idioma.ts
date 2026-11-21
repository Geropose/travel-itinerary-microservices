// QA-11: cambio de idioma y formatos en la aplicación web, contra el sistema levantado (P4.1).
//
// Análisis inicial, SEI 11: "la interfaz se presenta en el idioma y con los formatos del usuario
// [...] completa la tarea en menos de 2 minutos, con una tasa de error menor al 5 %".
// Iteración 4, Paso 7: los textos y formatos están en archivos de idioma; la medida se toma en el
// prototipo con pruebas de usuarios.
//
// Las pruebas con usuarios las tiene que hacer el grupo con personas. Este script mide lo que sí se
// puede medir sin personas, con un navegador real (Chromium, Playwright) y la web contra la API:
// 1. La tarea "cambiar el idioma a inglés" desde Preferencias: cuántos pasos lleva y cuánto tarda
//    la interfaz en cambiar.
// 2. Textos sin traducir: en cada pantalla, con la interfaz en inglés, busca textos de es.json que
//    no se tradujeron y líneas con letras del español (á, é, í, ó, ú, ñ, ¿, ¡); y al revés.
// 3. Formatos: fechas, horas y montos del panel y del detalle de un viaje, comparados con Intl
//    (es-AR y en-US, los locales de cada archivo de idioma).
// 4. El idioma queda guardado en el perfil: al entrar desde otro dispositivo, la web sale en inglés.
//
// Uso: node tests/carga/idioma.ts   (con npm run infra:levantar; levanta la web si no está)
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { duracion } from './calculos.ts';
import {
  CONFIG_E2E,
  eliminarReservasUsuario,
  escribir,
  esperar,
  pedirJson,
  registrarYLogin,
  sistemaDisponible,
} from './comun.ts';

const URL_WEB = 'http://localhost:5173';
const ZONA = 'America/Argentina/Buenos_Aires';
type Idioma = 'es' | 'en';
type Textos = Record<string, unknown>;

const leerJson = (archivo: string) =>
  JSON.parse(
    readFileSync(new URL(`../../web/src/idiomas/${archivo}`, import.meta.url), 'utf8'),
  ) as Textos;
const TEXTOS: Record<Idioma, Textos> = { es: leerJson('es.json'), en: leerJson('en.json') };
const LOCALE: Record<Idioma, string> = {
  es: (TEXTOS.es.formato as { locale: string }).locale,
  en: (TEXTOS.en.formato as { locale: string }).locale,
};

/** Todas las hojas de un archivo de idioma: clave con puntos → texto. */
function hojas(textos: Textos, prefijo = ''): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const [clave, valor] of Object.entries(textos)) {
    if (typeof valor === 'string') mapa.set(prefijo + clave, valor);
    else if (valor && typeof valor === 'object') {
      for (const [k, v] of hojas(valor as Textos, `${prefijo}${clave}.`)) mapa.set(k, v);
    }
  }
  return mapa;
}

/**
 * Pedazos de los textos de un idioma que no pueden aparecer en la interfaz del otro: se corta en
 * las variables ({{nombre}}) y se descartan los pedazos cortos o que también están en el otro idioma.
 */
function pedazosPropios(de: Idioma, otro: Idioma): string[] {
  const propios = hojas(TEXTOS[de]);
  const delOtro = [...hojas(TEXTOS[otro]).values()].join('\n');
  const pedazos = new Set<string>();
  for (const texto of propios.values()) {
    for (const pedazo of texto.split(/\{\{[^}]+\}\}|\n/)) {
      const limpio = pedazo.trim();
      if (limpio.length >= 6 && /[a-záéíóúñ]{3}/i.test(limpio) && !delOtro.includes(limpio)) {
        pedazos.add(limpio);
      }
    }
  }
  return [...pedazos];
}

const NOMBRES_IDIOMA = ['Español', 'English'];
const normalizar = (texto: string) => texto.replace(/\s+/g, ' ');

if (!(await sistemaDisponible())) {
  escribir('El sistema no está levantado: corré npm run infra:levantar.');
  process.exit(1);
}

// --- La web (Vite) contra el enrutador global -------------------------------------------------
let web: ChildProcess | undefined;
const webArriba = () =>
  fetch(URL_WEB, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);
if (!(await webArriba())) {
  const vite = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url));
  web = spawn(process.execPath, [vite, '--port', '5173', '--strictPort'], {
    cwd: fileURLToPath(new URL('../../web/', import.meta.url)),
    stdio: 'ignore',
  });
  for (let i = 0; i < 60 && !(await webArriba()); i += 1) await esperar(1000);
}

// --- Datos: usuario en español con un viaje de dos reservas -----------------------------------
const sesion = await registrarYLogin({ nombre: 'Ana Lopez', idioma: 'es' });
const cabeceras = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${sesion.jwt}`,
  'X-Region': sesion.region,
};
const RESERVAS = [
  {
    proveedor: 'aerolinea-andina',
    tipoReserva: 'vuelo',
    numeroReserva: `ID${Date.now()}`,
    inicio: '2026-12-20T08:30:00Z',
    fin: '2026-12-20T10:40:00Z',
    origen: 'Buenos Aires (EZE)',
    destino: 'Santiago (SCL)',
    detalle: { numeroVuelo: 'AN 1234', precio: 125000.5, moneda: 'ARS' },
  },
  {
    proveedor: 'hotel-cordillera',
    tipoReserva: 'hotel',
    numeroReserva: `IH${Date.now()}`,
    inicio: '2026-12-20T18:00:00Z',
    fin: '2026-12-23T14:00:00Z',
    destino: 'Santiago',
    detalle: { precio: 480, moneda: 'USD' },
  },
];
for (const reserva of RESERVAS) {
  const alta = await pedirJson(`${CONFIG_E2E.urlEnrutador}/api/viajes/reservas`, {
    method: 'POST',
    headers: cabeceras,
    body: JSON.stringify(reserva),
  });
  if (alta.status !== 201) throw new Error(`Reserva: HTTP ${alta.status}`);
}
const panelApi = await pedirJson<{ viajes: { viajeId: string }[] }>(
  `${CONFIG_E2E.urlEnrutador}/api/viajes/panel`,
  { headers: cabeceras },
);
const viajeId = panelApi.datos?.viajes[0]?.viajeId ?? '';
const PANTALLAS = [
  '/',
  `/viajes/${viajeId}`,
  '/archivados',
  '/correo',
  '/whitelist',
  '/preferencias',
  '/asistente',
];

/** Lo que se espera ver de las reservas, formateado con Intl como lo haría la web. */
function formatosEsperados(idioma: Idioma): string[] {
  const locale = LOCALE[idioma];
  const corta = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeZone: ZONA }).format(new Date(iso));
  const conHora = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: ZONA,
    }).format(new Date(iso));
  const moneda = (monto: number, codigo: string) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: codigo }).format(monto);
  return [
    corta('2026-12-20T08:30:00Z'),
    conHora('2026-12-20T08:30:00Z'),
    conHora('2026-12-23T14:00:00Z'),
    moneda(125000.5, 'ARS'),
    moneda(480, 'USD'),
  ].map(normalizar);
}

const navegador = await chromium.launch();

async function entrar(locale: string): Promise<Page> {
  const contexto = await navegador.newContext({ locale, timezoneId: ZONA });
  const pagina = await contexto.newPage();
  await pagina.goto(`${URL_WEB}/login`);
  await pagina.fill('input[name="email"]', sesion.email);
  await pagina.fill('input[name="contrasena"]', sesion.contrasena);
  await pagina.click('button[type="submit"]');
  await pagina.waitForURL(`${URL_WEB}/`);
  return pagina;
}

async function textoDe(pagina: Page, ruta: string): Promise<string> {
  await pagina.goto(`${URL_WEB}${ruta}`);
  await pagina.waitForLoadState('networkidle');
  await esperar(500);
  return normalizar(await pagina.innerText('body'));
}

interface Revision {
  pantallas: number;
  lineas: number;
  sinTraducir: { pantalla: string; texto: string }[];
}

/** Recorre las pantallas y busca textos del otro idioma. */
async function revisar(pagina: Page, idioma: Idioma): Promise<Revision> {
  const otro: Idioma = idioma === 'en' ? 'es' : 'en';
  const ajenos = pedazosPropios(otro, idioma);
  const revision: Revision = { pantallas: 0, lineas: 0, sinTraducir: [] };
  for (const ruta of PANTALLAS) {
    await pagina.goto(`${URL_WEB}${ruta}`);
    await pagina.waitForLoadState('networkidle');
    await esperar(500);
    const lineas = (await pagina.innerText('body'))
      .split('\n')
      .map((l) => normalizar(l).trim())
      .filter(Boolean);
    revision.pantallas += 1;
    revision.lineas += lineas.length;
    for (const linea of lineas) {
      // No cuentan: el selector de idioma (cada idioma con su propio nombre) ni los datos del
      // usuario (su email).
      if (NOMBRES_IDIOMA.includes(linea) || linea.includes(sesion.email)) continue;
      const deOtroIdioma =
        ajenos.some((p) => linea.includes(p)) || (idioma === 'en' && /[áéíóúñ¿¡]/i.test(linea));
      if (deOtroIdioma) revision.sinTraducir.push({ pantalla: ruta, texto: linea });
    }
  }
  return revision;
}

/** Cuáles de los formatos esperados aparecen en el panel y en el detalle del viaje. */
async function revisarFormatos(pagina: Page, idioma: Idioma) {
  const texto = (await textoDe(pagina, '/')) + (await textoDe(pagina, `/viajes/${viajeId}`));
  const esperados = formatosEsperados(idioma);
  return { esperados, faltan: esperados.filter((f) => !texto.includes(f)) };
}

try {
  // 1. En español: la web arranca en el idioma del perfil.
  const pagina = await entrar('es-AR');
  const revisionEs = await revisar(pagina, 'es');
  const formatosEs = await revisarFormatos(pagina, 'es');

  // 2. La tarea: desde el panel, cambiar el idioma a inglés y guardarlo en el perfil.
  await pagina.goto(`${URL_WEB}/`);
  await pagina.waitForLoadState('networkidle');
  const preferencias = TEXTOS.es.menu as { preferencias: string };
  const textosEn = TEXTOS.en.preferencias as { titulo: string; guardar: string; guardado: string };
  const inicioTarea = Date.now();
  await pagina.getByRole('link', { name: preferencias.preferencias }).first().click(); // paso 1
  await pagina.waitForSelector('select[name="idioma"]');
  const antesDelCambio = Date.now();
  await pagina.selectOption('select[name="idioma"]', 'en'); // paso 2
  await pagina.locator('html[lang="en"]').waitFor({ state: 'attached' });
  await pagina.locator('h1', { hasText: textosEn.titulo }).waitFor();
  const cambioMs = Date.now() - antesDelCambio;
  await pagina.getByRole('button', { name: textosEn.guardar }).click(); // paso 3
  await pagina.getByText(textosEn.guardado).waitFor();
  const tareaMs = Date.now() - inicioTarea;

  // 3. En inglés: textos y formatos.
  const revisionEn = await revisar(pagina, 'en');
  const formatosEn = await revisarFormatos(pagina, 'en');

  // 4. Otro dispositivo (navegador en español, sin nada guardado): sale en inglés por el perfil.
  const otroDispositivo = await entrar('es-AR');
  const idiomaOtro = await otroDispositivo.locator('html').getAttribute('lang');

  const lineasMal = revisionEs.sinTraducir.length + revisionEn.sinTraducir.length;
  const lineasTotal = revisionEs.lineas + revisionEn.lineas;
  escribir('QA-11: cambio de idioma y formatos en la web (Chromium, contra el sistema levantado)');
  escribir(
    `  Tarea "cambiar el idioma a inglés":   3 pasos (Preferencias, elegir English, Guardar), ${duracion(tareaMs)} con el navegador automático`,
  );
  escribir(`  La interfaz cambia en:                ${duracion(cambioMs)}, sin recargar`);
  escribir(
    `  Textos del otro idioma:               español ${revisionEs.sinTraducir.length} de ${revisionEs.lineas} líneas, inglés ${revisionEn.sinTraducir.length} de ${revisionEn.lineas} (${PANTALLAS.length} pantallas cada uno)`,
  );
  for (const { pantalla, texto } of [...revisionEs.sinTraducir, ...revisionEn.sinTraducir]) {
    escribir(`    ${pantalla}: ${texto.slice(0, 120)}`);
  }
  escribir(
    `  Formatos (es-AR):                     ${formatosEs.esperados.length - formatosEs.faltan.length} de ${formatosEs.esperados.length} (${formatosEs.esperados.join(' | ')})`,
  );
  escribir(
    `  Formatos (en-US):                     ${formatosEn.esperados.length - formatosEn.faltan.length} de ${formatosEn.esperados.length} (${formatosEn.esperados.join(' | ')})`,
  );
  if (formatosEs.faltan.length + formatosEn.faltan.length > 0) {
    escribir(`    Faltan: ${[...formatosEs.faltan, ...formatosEn.faltan].join(' | ')}`);
  }
  escribir(`  Otro dispositivo sale en:             ${idiomaOtro}`);
  escribir(
    JSON.stringify({
      tareaMs,
      cambioMs,
      pasos: 3,
      lineas: lineasTotal,
      lineasDelOtroIdioma: lineasMal,
      formatos: { es: formatosEs, en: formatosEn },
      idiomaOtroDispositivo: idiomaOtro,
    }),
  );
} finally {
  await navegador.close();
  await eliminarReservasUsuario(sesion);
  web?.kill();
}
