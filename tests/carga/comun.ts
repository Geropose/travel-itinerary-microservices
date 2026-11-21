// Utilidades de las mediciones de tests/carga (P4.1), contra el sistema levantado
// (npm run infra:levantar). Reusan las de tests/e2e para registrarse y conectar buzones.
import { execFileSync } from 'node:child_process';
import { CONFIG_E2E, pedirJson, type SesionE2E } from '../e2e/comun.ts';

export * from '../e2e/comun.ts';

export const escribir = (linea = '') => process.stdout.write(`${linea}\n`);

export const esperar = (ms: number) => new Promise((listo) => setTimeout(listo, ms));

/** Lee un argumento `--nombre valor` de la línea de comandos. */
export function argumento(nombre: string, defecto: string): string {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? (process.argv[i + 1] ?? defecto) : defecto;
}

/**
 * Corre una consulta en una base de la región (dentro del contenedor de Postgres, con el usuario
 * admin) y devuelve la primera columna de cada fila. Solo lee: sirve para contar.
 */
export function consultar(proyecto: 'r1' | 'r2', base: string, sql: string): string[] {
  const salida = execFileSync(
    'docker',
    ['exec', `${proyecto}-postgres-1`, 'psql', '-U', 'admin', '-d', base, '-tAc', sql],
    { encoding: 'utf8' },
  );
  return salida.split('\n').filter((l) => l.trim() !== '');
}

/** Vuelve a iniciar sesión (el JWT dura 15 minutos y algunas mediciones tardan más). */
export async function renovarSesion(sesion: SesionE2E): Promise<void> {
  const login = await pedirJson<{ jwt: string }>(
    `${CONFIG_E2E.urlEnrutador}/api/autenticacion/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Region': sesion.region },
      body: JSON.stringify({ email: sesion.email, contrasena: sesion.contrasena }),
    },
  );
  if (login.status !== 200 || !login.datos?.jwt) {
    throw new Error(`No se pudo renovar la sesión: HTTP ${login.status}`);
  }
  sesion.jwt = login.datos.jwt;
}

interface Panel {
  viajes: { viajeId: string; reservas: { numeroReserva: string }[] }[];
}

/** Números de reserva que el usuario ve en su panel (GET /api/viajes/panel). */
export async function numerosEnPanel(sesion: SesionE2E): Promise<Set<string>> {
  let respuesta = await pedirJson<Panel>(`${CONFIG_E2E.urlEnrutador}/api/viajes/panel`, {
    headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
  });
  if (respuesta.status === 401) {
    await renovarSesion(sesion);
    respuesta = await pedirJson<Panel>(`${CONFIG_E2E.urlEnrutador}/api/viajes/panel`, {
      headers: { Authorization: `Bearer ${sesion.jwt}`, 'X-Region': sesion.region },
    });
  }
  if (respuesta.status !== 200) throw new Error(`Panel: HTTP ${respuesta.status}`);
  const numeros = new Set<string>();
  for (const viaje of respuesta.datos?.viajes ?? []) {
    for (const reserva of viaje.reservas) numeros.add(reserva.numeroReserva);
  }
  return numeros;
}
