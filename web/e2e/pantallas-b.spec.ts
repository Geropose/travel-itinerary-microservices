// Pruebas Playwright de las pantallas de Persona B (P2.B7): Correo (OAuth Gmail/Outlook,
// última revisión y desconexión), Whitelist, Preferencias y Compartir itinerario.
// Corren en computadora y en teléfono (playwright.config.ts).
import { expect, test, type Page } from '@playwright/test';
import { apiFalsa, subDe, usuaria, type Cuenta, type ViajePrueba } from './api-falsa.ts';

async function iniciarSesion(page: Page, cuenta: Cuenta = usuaria) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(cuenta.email);
  await page.getByLabel('Contraseña').fill(cuenta.contrasena);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();
}

const menu = (page: Page) => page.getByRole('navigation', { name: 'Menú principal' });

test('correo: muestra última revisión, conecta Gmail y Outlook por OAuth y desconecta', async ({
  page,
}) => {
  const api = await apiFalsa(page, {
    cuentasCorreo: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        proveedorCorreo: 'gmail',
        email: 'vieja@gmail.example',
        estado: 'conectada',
        conectadaEn: '2026-11-10T10:00:00Z',
        ultimaRevision: '2026-11-18T14:30:00Z',
      },
    ],
  });

  await iniciarSesion(page);
  await menu(page).getByRole('link', { name: 'Correo' }).click();
  await expect(page.getByRole('heading', { name: 'Correo' })).toBeVisible();
  await expect(page.getByText('vieja@gmail.example')).toBeVisible();
  await expect(page.getByText(/Última revisión: 18\/11\/26/)).toBeVisible();

  // Conectar Outlook siguiendo la redirección OAuth al mock y volviendo a /correo.
  await page.getByRole('button', { name: 'Conectar Outlook' }).click();
  await expect(page.getByRole('heading', { name: 'Iniciar sesión en Microsoft' })).toBeVisible();
  await page.getByLabel('Cuenta').fill('ana.viajes@outlook.example');
  await page.getByRole('button', { name: 'Permitir' }).click();

  await expect(page).toHaveURL(/\/correo/);
  await expect(page.getByRole('status')).toHaveText('Cuenta conectada correctamente.');
  await expect(page.getByText('ana.viajes@outlook.example')).toBeVisible();
  await expect(page.getByText('Última revisión: todavía pendiente')).toBeVisible();

  // Si cancela el permiso OAuth en Gmail, muestra el motivo claro sin conectar la cuenta.
  await page.getByRole('button', { name: 'Conectar Gmail' }).click();
  await expect(page.getByRole('heading', { name: 'Acceder con Google' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Cancelaste el permiso en tu proveedor de correo.',
  );

  // Desconectar la cuenta anterior llama DELETE y la quita de la lista.
  await page.getByRole('button', { name: 'Desconectar vieja@gmail.example' }).click();
  await expect(page.getByRole('status')).toHaveText('Cuenta desconectada.');
  await expect(page.getByText('vieja@gmail.example')).toHaveCount(0);
  expect(api.a('/api/correo/cuentas-correo/11111111-1111-4111-8111-111111111111')).toHaveLength(1);
});

test('whitelist: agrega y quita remitentes y activa o desactiva filtros', async ({ page }) => {
  const api = await apiFalsa(page, {
    whitelist: {
      remitentesPermitidos: ['@hotel-cordillera.example'],
      filtrosActivos: false,
    },
  });

  await iniciarSesion(page);
  await menu(page).getByRole('link', { name: 'Whitelist' }).click();
  await expect(page.getByRole('heading', { name: 'Whitelist' })).toBeVisible();
  await expect(page.getByText('@hotel-cordillera.example')).toBeVisible();

  const toggle = page.getByLabel('Activar filtro de remitentes');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(page.getByText('Solo se procesan correos de la lista permitida.')).toBeVisible();

  // Validación cliente ante formato inválido.
  await page.getByLabel('Remitente o dominio').fill('texto-sin-arroba');
  await page.getByRole('button', { name: 'Agregar' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Ingresá un email válido o un dominio como @aerolinea.example.',
  );

  // Alta válida normalizada a minúscula y persistida vía PUT /whitelist.
  await page.getByLabel('Remitente o dominio').fill('  Reservas@Aerolinea-Andina.Example ');
  await page.getByRole('button', { name: 'Agregar' }).click();
  await expect(page.getByText('reservas@aerolinea-andina.example')).toBeVisible();

  // Quitar remitente existente.
  await page.getByRole('button', { name: 'Quitar @hotel-cordillera.example' }).click();
  await expect(page.getByText('@hotel-cordillera.example')).toHaveCount(0);

  const puts = api.a('/api/usuarios/whitelist').filter((p) => p.metodo === 'PUT');
  expect(puts.at(-1)?.cuerpo).toEqual({
    remitentesPermitidos: ['reservas@aerolinea-andina.example'],
    filtrosActivos: true,
  });

  // Desactivar filtros nuevamente.
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect(
    page.getByText('Filtro desactivado: se revisan todos los correos entrantes.'),
  ).toBeVisible();
});

test('preferencias: cambia idioma al instante y guarda idioma, moneda y agencia', async ({
  page,
}) => {
  const api = await apiFalsa(page, {
    perfil: {
      idioma: 'es',
      moneda: 'ARS',
      agenciaPreferida: null,
    },
  });

  await iniciarSesion(page);
  await page.getByRole('link', { name: 'Preferencias' }).click();
  await expect(page.getByRole('heading', { name: 'Preferencias' })).toBeVisible();

  // Cambiar idioma cambia la interfaz al instante antes de enviar el formulario.
  const form = page.locator('form');
  await form.getByLabel('Idioma').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await form.getByLabel('Currency').selectOption('USD');
  await expect(page.getByText(/Format preview: \$1,234\.50/)).toBeVisible();
  await form.getByLabel('Preferred agency').selectOption('viajes-del-plata');
  await page.getByRole('button', { name: 'Save preferences' }).click();

  await expect(page.getByRole('status')).toHaveText('Preferences saved.');
  const patch = api.a('/api/usuarios/perfil').find((p) => p.metodo === 'PATCH');
  expect(patch?.cuerpo).toEqual({
    idioma: 'en',
    moneda: 'USD',
    agenciaPreferida: 'viajes-del-plata',
  });

  // Al recargar mantiene idioma, moneda y agencia guardadas.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();
  await expect(form.getByLabel('Currency')).toHaveValue('USD');
  await expect(form.getByLabel('Preferred agency')).toHaveValue('viajes-del-plata');
});

test('compartir itinerario: desde el detalle del viaje designa y quita personas por email', async ({
  page,
}) => {
  const viajePropio: ViajePrueba = {
    viajeId: '9b2d6c1e-1f4a-4b7e-8c3d-2a1b0c9d8e7f',
    usuarioId: subDe(usuaria.email),
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
        numeroReserva: 'XKQ7PL',
        inicio: '2026-12-10T08:30:00Z',
        fin: '2026-12-10T10:45:00Z',
        origen: 'Buenos Aires (EZE)',
        destino: 'Santiago (SCL)',
        estado: 'confirmada',
        detalle: { numeroVuelo: 'AN 1234' },
        origenCambio: 'correo',
        actualizadoEn: '2026-11-18T12:00:00Z',
      },
    ],
  };

  const api = await apiFalsa(page, {
    panel: { viajes: [viajePropio] },
    designados: {
      [viajePropio.viajeId]: [
        {
          email: 'juan@correo.example',
          usuarioId: '6c1e8a2f-4b3d-4e5f-9a0b-1c2d3e4f5a6b',
          designadoEn: '2026-11-12T18:00:00Z',
        },
      ],
    },
  });

  await iniciarSesion(page);
  await page.getByRole('link', { name: 'Ver detalle y compartir' }).click();

  await expect(page).toHaveURL(`/viajes/${viajePropio.viajeId}`);
  await expect(page.getByRole('heading', { name: 'Santiago de Chile' })).toBeVisible();
  await expect(page.getByText('Código XKQ7PL')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Compartir itinerario' })).toBeVisible();
  await expect(page.getByText('juan@correo.example')).toBeVisible();

  // Designar una nueva persona por email.
  await page.getByLabel('Email de la persona').fill('Maria@Correo.Example');
  await page.getByRole('button', { name: 'Designar persona' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Se designó a maria@correo.example para ver el itinerario.',
  );
  await expect(page.getByText('maria@correo.example', { exact: true })).toBeVisible();
  await expect(page.getByText('Pendiente de registro')).toBeVisible();

  // No permite designar duplicado.
  await page.getByLabel('Email de la persona').fill('maria@correo.example');
  await page.getByRole('button', { name: 'Designar persona' }).click();
  await expect(page.getByRole('alert')).toHaveText('Esa persona ya está designada en este viaje.');

  // Quitar persona designada.
  await page.getByRole('button', { name: 'Quitar a juan@correo.example' }).click();
  await expect(page.getByRole('status')).toHaveText('Se quitó el permiso a juan@correo.example.');
  await expect(page.getByText('juan@correo.example', { exact: true })).toHaveCount(0);

  const deletes = api
    .a(`/api/usuarios/itinerarios/${viajePropio.viajeId}/designados/juan%40correo.example`)
    .concat(
      api.a(`/api/usuarios/itinerarios/${viajePropio.viajeId}/designados/juan@correo.example`),
    );
  expect(deletes.some((p) => p.metodo === 'DELETE')).toBe(true);
});

test('itinerario compartido recibido: muestra el viaje sin exponer ni pedir designados', async ({
  page,
}) => {
  const viajeAjeno: ViajePrueba = {
    viajeId: 'aaaa1111-2222-4333-8444-555566667777',
    usuarioId: '99999999-9999-4999-8999-999999999999',
    destino: 'Mendoza',
    inicio: '2026-12-20T10:00:00Z',
    fin: '2026-12-23T18:00:00Z',
    estado: 'activo',
    reservas: [],
  };

  const api = await apiFalsa(page, {
    viajes: [viajeAjeno],
    designados: {
      [viajeAjeno.viajeId]: [
        {
          email: usuaria.email,
          usuarioId: subDe(usuaria.email),
          designadoEn: '2026-11-15T10:00:00Z',
        },
      ],
    },
  });

  await iniciarSesion(page);
  await page.goto(`/viajes/${viajeAjeno.viajeId}`);
  await expect(page.getByRole('heading', { name: 'Mendoza' })).toBeVisible();
  await expect(page.getByText('Itinerario compartido contigo (solo lectura).')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Compartir itinerario' })).toHaveCount(0);
  expect(api.a(`/api/usuarios/itinerarios/${viajeAjeno.viajeId}/designados`)).toHaveLength(0);
});
