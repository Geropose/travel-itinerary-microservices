// Pruebas Playwright de las pantallas de Persona C (P2.C6):
// - Panel: viajes agrupados, reservas ordenadas, estados visibles, Intl, IndexedDB sin red (QA-3),
//   auto-refresco cada 60 s y al volver a la pestaña.
// - Alta, edición y baja manual de reservas (UC-4).
// - Archivados (UC-5).
// - Detalle de viaje para dueño (UC-4 + red social) y para designado (solo lectura).
// - Consola del equipo de datos en /analitica (rol analista, Map-Reduce y consultas rápidas).
import { expect, test, type Page } from '@playwright/test';
import { analista, apiFalsa, subDe, usuaria, type Cuenta, type ViajePrueba } from './api-falsa.ts';

async function iniciarSesion(page: Page, cuenta: Cuenta = usuaria) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(cuenta.email);
  await page.getByLabel('Contraseña').fill(cuenta.contrasena);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

const menu = (page: Page) => page.getByRole('navigation', { name: 'Menú principal' });

const VIAJE_ACTIVO: ViajePrueba = {
  viajeId: '10000000-0000-4000-8000-000000000001',
  usuarioId: subDe(usuaria.email),
  destino: 'Santiago de Chile',
  inicio: '2026-12-10T08:30:00Z',
  fin: '2026-12-14T15:00:00Z',
  estado: 'activo',
  reservas: [
    // Intencionalmente desordenadas para verificar que el Panel las muestra en orden cronológico.
    {
      reservaId: '20000000-0000-4000-8000-000000000003',
      viajeId: '10000000-0000-4000-8000-000000000001',
      proveedor: 'rentadora-sur',
      tipoReserva: 'auto',
      numeroReserva: 'CAR900',
      inicio: '2026-12-12T12:00:00Z',
      fin: '2026-12-14T15:00:00Z',
      origen: 'Aeropuerto SCL',
      destino: 'Aeropuerto SCL',
      estado: 'cancelada',
      detalle: { precio: 250, moneda: 'USD', vehiculo: 'Sedan compacto' },
      origenCambio: 'proveedor',
      actualizadoEn: '2026-11-18T11:00:00Z',
    },
    {
      reservaId: '20000000-0000-4000-8000-000000000001',
      viajeId: '10000000-0000-4000-8000-000000000001',
      proveedor: 'aerolinea-andina',
      tipoReserva: 'vuelo',
      numeroReserva: 'FLT100',
      inicio: '2026-12-10T08:30:00Z',
      fin: '2026-12-10T10:45:00Z',
      origen: 'Buenos Aires (EZE)',
      destino: 'Santiago (SCL)',
      estado: 'confirmada',
      detalle: { precio: 1234.5, numeroVuelo: 'AN 1234', asiento: '14C' },
      origenCambio: 'correo',
      actualizadoEn: '2026-11-18T10:00:00Z',
    },
    {
      reservaId: '20000000-0000-4000-8000-000000000002',
      viajeId: '10000000-0000-4000-8000-000000000001',
      proveedor: 'hotel-cordillera',
      tipoReserva: 'hotel',
      numeroReserva: 'HTL200',
      inicio: '2026-12-10T15:00:00Z',
      fin: '2026-12-14T11:00:00Z',
      destino: 'Santiago Centro',
      estado: 'modificada',
      detalle: { precio: 600, moneda: 'USD', habitacion: 'Doble superior' },
      origenCambio: 'proveedor',
      actualizadoEn: '2026-11-18T10:30:00Z',
    },
  ],
};

test('panel: ordena reservas, muestra estados visibles, formatos Intl y refresca al volver y cada 60 s', async ({
  page,
}) => {
  await page.clock.install();
  const api = await apiFalsa(page, { panel: { viajes: [VIAJE_ACTIVO] } });

  await iniciarSesion(page);
  await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();

  const tarjetaViaje = page.getByTestId(`viaje-${VIAJE_ACTIVO.viajeId}`);
  await expect(tarjetaViaje.getByRole('heading', { name: 'Santiago de Chile' })).toBeVisible();
  await expect(tarjetaViaje.getByText('3 reservas')).toBeVisible();

  // Reservas ordenadas cronológicamente (vuelo -> hotel -> auto).
  const codigos = await tarjetaViaje
    .locator('[data-testid^="reserva-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  expect(codigos).toEqual(['reserva-FLT100', 'reserva-HTL200', 'reserva-CAR900']);

  // Los tres estados visibles.
  await expect(page.getByTestId('estado-reserva-FLT100')).toHaveText('Confirmada');
  await expect(page.getByTestId('estado-reserva-HTL200')).toHaveText('Modificada');
  await expect(page.getByTestId('estado-reserva-CAR900')).toHaveText('Cancelada');

  // Monedas y fechas con Intl.
  await expect(page.getByTestId('precio-reserva-FLT100')).toContainText('1.234,50');
  await expect(page.getByTestId('precio-reserva-HTL200')).toContainText('600,00');

  // Al volver a la pestaña (visibilitychange) refresca el panel contra la red.
  api.actualizarPanel([
    {
      ...VIAJE_ACTIVO,
      destino: 'Valparaíso y Santiago',
    },
  ]);
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('heading', { name: 'Valparaíso y Santiago' })).toBeVisible();

  // A los 60 s vuelve a refrescar automáticamente.
  const pedidosAntes = api.a('/api/viajes/panel').length;
  api.actualizarPanel([
    {
      ...VIAJE_ACTIVO,
      destino: 'Santiago Actualizado 60s',
    },
  ]);
  await page.clock.runFor(60_000);
  await expect(page.getByRole('heading', { name: 'Santiago Actualizado 60s' })).toBeVisible();
  expect(api.a('/api/viajes/panel').length).toBeGreaterThan(pedidosAntes);
});

test('panel sin red: abre desde IndexedDB con sus reservas, estados y precios (QA-3)', async ({
  page,
  context,
}) => {
  const api = await apiFalsa(page, { panel: { viajes: [VIAJE_ACTIVO] } });
  await iniciarSesion(page);

  await expect(page.getByTestId('estado-reserva-CAR900')).toHaveText('Cancelada');
  await expect(page.getByTestId('origen-panel')).toContainText('Actualizado');
  await page.evaluate(() => navigator.serviceWorker.ready);

  api.cortarRed();
  await context.setOffline(true);
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Santiago de Chile' })).toBeVisible();
  await expect(page.getByTestId('estado-reserva-FLT100')).toHaveText('Confirmada');
  await expect(page.getByTestId('estado-reserva-HTL200')).toHaveText('Modificada');
  await expect(page.getByTestId('estado-reserva-CAR900')).toHaveText('Cancelada');
  await expect(page.getByTestId('precio-reserva-FLT100')).toContainText('1.234,50');
  await expect(page.getByTestId('origen-panel')).toContainText('Sin conexión');
  await context.setOffline(false);
});

test('gestión manual UC-4: alta, edición y baja de reservas desde el panel', async ({ page }) => {
  const api = await apiFalsa(page, { panel: { viajes: [] } });
  await iniciarSesion(page);
  await expect(page.getByText('Todavía no hay viajes activos para mostrar.')).toBeVisible();

  // Alta manual: valida que un vuelo requiere origen.
  await page.getByRole('button', { name: 'Agregar reserva' }).click();
  await page.getByLabel('Proveedor').fill('aerolinea-andina');
  await page.getByLabel('Número de reserva').fill('MAN001');
  await page.getByLabel('Destino').fill('Bariloche (BRC)');
  await page.getByLabel('Inicio').fill('2026-12-20T09:00');
  await page.getByLabel('Fin').fill('2026-12-20T11:30');
  await page.getByRole('button', { name: 'Guardar reserva' }).click();
  await expect(page.getByRole('alert')).toHaveText('Para un vuelo tenés que indicar el origen.');

  // Completa origen y precio -> POST /reservas.
  await page.getByLabel('Origen').fill('Buenos Aires (AEP)');
  await page.getByLabel('Precio (opcional)').fill('450.75');
  await page.getByLabel('Moneda (opcional)').selectOption('USD');
  await page.getByRole('button', { name: 'Guardar reserva' }).click();

  await expect(page.getByRole('status')).toHaveText('Reserva MAN001 agregada.');
  await expect(page.getByRole('heading', { name: 'Bariloche (BRC)' })).toBeVisible();
  await expect(page.getByTestId('estado-reserva-MAN001')).toHaveText('Confirmada');
  await expect(page.getByTestId('precio-reserva-MAN001')).toContainText('450,75');

  const altaPedido = api.a('/api/viajes/reservas').find((p) => p.metodo === 'POST');
  expect(altaPedido?.cuerpo).toMatchObject({
    proveedor: 'aerolinea-andina',
    tipoReserva: 'vuelo',
    numeroReserva: 'MAN001',
    origen: 'Buenos Aires (AEP)',
    destino: 'Bariloche (BRC)',
    detalle: { precio: 450.75, moneda: 'USD' },
  });

  // Edición manual -> PATCH /reservas/:id (cambia estado y destino).
  await page.getByRole('button', { name: 'Editar reserva MAN001' }).click();
  await page.getByLabel('Destino').fill('San Carlos de Bariloche (BRC)');
  await page.getByLabel('Estado', { exact: true }).selectOption('modificada');
  await page.getByRole('button', { name: 'Guardar cambios' }).click();

  await expect(page.getByRole('status')).toHaveText('Reserva MAN001 actualizada.');
  await expect(page.getByTestId('estado-reserva-MAN001')).toHaveText('Modificada');
  await expect(page.getByRole('heading', { name: 'San Carlos de Bariloche (BRC)' })).toBeVisible();

  // Baja manual con confirmación inline -> DELETE /reservas/:id.
  await page.getByRole('button', { name: 'Eliminar reserva MAN001' }).click();
  await expect(page.getByText('¿Eliminar la reserva MAN001?')).toBeVisible();
  await page.getByRole('button', { name: 'Confirmar eliminación' }).click();

  await expect(page.getByRole('status')).toHaveText('Reserva MAN001 eliminada.');
  await expect(page.getByTestId('reserva-MAN001')).toHaveCount(0);
  await expect(page.getByText('Todavía no hay viajes activos para mostrar.')).toBeVisible();
});

test('archivados UC-5: lista viajes archivados en solo lectura y abre su detalle', async ({
  page,
}) => {
  const viajeArchivado: ViajePrueba = {
    viajeId: '30000000-0000-4000-8000-000000000001',
    usuarioId: subDe(usuaria.email),
    destino: 'Montevideo',
    inicio: '2026-08-01T10:00:00Z',
    fin: '2026-08-05T18:00:00Z',
    estado: 'archivado',
    reservas: [
      {
        reservaId: '40000000-0000-4000-8000-000000000001',
        viajeId: '30000000-0000-4000-8000-000000000001',
        proveedor: 'hotel-cordillera',
        tipoReserva: 'hotel',
        numeroReserva: 'ARC777',
        inicio: '2026-08-01T15:00:00Z',
        fin: '2026-08-05T11:00:00Z',
        destino: 'Montevideo',
        estado: 'confirmada',
        detalle: { precio: 320, moneda: 'USD' },
        origenCambio: 'archivado',
        actualizadoEn: '2026-08-06T03:00:00Z',
      },
    ],
  };

  await apiFalsa(page, { archivados: [viajeArchivado] });
  await iniciarSesion(page);

  await menu(page).getByRole('link', { name: 'Archivados' }).click();
  await expect(page).toHaveURL('/archivados');
  await expect(page.getByRole('heading', { name: 'Archivados' })).toBeVisible();

  const tarjeta = page.getByTestId(`viaje-archivado-${viajeArchivado.viajeId}`);
  await expect(tarjeta.getByRole('heading', { name: 'Montevideo' })).toBeVisible();
  await expect(tarjeta.getByTestId('estado-reserva-ARC777')).toHaveText('Confirmada');
  await expect(tarjeta.getByRole('button', { name: /Editar/ })).toHaveCount(0);
  await expect(tarjeta.getByRole('button', { name: /Eliminar/ })).toHaveCount(0);

  await tarjeta.getByRole('link', { name: 'Ver detalle' }).click();
  await expect(page).toHaveURL(`/viajes/${viajeArchivado.viajeId}`);
  await expect(
    page.getByText('Este viaje está archivado y se muestra en modo solo lectura.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Agregar reserva a este viaje' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Volver a archivados' })).toBeVisible();
});

test('detalle de viaje: dueño publica en red social y designado solo ve en modo lectura', async ({
  page,
}) => {
  const viajeAjeno: ViajePrueba = {
    viajeId: '50000000-0000-4000-8000-000000000002',
    usuarioId: '99999999-9999-4999-8999-999999999999',
    destino: 'Córdoba',
    inicio: '2026-12-22T09:00:00Z',
    fin: '2026-12-26T18:00:00Z',
    estado: 'activo',
    reservas: [
      {
        reservaId: '60000000-0000-4000-8000-000000000002',
        viajeId: '50000000-0000-4000-8000-000000000002',
        proveedor: 'aerolinea-andina',
        tipoReserva: 'vuelo',
        numeroReserva: 'COR404',
        inicio: '2026-12-22T09:00:00Z',
        fin: '2026-12-22T10:30:00Z',
        origen: 'AEP',
        destino: 'COR',
        estado: 'modificada',
        detalle: { numeroVuelo: 'AN 555' },
        origenCambio: 'proveedor',
        actualizadoEn: '2026-11-18T12:00:00Z',
      },
    ],
  };

  await apiFalsa(page, {
    panel: { viajes: [VIAJE_ACTIVO] },
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

  // Como dueño: puede publicar en red social y editar reservas.
  await page.getByRole('link', { name: 'Ver detalle y compartir' }).click();
  await expect(page.getByRole('button', { name: 'Agregar reserva a este viaje' })).toBeVisible();
  await page.getByRole('button', { name: 'Publicar en red social' }).click();
  await expect(page.getByRole('link', { name: 'Ver publicación' })).toBeVisible();

  // Como persona designada: vista estrictamente solo lectura.
  await page.goto(`/viajes/${viajeAjeno.viajeId}`);
  await expect(page.getByRole('heading', { name: 'Córdoba' })).toBeVisible();
  await expect(page.getByText('Itinerario compartido contigo (solo lectura).')).toBeVisible();
  await expect(page.getByTestId('estado-reserva-COR404')).toHaveText('Modificada');
  await expect(page.getByRole('button', { name: /Editar/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Eliminar/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Agregar reserva a este viaje' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publicar en red social' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Compartir itinerario' })).toHaveCount(0);
});

test('consola /analitica (rol analista): ejecuta Map-Reduce, sigue estado y muestra resultados', async ({
  page,
}) => {
  const api = await apiFalsa(page);
  await iniciarSesion(page, analista);

  await expect(page).toHaveURL('/analitica');
  await expect(page.getByRole('heading', { name: 'Analítica' })).toBeVisible();

  // Validación cliente: hasta < desde.
  await page.getByLabel('Desde').fill('2025-12-01');
  await page.getByLabel('Hasta').fill('2025-01-01');
  await page.getByRole('button', { name: 'Ejecutar con Map-Reduce' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'La fecha hasta tiene que ser igual o posterior a desde.',
  );

  // Ejecución Map-Reduce de destinos con 8 procesadores (202 + sondeo hasta terminada).
  await page.getByLabel('Desde').fill('2025-01-01');
  await page.getByLabel('Hasta').fill('2025-12-31');
  await page.getByLabel('Procesadores Map-Reduce (1 a 50)').fill('8');
  await page.getByRole('button', { name: 'Ejecutar con Map-Reduce' }).click();

  await expect(page.getByTestId('badge-estado-ejecucion')).toHaveText('Terminada');
  await expect(page.getByTestId('procesadores-ejecucion')).toHaveText('8');
  await expect(page.getByTestId('duracion-ejecucion')).toContainText('420 ms');

  const resultados = page.getByTestId('resultado-analitica');
  await expect(resultados.getByText('Santiago (SCL)')).toBeVisible();
  await expect(resultados.getByText('1.840')).toBeVisible();
  await expect(resultados.getByText('46%')).toBeVisible();

  const postDestinos = api.a('/api/analitica/consultas/destinos/ejecutar')[0];
  expect(postDestinos?.cuerpo).toEqual({
    desde: '2025-01-01',
    hasta: '2025-12-31',
    limite: 10,
    procesadores: 8,
  });

  // Ejecución Map-Reduce de tasa de cancelación por proveedor.
  await page.getByLabel('Consulta').selectOption('cancelaciones');
  await page.getByLabel('Agrupar por').selectOption('proveedor');
  await page.getByRole('button', { name: 'Ejecutar con Map-Reduce' }).click();

  await expect(page.getByTestId('badge-estado-ejecucion')).toHaveText('Terminada');
  await expect(resultados.getByText('aerolinea-andina')).toBeVisible();
  await expect(resultados.getByText('12%')).toBeVisible();

  // Consulta rápida directa de tendencias (reservas por mes).
  await page.getByLabel('Consulta').selectOption('tendencias');
  await page.getByLabel('Año', { exact: true }).fill('2025');
  await page.getByRole('button', { name: 'Consulta rápida' }).click();

  await expect(resultados.getByText('enero')).toBeVisible();
  await expect(resultados.getByText('diciembre')).toBeVisible();
  expect(api.a('/api/analitica/consultas/tendencias')).toHaveLength(1);
});

test('consola /analitica: ante conflicto 409 sigue la ejecución que ya estaba en curso', async ({
  page,
}) => {
  const idExistente = '77777777-7777-4777-8777-777777777777';
  await apiFalsa(page, {
    analitica: { conflictoConConsultaId: idExistente },
  });
  await iniciarSesion(page, analista);

  await expect(page).toHaveURL('/analitica');
  await page.getByRole('button', { name: 'Ejecutar con Map-Reduce' }).click();

  await expect(page.getByRole('alert')).toHaveText(
    'Ya hay una consulta igual en curso. Se sigue su estado actual.',
  );
  await expect(page.getByTestId('estado-ejecucion')).toContainText(idExistente);
  await expect(page.getByTestId('badge-estado-ejecucion')).toHaveText('Terminada');
  await expect(page.getByTestId('resultado-analitica')).toContainText('Santiago (SCL)');
});
