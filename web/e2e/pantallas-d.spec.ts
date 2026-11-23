// Pruebas Playwright de la Ventana de chat (P2.D6, Iteración 7, ADR-019):
// - Burbuja de chat en todas las pantallas del usuario (oculta para analista) + consulta de estado.
// - Reprogramación con botones de confirmación explícita (POST /confirmaciones).
// - Respuesta lenta (202 consultando) con polling cada 2 s, corte al llegar y corte al cerrar.
// - Asistente caído (/health 503 o 3 errores seguidos) oculta el chat y muestra
//   "Contactar a mi agencia" (POST /api/integraciones/agencias/casos).
import { expect, test, type Page } from '@playwright/test';
import { analista, apiFalsa, usuaria, type Cuenta } from './api-falsa.ts';

async function iniciarSesion(page: Page, cuenta: Cuenta = usuaria) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(cuenta.email);
  await page.getByLabel('Contraseña').fill(cuenta.contrasena);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

const menu = (page: Page) => page.getByRole('navigation', { name: 'Menú principal' });

test('burbuja en pantallas del usuario y conversación de consulta de estado (oculta para analista)', async ({
  page,
}) => {
  await apiFalsa(page);
  await iniciarSesion(page, usuaria);
  await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();
  await expect(page.getByTestId('chat-burbuja')).toBeVisible();

  // Sigue visible al navegar por otras pantallas del usuario.
  await menu(page).getByRole('link', { name: 'Correo' }).click();
  await expect(page.getByRole('heading', { name: 'Correo' })).toBeVisible();
  await expect(page.getByTestId('chat-burbuja')).toBeVisible();

  await page.getByTestId('chat-burbuja').click();
  await expect(page.getByTestId('ventana-chat')).toBeVisible();
  await expect(page.getByTestId('chat-mensaje-asistente').first()).toContainText(
    'asistente virtual de Trotamundos',
  );

  await page.getByLabel('Mensaje para el asistente').fill('¿Cuál es el estado de mi vuelo XKQ7PL?');
  await page.getByRole('button', { name: 'Enviar' }).click();

  await expect(page.getByTestId('chat-mensaje-usuario').last()).toContainText('XKQ7PL');
  await expect(page.getByTestId('chat-mensaje-asistente').last()).toContainText(
    'Tu vuelo XKQ7PL (EZE → SCL) está confirmado.',
  );
  await expect(page.getByTestId('chat-reservas')).toContainText('XKQ7PL');
  await expect(page.getByTestId('chat-reservas')).toContainText('Confirmada');

  // El analista no ve la burbuja del chat.
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page).toHaveURL('/login');
  await iniciarSesion(page, analista);
  await expect(page).toHaveURL('/analitica');
  await expect(page.getByTestId('chat-burbuja')).toHaveCount(0);
});

test('reprogramación con botones de confirmación explícita (POST /confirmaciones)', async ({
  page,
}) => {
  const api = await apiFalsa(page);
  await iniciarSesion(page, usuaria);
  await menu(page).getByRole('link', { name: 'Asistente' }).click();
  await expect(page.getByRole('heading', { name: 'Asistente', exact: true })).toBeVisible();
  await expect(page.getByTestId('chat-mensaje-asistente').first()).toBeVisible();

  await page.getByLabel('Mensaje para el asistente').fill('Quiero reprogramar mi vuelo XKQ7PL');
  await page.getByRole('button', { name: 'Enviar' }).click();

  await expect(page.getByTestId('chat-opciones')).toBeVisible();
  await expect(page.getByTestId('confirmar-opcion-ocr_XKQ7PL_1')).toBeEnabled();
  await expect(page.getByTestId('confirmar-opcion-ocr_XKQ7PL_2')).toBeEnabled();
  // Todavía no se aplicó ninguna opción antes del clic del usuario.
  expect(api.pedidos.filter((p) => p.ruta.endsWith('/confirmaciones'))).toHaveLength(0);

  await page.getByTestId('confirmar-opcion-ocr_XKQ7PL_2').click();

  await expect(page.getByTestId('chat-mensaje-asistente').last()).toContainText(
    'Reprogramación confirmada para XKQ7PL',
  );
  const confirmaciones = api.pedidos.filter((p) => p.ruta.endsWith('/confirmaciones'));
  expect(confirmaciones).toHaveLength(1);
  expect(confirmaciones[0]?.cuerpo).toEqual({ opcionId: 'ocr_XKQ7PL_2' });
  // Una vez confirmada, los botones de la oferta anterior quedan deshabilitados.
  await expect(page.getByTestId('confirmar-opcion-ocr_XKQ7PL_1')).toBeDisabled();
  await expect(page.getByTestId('confirmar-opcion-ocr_XKQ7PL_2')).toBeDisabled();
});

test('respuesta lenta (202 consultando): hace polling cada 2 s y corta al llegar y al cerrar', async ({
  page,
}) => {
  await page.clock.install();
  const api = await apiFalsa(page, {
    asistente: { reprogramacionLenta: true, sondeosHastaRespuesta: 2 },
  });
  await iniciarSesion(page, usuaria);
  await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();

  await page.getByTestId('chat-burbuja').click();
  await expect(page.getByTestId('chat-mensaje-asistente').first()).toBeVisible();

  await page.getByLabel('Mensaje para el asistente').fill('Necesito reprogramar mi vuelo');
  await page.getByRole('button', { name: 'Enviar' }).click();

  await expect(page.getByTestId('chat-consultando')).toBeVisible();
  await expect(page.getByTestId('chat-mensaje-asistente').last()).toContainText(
    'Estoy consultando con la aerolínea',
  );

  const contarPolls = () =>
    api.pedidos.filter(
      (p) => p.metodo === 'GET' && /\/conversaciones\/[^/]+\/mensajes$/.test(p.ruta),
    ).length;

  expect(contarPolls()).toBe(0);

  // Primer tick de 2 s: todavía consultando.
  await page.clock.runFor(2000);
  await expect.poll(contarPolls).toBe(1);
  await expect(page.getByTestId('chat-consultando')).toBeVisible();

  // Segundo tick de 2 s: llegan las opciones y se detiene el polling.
  await page.clock.runFor(2000);
  await expect.poll(contarPolls).toBe(2);
  await expect(page.getByTestId('chat-opciones')).toBeVisible();
  await expect(page.getByTestId('chat-consultando')).toHaveCount(0);

  // Al avanzar 6 s más, no debe volver a consultar GET /mensajes.
  await page.clock.runFor(6000);
  expect(contarPolls()).toBe(2);

  // También deja de consultar si se cierra la ventana de chat mientras está consultando.
  await page.getByRole('button', { name: 'Nueva conversación' }).click();
  await expect(page.getByTestId('chat-mensaje-asistente')).toHaveCount(1);

  await page.getByLabel('Mensaje para el asistente').fill('Quiero reprogramar otra vez');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByTestId('chat-consultando')).toBeVisible();

  await page.clock.runFor(2000);
  await expect.poll(contarPolls).toBe(3);

  await page.getByRole('button', { name: 'Cerrar chat' }).click();
  await expect(page.getByTestId('ventana-chat')).toHaveCount(0);

  await page.clock.runFor(6000);
  expect(contarPolls()).toBe(3);
});

test('asistente caído (/health 503): oculta el chat y muestra "Contactar a mi agencia" (ADR-019)', async ({
  page,
}) => {
  const api = await apiFalsa(page, {
    perfil: { agenciaPreferida: 'viajes-del-plata' },
    asistente: { caido: true },
  });
  await iniciarSesion(page, usuaria);
  await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();

  await expect(page.getByTestId('chat-burbuja')).toHaveCount(0);
  await expect(page.getByTestId('ventana-chat')).toHaveCount(0);
  const botonAgencia = page.getByRole('button', { name: 'Contactar a mi agencia' });
  await expect(botonAgencia).toBeVisible();

  await botonAgencia.click();
  await page
    .getByLabel('Resumen del problema')
    .fill('Necesito ayuda urgente para cambiar mi vuelo XKQ7PL');
  await page.getByRole('button', { name: 'Enviar a mi agencia' }).click();

  await expect(page.getByTestId('agencia-caso-creado')).toContainText('viajes-del-plata');
  const casos = api.a('/api/integraciones/agencias/casos');
  expect(casos).toHaveLength(1);
  expect(casos[0]?.cuerpo).toEqual({
    resumen: 'Necesito ayuda urgente para cambiar mi vuelo XKQ7PL',
  });
});

test('tras 3 errores seguidos del asistente, oculta el chat y muestra "Contactar a mi agencia"', async ({
  page,
}) => {
  const api = await apiFalsa(page, {
    perfil: { agenciaPreferida: 'viajes-del-plata' },
  });
  await iniciarSesion(page, usuaria);
  await expect(page.getByTestId('chat-burbuja')).toBeVisible();

  await page.getByTestId('chat-burbuja').click();
  await expect(page.getByTestId('chat-mensaje-asistente').first()).toBeVisible();

  api.setFallarMensajesAsistente(3);

  const entrada = page.getByLabel('Mensaje para el asistente');
  const botonEnviar = page.getByRole('button', { name: 'Enviar' });

  // Error 1 y error 2: avisa el error pero el chat sigue abierto.
  await entrada.fill('Intento 1');
  await botonEnviar.click();
  await expect(page.getByRole('alert')).toContainText('No pudimos enviar el mensaje.');
  await expect(page.getByTestId('ventana-chat')).toBeVisible();

  await botonEnviar.click();
  await expect(page.getByTestId('ventana-chat')).toBeVisible();

  // Error 3 consecutivo: oculta el chat y muestra el botón "Contactar a mi agencia".
  await botonEnviar.click();
  await expect(page.getByTestId('ventana-chat')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Contactar a mi agencia' })).toBeVisible();
});

test('una respuesta pendiente pertenece al chat desde el que se hizo la consulta', async ({
  page,
}) => {
  await apiFalsa(page, { asistente: { reprogramacionLenta: true } });

  const sondeoIniciado = Promise.withResolvers<undefined>();
  const permitirRespuesta = Promise.withResolvers<undefined>();
  const rutaSondeo = /\/api\/asistente\/conversaciones\/[^/]+\/mensajes\?desde=/;
  const textoAnterior = 'Respuesta del proveedor para la conversación anterior';
  await page.route(rutaSondeo, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    sondeoIniciado.resolve(undefined);
    await permitirRespuesta.promise;
    await route.fulfill({
      headers: { 'Access-Control-Allow-Origin': 'http://localhost:4173' },
      json: {
        consultando: false,
        ultimaSecuencia: 4,
        mensajes: [
          {
            mensajeId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
            secuencia: 4,
            autor: 'asistente',
            texto: textoAnterior,
            enviadoEn: '2026-11-21T12:00:00.000Z',
            resultado: 'respondido',
          },
        ],
      },
    });
  });

  await iniciarSesion(page, usuaria);
  await page.getByTestId('chat-burbuja').click();
  await expect(page.getByTestId('chat-mensaje-asistente').first()).toBeVisible();
  await page.getByLabel('Mensaje para el asistente').fill('Necesito reprogramar mi vuelo');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByTestId('chat-consultando')).toBeVisible();

  try {
    await sondeoIniciado.promise;
    const nuevaConversacion = page.waitForResponse(
      (respuesta) =>
        respuesta.url().endsWith('/api/asistente/conversaciones') &&
        respuesta.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Nueva conversación' }).click();
    expect((await nuevaConversacion).status()).toBe(201);
    await expect(page.getByTestId('chat-mensaje-asistente')).toHaveCount(1);
    const respuestaAnterior = page.waitForResponse(rutaSondeo);
    permitirRespuesta.resolve(undefined);
    await (await respuestaAnterior).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    await expect(page.getByText(textoAnterior)).toHaveCount(0);
  } finally {
    permitirRespuesta.resolve(undefined);
  }
});
