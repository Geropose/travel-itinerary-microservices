// QA-3: primer contenido en el móvil en menos de 1,4 s, con Lighthouse (P4.1).
//
// Análisis inicial, SEI 3: "el usuario abre la aplicación móvil [...] el primer contenido aparece en
// menos de 1,4 segundos". Iteración 4, Paso 7: "El panel guardado en el teléfono se muestra sin
// esperar a la red; estimamos 1 s para abrir la app y dibujarlo. Se mide en el prototipo."
//
// La aplicación móvil es la misma PWA de web/ (CONST-1). El script sirve la versión compilada
// (vite preview, en el puerto 5173 que acepta la API) y corre Lighthouse en modo móvil (el de
// siempre: teléfono de gama media, 4G lenta simulada y procesador 4 veces más lento):
// 1. Primera vez: navegador vacío, abre /login (todavía no hay sesión ni panel guardado).
// 2. App ya usada (el escenario de QA-3): un perfil de Chromium donde el usuario ya entró y vio su
//    panel (sesión, service worker y panel guardado en IndexedDB). Lighthouse abre / sin borrar nada.
// 3. Sin red: con el mismo perfil y el teléfono sin conexión, cuánto tarda en verse el panel.
//
// Uso: npm run carga:primer-contenido   (con npm run infra:levantar; compila la web antes)
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';
import puppeteer from 'puppeteer-core';
import { chromium, devices } from 'playwright';
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
const VECES = 5;
const DESTINO = 'Santiago (SCL)';

if (!(await sistemaDisponible())) {
  escribir('El sistema no está levantado: corré npm run infra:levantar.');
  process.exit(1);
}
const arriba = () =>
  fetch(URL_WEB, { signal: AbortSignal.timeout(2000) })
    .then(() => true)
    .catch(() => false);
if (await arriba()) {
  escribir('Ya hay algo en el puerto 5173: cerralo (la medición sirve la web compilada ahí).');
  process.exit(1);
}

// --- La web compilada (vite preview) -----------------------------------------------------------
const web = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url)),
    'preview',
    '--port',
    '5173',
    '--strictPort',
  ],
  { cwd: fileURLToPath(new URL('../../web/', import.meta.url)), stdio: 'ignore' },
);
for (let i = 0; i < 30 && !(await arriba()); i += 1) await esperar(1000);

// --- Un usuario con un viaje de dos reservas ---------------------------------------------------
const sesion = await registrarYLogin({ nombre: 'Viajera Movil', idioma: 'es' });
for (const reserva of [
  {
    proveedor: 'aerolinea-andina',
    tipoReserva: 'vuelo',
    numeroReserva: `MV${Date.now()}`,
    inicio: '2026-12-20T08:30:00Z',
    fin: '2026-12-20T10:40:00Z',
    origen: 'Buenos Aires (EZE)',
    destino: DESTINO,
  },
  {
    proveedor: 'hotel-cordillera',
    tipoReserva: 'hotel',
    numeroReserva: `MH${Date.now()}`,
    inicio: '2026-12-20T18:00:00Z',
    fin: '2026-12-23T14:00:00Z',
    destino: 'Santiago',
  },
]) {
  const alta = await pedirJson(`${CONFIG_E2E.urlEnrutador}/api/viajes/reservas`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sesion.jwt}`,
      'X-Region': sesion.region,
    },
    body: JSON.stringify(reserva),
  });
  if (alta.status !== 201) throw new Error(`Reserva: HTTP ${alta.status}`);
}

const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7'];
const telefono = { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
const perfil = mkdtempSync(join(tmpdir(), 'trotamundos-movil-'));

/**
 * Navegador para Lighthouse: CHROME_PATH si está definida; si no, el chrome-headless-shell que
 * instala Playwright (el mismo que usa Playwright sin ventana, así el perfil le sirve a los dos).
 */
function navegadorHeadless(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const carpeta = dirname(dirname(dirname(chromium.executablePath())));
  const shell = readdirSync(carpeta).find((d) => d.startsWith('chromium_headless_shell-'));
  if (!shell) throw new Error('Falta chrome-headless-shell: corré npx playwright install chromium');
  const subcarpeta = readdirSync(join(carpeta, shell)).find((d) =>
    d.startsWith('chrome-headless-shell'),
  );
  const ejecutable =
    process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  return join(carpeta, shell, subcarpeta ?? '', ejecutable);
}
const NAVEGADOR = navegadorHeadless();

interface Corrida {
  fcpMs: number;
  lcpMs: number;
  fcpObservadoMs: number;
  url: string;
}

/** Un puerto TCP libre de la computadora. */
const puertoLibre = () =>
  new Promise<number>((listo) => {
    const servidor = createServer().listen(0, () => {
      const { port } = servidor.address() as AddressInfo;
      servidor.close(() => listo(port));
    });
  });

/** Una corrida de Lighthouse (modo móvil por defecto) sobre la URL. */
async function lighthouseMovil(
  url: string,
  conPerfil: boolean,
  throttlingMethod: 'simulate' | 'devtools',
): Promise<Corrida> {
  // Con un puerto elegido acá, chrome-launcher no lee un DevToolsActivePort viejo del perfil.
  if (conPerfil) rmSync(join(perfil, 'DevToolsActivePort'), { force: true });
  const chrome = await chromeLauncher.launch({
    chromePath: NAVEGADOR,
    chromeFlags: [],
    port: await puertoLibre(),
    ...(conPerfil ? { userDataDir: perfil } : {}),
  });
  // Lighthouse trabaja sobre una página de puppeteer-core (su propia dependencia): así la conexión
  // se cierra antes de apagar el navegador.
  const navegador = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });
  try {
    const pagina = await navegador.newPage();
    const resultado = await lighthouse(
      url,
      {
        logLevel: process.env.LH_LOG === 'info' ? 'info' : 'error',
        onlyCategories: ['performance'],
        disableStorageReset: conPerfil,
        throttlingMethod,
      },
      undefined,
      pagina,
    );
    if (!resultado) throw new Error('Lighthouse no devolvió resultado');
    const { audits, finalDisplayedUrl } = resultado.lhr;
    const metricas = audits.metrics?.details as
      { items: { observedFirstContentfulPaint: number }[] } | undefined;
    return {
      fcpMs: audits['first-contentful-paint']?.numericValue ?? NaN,
      lcpMs: audits['largest-contentful-paint']?.numericValue ?? NaN,
      fcpObservadoMs: metricas?.items[0]?.observedFirstContentfulPaint ?? NaN,
      url: finalDisplayedUrl,
    };
  } finally {
    await navegador.disconnect();
    chrome.kill();
  }
}

const mediana = (valores: number[]) => {
  const v = [...valores].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)] ?? NaN;
};

try {
  // Perfil de la app ya usada: entrar, ver el panel y dejar que se guarde.
  const contexto = await chromium.launchPersistentContext(perfil, { ...telefono, locale: 'es-AR' });
  const pagina = contexto.pages()[0] ?? (await contexto.newPage());
  await pagina.goto(`${URL_WEB}/login`);
  await pagina.fill('input[name="email"]', sesion.email);
  await pagina.fill('input[name="contrasena"]', sesion.contrasena);
  await pagina.click('button[type="submit"]');
  await pagina.waitForURL(`${URL_WEB}/`);
  await pagina.getByText(DESTINO).first().waitFor();
  await pagina.evaluate('navigator.serviceWorker.ready.then(() => true)');
  await esperar(2000);
  await contexto.close();

  // simulate: la simulación de Lighthouse (lo que muestra por defecto). devtools: el teléfono lento
  // aplicado de verdad (procesador 4 veces más lento y red 4G lenta). Con el service worker la
  // simulación no tiene pedidos de red que demorar, así que en la app ya usada vale más devtools.
  const primeraVez: Corrida[] = [];
  const appUsada: Corrida[] = [];
  const primeraVezDevtools: Corrida[] = [];
  const appUsadaDevtools: Corrida[] = [];
  for (let i = 0; i < VECES; i += 1) {
    primeraVez.push(await lighthouseMovil(`${URL_WEB}/login`, false, 'simulate'));
    appUsada.push(await lighthouseMovil(`${URL_WEB}/`, true, 'simulate'));
    primeraVezDevtools.push(await lighthouseMovil(`${URL_WEB}/login`, false, 'devtools'));
    appUsadaDevtools.push(await lighthouseMovil(`${URL_WEB}/`, true, 'devtools'));
  }

  // Sin red: el panel guardado tiene que verse igual.
  const sinRed = await chromium.launchPersistentContext(perfil, { ...telefono, locale: 'es-AR' });
  await sinRed.setOffline(true);
  const paginaSinRed = sinRed.pages()[0] ?? (await sinRed.newPage());
  const inicio = Date.now();
  await paginaSinRed.goto(`${URL_WEB}/`);
  await paginaSinRed.getByText(DESTINO).first().waitFor({ timeout: 10_000 });
  const sinRedMs = Date.now() - inicio;
  await sinRed.close();

  const resumen = (nombre: string, corridas: Corrida[]) => {
    escribir(
      `  ${nombre}: FCP ${corridas.map((c) => duracion(c.fcpMs)).join(', ')} (mediana ${duracion(mediana(corridas.map((c) => c.fcpMs)))}); ` +
        `LCP mediana ${duracion(mediana(corridas.map((c) => c.lcpMs)))}; ` +
        `FCP sin simular mediana ${duracion(mediana(corridas.map((c) => c.fcpObservadoMs)))}; ` +
        `terminó en ${[...new Set(corridas.map((c) => new URL(c.url).pathname))].join(', ')}`,
    );
  };
  escribir('QA-3: primer contenido en el móvil (Lighthouse, modo móvil, web compilada)');
  resumen('Primera vez (/login, sin nada guardado)', primeraVez);
  resumen('App ya usada (/, sesión y panel guardados)', appUsada);
  resumen('Primera vez, teléfono lento aplicado (devtools)', primeraVezDevtools);
  resumen('App ya usada, teléfono lento aplicado (devtools)', appUsadaDevtools);
  escribir(`  Sin red, con el panel guardado: el panel se ve en ${duracion(sinRedMs)}`);
  escribir(
    JSON.stringify({ primeraVez, appUsada, primeraVezDevtools, appUsadaDevtools, sinRedMs }),
  );
} finally {
  web.kill();
  await eliminarReservasUsuario(sesion);
  try {
    rmSync(perfil, { recursive: true, force: true });
  } catch {
    // En Windows Chromium a veces tarda en soltar el perfil: queda en la carpeta temporal.
  }
}
