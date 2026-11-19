// CLI para poblar la base global de analítica con N filas anonimizadas realistas (P2.C5, QA-5):
//   node services/analitica/scripts/generar-historico.ts --cantidad=1000000 --desde-anio=2023 --hasta-anio=2025
// Usa URL_BASE_ANALITICA (o URL_BASE / --url) del entorno y aplica migraciones antes de insertar.
import { fileURLToPath } from 'node:url';
import { crearPool, migrar } from '@trotamundos/comun';
import { generarHistoricoAnonimizado } from '../src/generador-historico.ts';

function leerArg(nombre: string): string | undefined {
  const prefijo = `--${nombre}=`;
  const encontrado = process.argv.find((arg) => arg.startsWith(prefijo));
  return encontrado ? encontrado.slice(prefijo.length) : undefined;
}

const url = leerArg('url') ?? process.env.URL_BASE_ANALITICA ?? process.env.URL_BASE ?? '';
if (!url) {
  process.stderr.write(
    'Falta la URL de la base de analítica: definí URL_BASE_ANALITICA o pasá --url=postgres://...\n',
  );
  process.exit(1);
}

const cantidad = Number(leerArg('cantidad') ?? 1_000_000);
const desdeAnio = Number(leerArg('desde-anio') ?? 2023);
const hastaAnio = Number(leerArg('hasta-anio') ?? 2025);
const tamanoLote = Number(leerArg('lote') ?? 100_000);

const pool = crearPool({ url, maximo: 4 });
pool.on('error', () => undefined);

try {
  const dirMigraciones = fileURLToPath(new URL('../migrations/', import.meta.url));
  await migrar(pool, [dirMigraciones]);

  process.stdout.write(
    `Generando ${cantidad.toLocaleString('es-AR')} filas anonimizadas (${desdeAnio}–${hastaAnio})...\n`,
  );

  const resultado = await generarHistoricoAnonimizado(pool, {
    cantidad,
    desdeAnio,
    hastaAnio,
    tamanoLote,
    alCompletarLote: (actual, total) => {
      const pct = Math.round((actual / total) * 100);
      process.stdout.write(
        `  Progreso: ${actual.toLocaleString('es-AR')} / ${total.toLocaleString('es-AR')} (${pct}%)\n`,
      );
    },
  });

  const filasPorSeg =
    resultado.duracionMs > 0
      ? Math.round((resultado.insertadas * 1000) / resultado.duracionMs)
      : resultado.insertadas;
  process.stdout.write(
    `Listo: ${resultado.insertadas.toLocaleString('es-AR')} filas generadas en ${(resultado.duracionMs / 1000).toFixed(2)} s (~${filasPorSeg.toLocaleString('es-AR')} filas/s).\n`,
  );
} finally {
  await pool.end();
}
