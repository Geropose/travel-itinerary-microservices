// QA-7 (primeros correos en menos de 5 min) y lote de correos (99 % sin intervención), P4.1.
//
// Iteración 3, Paso 7: "Al conectar una cuenta, el Examinador la revisa con prioridad máxima en el
// primer minuto: los primeros correos se procesan en menos de 2 min."
//
// Cómo mide, de punta a punta y solo con las APIs públicas y las rutas /admin de los mocks:
// 1. Registra un usuario nuevo y activa su whitelist con los tres proveedores de prueba (UC-2).
// 2. Carga en un buzón nuevo del mock (Gmail u Outlook) un lote de correos generados: reservas con
//    y sin JSON-LD, correos que no son de viaje y correos de un remitente fuera de la whitelist.
// 3. Conecta la cuenta por OAuth ("Permitir") y desde ese momento consulta el panel cada segundo.
// 4. Anota cuándo aparece la primera reserva, cuándo están todas y cuántas se detectaron.
//
// Uso: node tests/carga/primeros-correos.ts [--proveedor gmail|outlook] [--cantidad 1000]
//      [--espera-min 7]
import {
  argumento,
  CONFIG_E2E,
  conectarOAuthMock,
  desconectarCuentasCorreo,
  eliminarReservasUsuario,
  escribir,
  esperar,
  idAleatorio,
  numerosEnPanel,
  pedirJson,
  registrarYLogin,
  sistemaDisponible,
} from './comun.ts';
import {
  contarEn,
  duracion,
  porcentaje,
  reservasEsperadas,
  type CorreoInyectado,
} from './calculos.ts';

const proveedor = argumento('proveedor', 'gmail') as 'gmail' | 'outlook';
const cantidad = Number(argumento('cantidad', '1000'));
// Viajes no repite un número de reserva de un proveedor (índice único proveedor + numero_reserva):
// cada corrida usa otra semilla para no chocar con las reservas de una corrida anterior.
const semilla = Number(argumento('semilla', String(Date.now() % 2 ** 31)));
/** QA-7 pide menos de 5 min para los primeros correos de viaje. */
const LIMITE_QA7_MS = 5 * 60_000;
/** Cuánto esperamos a que estén todas: con la cuota de Gmail, un lote grande tarda más de 5 min. */
const ESPERA_MAXIMA_MS = Number(argumento('espera-min', '7')) * 60_000;
const WHITELIST = [
  'reservas@aerolinea-andina.example',
  'reservas@hotel-cordillera.example',
  'reservas@rentadora-sur.example',
];

if (!(await sistemaDisponible())) {
  escribir('El sistema no está levantado: corré npm run infra:levantar.');
  process.exit(1);
}

const urlMock = proveedor === 'gmail' ? CONFIG_E2E.urlMockGmail : CONFIG_E2E.urlMockOutlook;
const dominio = proveedor === 'gmail' ? 'gmail.example' : 'outlook.example';
const buzon = `carga-${idAleatorio()}@${dominio}`;
const sesion = await registrarYLogin({ nombre: `Viajero Carga ${idAleatorio()}` });

try {
  // 1. Whitelist activa con los tres proveedores de prueba.
  const whitelist = await pedirJson(`${CONFIG_E2E.urlEnrutador}/api/usuarios/whitelist`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sesion.jwt}`,
      'X-Region': sesion.region,
    },
    body: JSON.stringify({ filtrosActivos: true, remitentesPermitidos: WHITELIST }),
  });
  if (whitelist.status !== 200) throw new Error(`Whitelist: HTTP ${whitelist.status}`);
  // FiltrosActualizados llega al Servicio de Correo por el broker: le damos unos segundos.
  await esperar(5000);

  // 2. Lote de correos en el buzón, antes de conectarlo (son los "primeros correos").
  const lote = await fetch(`${urlMock}/admin/buzones/${encodeURIComponent(buzon)}/correos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cantidad, semilla, nombre: sesion.nombre }),
  });
  if (lote.status !== 201) throw new Error(`Lote: HTTP ${lote.status} ${await lote.text()}`);
  const { correos } = (await lote.json()) as { correos: CorreoInyectado[] };
  const { esperadas, bloqueadas } = reservasEsperadas(correos);

  // 3. Conectar la cuenta y medir desde el "Permitir".
  const inicio = Date.now();
  await conectarOAuthMock({ proveedor, emailBuzon: buzon, jwt: sesion.jwt, region: sesion.region });
  const conectada = Date.now() - inicio;

  let primera = NaN;
  let todas = NaN;
  let detectadas = 0;
  let filtradas = 0;
  let ultimoAviso = 0;
  while (Date.now() - inicio < ESPERA_MAXIMA_MS) {
    const panel = await numerosEnPanel(sesion);
    detectadas = contarEn(panel, esperadas);
    filtradas = contarEn(panel, bloqueadas);
    if (detectadas > 0 && Number.isNaN(primera)) primera = Date.now() - inicio;
    if (Date.now() - ultimoAviso >= 30_000) {
      ultimoAviso = Date.now();
      escribir(
        `  ${duracion(Date.now() - inicio)}: ${detectadas} de ${esperadas.size} en el panel`,
      );
    }
    if (detectadas === esperadas.size) {
      todas = Date.now() - inicio;
      break;
    }
    await esperar(1000);
  }
  const resultado = {
    proveedor,
    correos: correos.length,
    reservasEsperadas: esperadas.size,
    detectadas,
    porcentajeDetectadas: porcentaje(detectadas, esperadas.size),
    deRemitenteBloqueado: bloqueadas.size,
    bloqueadasQueAparecieron: filtradas,
    conexionOAuthMs: conectada,
    primeraReservaMs: primera,
    todasLasReservasMs: todas,
  };

  escribir(
    `QA-7: primeros correos de una cuenta nueva (${proveedor}, ${correos.length} correos, semilla ${semilla})`,
  );
  escribir(`  Conexión OAuth:              ${duracion(conectada)}`);
  escribir(`  Primera reserva en el panel: ${duracion(primera)}`);
  escribir(`  Todas las reservas:          ${duracion(todas)}`);
  escribir(
    `  Detectadas:                  ${detectadas} de ${esperadas.size} (${resultado.porcentajeDetectadas} %)`,
  );
  escribir(`  De remitente bloqueado:      ${filtradas} de ${bloqueadas.size} aparecieron`);
  escribir(
    `  Primeros correos < 5 min:    ${primera < LIMITE_QA7_MS ? 'sí' : 'no'}; todo el lote < 5 min: ${todas < LIMITE_QA7_MS ? 'sí' : 'no'}; 99 %: ${resultado.porcentajeDetectadas >= 99 ? 'sí' : 'no'}`,
  );
  escribir(JSON.stringify(resultado));
} finally {
  // Con --conservar quedan la cuenta y las reservas, para revisarlas después.
  if (!process.argv.includes('--conservar')) {
    await eliminarReservasUsuario(sesion);
    await desconectarCuentasCorreo(sesion);
  }
}
