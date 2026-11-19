// Base de la aplicación web (P1.8): registro, login, cambio de idioma, ruta de analista y panel sin
// red. Corre en computadora y en teléfono (playwright.config.ts).
import { expect, test, type Page } from '@playwright/test';
import { analista, apiFalsa, usuaria, type Cuenta } from './api-falsa.ts';

async function iniciarSesion(page: Page, cuenta: Cuenta) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(cuenta.email);
  await page.getByLabel('Contraseña').fill(cuenta.contrasena);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

const menu = (page: Page) => page.getByRole('navigation', { name: 'Menú principal' });

test('registro: crea la cuenta en la región elegida e inicia sesión', async ({ page }) => {
  const api = await apiFalsa(page);
  await page.goto('/registro');
  await page.getByLabel('Nombre').fill('Beto Gómez');
  await page.getByLabel('Email').fill('beto@correo.example');
  await page.getByLabel('Contraseña').fill('una-contrasena-larga');
  await page.getByLabel('Región donde vivís').selectOption('region-2');
  await page.getByRole('button', { name: 'Crear cuenta' }).click();

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();
  await expect(menu(page).getByRole('link')).toHaveText([
    'Panel',
    'Archivados',
    'Correo',
    'Whitelist',
    'Asistente',
  ]);
  const [registro] = api.a('/api/autenticacion/registro');
  expect(registro?.cuerpo).toEqual({
    nombre: 'Beto Gómez',
    email: 'beto@correo.example',
    contrasena: 'una-contrasena-larga',
    region: 'region-2',
    idioma: 'es',
  });
  // El enrutador global manda el registro y el login a la región elegida.
  expect(registro?.headers['x-region']).toBe('region-2');
  expect(api.a('/api/autenticacion/login')[0]?.headers['x-region']).toBe('region-2');
});

test('registro con un email que ya existe: muestra el error', async ({ page }) => {
  await apiFalsa(page);
  await page.goto('/registro');
  await page.getByLabel('Nombre').fill('Ana');
  await page.getByLabel('Email').fill(usuaria.email);
  await page.getByLabel('Contraseña').fill('otra-contrasena-larga');
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('alert')).toHaveText('Ya existe una cuenta con ese email.');
});

test('login: recuerda la región de la cuenta y la manda en el próximo login', async ({ page }) => {
  const api = await apiFalsa(page);
  await page.goto('/login');
  await page.getByLabel('Email').fill(usuaria.email);
  await page.getByLabel('Contraseña').fill('equivocada');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('alert')).toHaveText('El email o la contraseña son incorrectos.');

  await iniciarSesion(page, usuaria);
  await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();
  // Dispositivo nuevo: el primer login va sin X-Region (el enrutador usa la región por defecto).
  expect(api.a('/api/autenticacion/login')[0]?.headers['x-region']).toBeUndefined();
  expect(await page.evaluate(() => localStorage.getItem('trotamundos.region'))).toBe('region-2');

  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page).toHaveURL('/login');
  expect(api.a('/api/autenticacion/logout')).toHaveLength(1);

  await iniciarSesion(page, usuaria);
  await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();
  expect(api.a('/api/autenticacion/login').at(-1)?.headers['x-region']).toBe('region-2');
  // Las solicitudes con sesión llevan el JWT.
  await menu(page).getByRole('link', { name: 'Correo' }).click();
  await expect(page.getByRole('heading', { name: 'Correo' })).toBeVisible();
  expect(api.a('/api/viajes/panel').at(-1)?.headers.authorization).toMatch(/^Bearer /);
});

test('cambio de idioma: textos y formatos de fecha y moneda', async ({ page }) => {
  await apiFalsa(page, {
    panel: {
      viajes: [
        {
          viajeId: '9b2d6c1e-1f4a-4b7e-8c3d-2a1b0c9d8e7f',
          usuarioId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          destino: 'Santiago de Chile',
          inicio: '2026-12-10T12:00:00Z',
          fin: '2026-12-15T12:00:00Z',
          estado: 'activo',
          reservas: [
            {
              reservaId: '4c2e8f1a-7b3d-4a5e-9c6f-0d1e2f3a4b5c',
              viajeId: '9b2d6c1e-1f4a-4b7e-8c3d-2a1b0c9d8e7f',
              proveedor: 'aerolinea-andina',
              tipoReserva: 'vuelo',
              numeroReserva: 'FMT123',
              inicio: '2026-12-10T12:00:00Z',
              fin: '2026-12-10T14:00:00Z',
              origen: 'EZE',
              destino: 'SCL',
              estado: 'confirmada',
              detalle: { precio: 1234.5 },
              origenCambio: 'correo',
              actualizadoEn: '2026-11-18T12:00:00Z',
            },
          ],
        },
      ],
    },
  });
  await page.goto('/login');
  await page.getByLabel('Idioma').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // Al iniciar sesión, la interfaz pasa al idioma de la cuenta (español).
  await page.getByLabel('Email').fill(usuaria.email);
  await page.getByLabel('Password').fill(usuaria.contrasena);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();
  await expect(page.getByTestId('precio-reserva-FMT123')).toContainText('1.234,50');
  await expect(page.getByText('Del 10/12/26 al 15/12/26')).toBeVisible();

  await page.getByLabel('Idioma').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('precio-reserva-FMT123')).toContainText('$1,234.50');
  await expect(page.getByText('From 12/10/26 to 12/15/26')).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main menu' }).getByRole('link', { name: 'Archived' }),
  ).toBeVisible();

  // Queda guardado en el dispositivo.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('la ruta de analista está bloqueada para un usuario común', async ({ page }) => {
  await apiFalsa(page);
  await iniciarSesion(page, usuaria);
  await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();
  await expect(menu(page).getByRole('link', { name: 'Analítica' })).toHaveCount(0);

  await page.goto('/analitica');
  await expect(page.getByRole('alert')).toContainText('No tenés permiso para ver esta pantalla.');
  await expect(page.getByRole('heading', { name: 'Analítica' })).toHaveCount(0);
});

test('el analista entra a Analítica y no a las pantallas del usuario', async ({ page }) => {
  await apiFalsa(page);
  await iniciarSesion(page, analista);
  await expect(page).toHaveURL('/analitica');
  await expect(page.getByRole('heading', { name: 'Analítica' })).toBeVisible();
  await expect(menu(page).getByRole('link')).toHaveText(['Analítica']);
  await page.goto('/correo');
  await expect(page).toHaveURL('/analitica');
});

test('sin red, la app abre y muestra el último panel guardado (QA-3)', async ({
  page,
  context,
}) => {
  const api = await apiFalsa(page, {
    panel: {
      viajes: [
        {
          viajeId: '9b2d6c1e-1f4a-4b7e-8c3d-2a1b0c9d8e7f',
          usuarioId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          destino: 'Santiago de Chile',
          inicio: '2026-12-10T12:00:00Z',
          fin: '2026-12-15T12:00:00Z',
          estado: 'activo',
          reservas: [],
        },
      ],
    },
  });
  await iniciarSesion(page, usuaria);
  await expect(page.getByText('Santiago de Chile')).toBeVisible();
  await expect(page.getByTestId('origen-panel')).toContainText('Actualizado');
  // El service worker ya guardó la aplicación.
  await page.evaluate(() => navigator.serviceWorker.ready);

  api.cortarRed();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('Santiago de Chile')).toBeVisible();
  await expect(page.getByText('Del 10/12/26 al 15/12/26')).toBeVisible();
  await expect(page.getByTestId('origen-panel')).toContainText('Sin conexión');
  await expect(page.getByRole('status')).toHaveText('Sin conexión');
  await context.setOffline(false);
});
