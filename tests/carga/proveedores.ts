// QA-6 (99 % de los mensajes de proveedores sin intervención manual), P4.1.
//
// Iteración 3, Paso 7: "Cada adaptador traduce el formato estándar de su proveedor y registra los
// mensajes que no puede traducir. El porcentaje se mide en el prototipo con un lote de mensajes de
// prueba de cada proveedor simulado."
//
// Cómo mide: a cada mock de proveedor le pide una "tormenta" de N cancelaciones (POST /admin/tormenta).
// La aerolínea las avisa por webhook firmado con HMAC; el hotel y la rentadora no avisan y el
// Servicio de Integraciones las encuentra en su consulta periódica (cada 2 min). Después cuenta, en
// la base de Integraciones de la región 1, cuántos mensajes nuevos se tradujeron (cambios_procesados)
// y cuántos quedaron para revisar a mano (no_traducidos), y cuánto tardó en llegar a N.
//
// Uso: node tests/carga/proveedores.ts [--cantidad 1000]
import {
  argumento,
  CONFIG_E2E,
  consultar,
  escribir,
  esperar,
  reiniciarMock,
  sistemaDisponible,
} from './comun.ts';
import { duracion, porcentaje } from './calculos.ts';

const cantidad = Number(argumento('cantidad', '1000'));
/** Consulta periódica de 2 min más el tiempo de traducir el lote: esperamos hasta 6 min. */
const ESPERA_MAXIMA_MS = 6 * 60_000;

const PROVEEDORES = [
  { nombre: 'aerolinea-andina', url: CONFIG_E2E.urlMockAerolinea, via: 'webhook' },
  { nombre: 'hotel-cordillera', url: CONFIG_E2E.urlMockHotel, via: 'consulta' },
  { nombre: 'rentadora-sur', url: CONFIG_E2E.urlMockRentadora, via: 'consulta' },
] as const;

if (!(await sistemaDisponible())) {
  escribir('El sistema no está levantado: corré npm run infra:levantar.');
  process.exit(1);
}

const contar = (tabla: 'cambios_procesados' | 'no_traducidos', proveedor: string) =>
  Number(
    consultar(
      'r1',
      'integraciones',
      `SELECT count(*) FROM ${tabla} WHERE proveedor = '${proveedor}'`,
    )[0] ?? 0,
  );

interface Medicion {
  proveedor: string;
  via: string;
  mensajes: number;
  traducidos: number;
  noTraducidos: number;
  porcentaje: number;
  tiempoMs: number;
}

const mediciones: Medicion[] = [];
for (const proveedor of PROVEEDORES) {
  await reiniciarMock(proveedor.url);
  const traducidosAntes = contar('cambios_procesados', proveedor.nombre);
  const noTraducidosAntes = contar('no_traducidos', proveedor.nombre);

  const inicio = Date.now();
  const tormenta = await fetch(`${proveedor.url}/admin/tormenta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cantidad }),
  });
  if (tormenta.status !== 202) throw new Error(`${proveedor.nombre}: HTTP ${tormenta.status}`);

  let traducidos = 0;
  let noTraducidos = 0;
  let tiempoMs = NaN;
  while (Date.now() - inicio < ESPERA_MAXIMA_MS) {
    traducidos = contar('cambios_procesados', proveedor.nombre) - traducidosAntes;
    noTraducidos = contar('no_traducidos', proveedor.nombre) - noTraducidosAntes;
    if (traducidos + noTraducidos >= cantidad) {
      tiempoMs = Date.now() - inicio;
      break;
    }
    await esperar(2000);
  }
  const medicion = {
    proveedor: proveedor.nombre,
    via: proveedor.via,
    mensajes: cantidad,
    traducidos,
    noTraducidos,
    porcentaje: porcentaje(traducidos, cantidad),
    tiempoMs,
  };
  mediciones.push(medicion);
  escribir(
    `${proveedor.nombre} (${proveedor.via}): ${traducidos} de ${cantidad} traducidos ` +
      `(${medicion.porcentaje} %), ${noTraducidos} para revisar a mano, en ${duracion(tiempoMs)}`,
  );
  await reiniciarMock(proveedor.url);
}

const total = mediciones.reduce((s, m) => s + m.traducidos, 0);
const pedido = cantidad * PROVEEDORES.length;
escribir(
  `QA-6: ${total} de ${pedido} mensajes traducidos sin intervención (${porcentaje(total, pedido)} %); ` +
    `cumple (>= 99 %): ${porcentaje(total, pedido) >= 99 ? 'sí' : 'no'}`,
);
escribir(JSON.stringify(mediciones));
