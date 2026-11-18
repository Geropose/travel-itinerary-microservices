// Genera los tipos del cliente de API desde los contratos de specs/openapi (spec-driven, CONST-5):
// un archivo por servicio en web/src/api/generado/. Se corre con npm run web:api después de cambiar
// un contrato; la prueba web/test/api-generada.test.ts avisa si quedaron desactualizados.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

/** Servicios con rutas públicas para la web (entran por el enrutador global y el gateway). */
export const SERVICIOS_WEB = [
  'autenticacion',
  'usuarios',
  'correo',
  'viajes',
  'integraciones',
  'analitica',
  'asistente',
] as const;

export const rutaGenerado = (servicio: string) =>
  fileURLToPath(new URL(`../src/api/generado/${servicio}.ts`, import.meta.url));

/** Tipos de un contrato, con un encabezado que dice de dónde salen. */
export async function generar(servicio: string): Promise<string> {
  const contrato = new URL(`../../specs/openapi/${servicio}.yaml`, import.meta.url);
  const tipos = astToString(await openapiTS(contrato));
  return (
    `// Generado con npm run web:api desde specs/openapi/${servicio}.yaml. No editar a mano.\n` +
    tipos
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const servicio of SERVICIOS_WEB) {
    writeFileSync(rutaGenerado(servicio), await generar(servicio));
    process.stdout.write(`web/src/api/generado/${servicio}.ts\n`);
  }
}
