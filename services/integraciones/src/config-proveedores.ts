import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

/** Ruta por defecto al catálogo declarativo de proveedores externos. */
export const RUTA_CONFIG_PROVEEDORES_DEFECTO = fileURLToPath(
  new URL('../config/proveedores.yaml', import.meta.url),
);

const IDENTIFICADOR = /^[a-z0-9-]+$/;

const esquemaEntradaProveedor = z
  .object({
    nombre: z.string().regex(IDENTIFICADOR, 'Debe ser minúsculas, números o guiones'),
    tipo: z.string().min(1),
    modo: z.enum(['aviso', 'consulta']),
    urlEnv: z.string().min(1).optional(),
    urlPorDefecto: z.url().optional(),
    url: z.url().optional(),
    claveApiEnv: z.string().min(1).optional(),
    claveApiPorDefecto: z.string().min(1).optional(),
    secretoWebhookEnv: z.string().min(1).optional(),
    secretoWebhookPorDefecto: z.string().min(1).optional(),
    intervaloConsultaSegEnv: z.string().min(1).optional(),
    intervaloConsultaSeg: z.number().positive().optional(),
  })
  .refine((p) => Boolean(p.url || p.urlEnv || p.urlPorDefecto), {
    message: 'Debe definir url, urlEnv o urlPorDefecto',
  });

const esquemaEntradaAgencia = z
  .object({
    nombre: z.string().regex(IDENTIFICADOR, 'Debe ser minúsculas, números o guiones'),
    tipo: z.string().min(1).default('agencia'),
    urlEnv: z.string().min(1).optional(),
    urlPorDefecto: z.url().optional(),
    url: z.url().optional(),
    claveApiEnv: z.string().min(1).optional(),
    claveApiPorDefecto: z.string().min(1).optional(),
  })
  .refine((a) => Boolean(a.url || a.urlEnv || a.urlPorDefecto), {
    message: 'Debe definir url, urlEnv o urlPorDefecto',
  });

const esquemaEntradaRed = z
  .object({
    nombre: z.string().regex(IDENTIFICADOR, 'Debe ser minúsculas, números o guiones'),
    tipo: z.string().min(1).default('redsocial'),
    urlEnv: z.string().min(1).optional(),
    urlPorDefecto: z.url().optional(),
    url: z.url().optional(),
    tokenEnv: z.string().min(1).optional(),
    tokenPorDefecto: z.string().min(1).optional(),
  })
  .refine((r) => Boolean(r.url || r.urlEnv || r.urlPorDefecto), {
    message: 'Debe definir url, urlEnv o urlPorDefecto',
  });

const esquemaArchivoProveedores = z.object({
  proveedores: z.array(esquemaEntradaProveedor).default([]),
  agencias: z.array(esquemaEntradaAgencia).default([]),
  redes: z.array(esquemaEntradaRed).default([]),
});

export interface ConfigProveedorResuelta {
  nombre: string;
  tipo: string;
  modo: 'aviso' | 'consulta';
  url: string;
  claveApi: string;
  secretoWebhook?: string;
  intervaloConsultaMs: number;
}

export interface ConfigAgenciaResuelta {
  nombre: string;
  tipo: string;
  url: string;
  claveApi: string;
}

export interface ConfigRedResuelta {
  nombre: string;
  tipo: string;
  url: string;
  token: string;
}

export interface ConfigIntegracionesResuelta {
  proveedores: ConfigProveedorResuelta[];
  agencias: ConfigAgenciaResuelta[];
  redes: ConfigRedResuelta[];
}

export interface OpcionesCargaProveedores {
  ruta?: string;
  /** Variables de entorno para resolver URLs, credenciales e intervalos. */
  env?: Record<string, string | number | undefined>;
  /** Intervalo global de consulta en segundos si el proveedor no sobrescribe uno por entorno. */
  intervaloGlobalSeg?: number;
}

function leerCadena(
  env: Record<string, string | number | undefined>,
  clave: string | undefined,
): string | undefined {
  if (!clave) return undefined;
  const valor = env[clave];
  if (valor === undefined) return undefined;
  const texto = String(valor).trim();
  return texto.length > 0 ? texto : undefined;
}

function leerNumeroPositivo(
  env: Record<string, string | number | undefined>,
  clave: string | undefined,
): number | undefined {
  const texto = leerCadena(env, clave);
  if (!texto) return undefined;
  const numero = Number(texto);
  if (!Number.isFinite(numero) || numero <= 0) {
    throw new Error(`La variable ${clave} debe ser un número positivo (llegó "${texto}").`);
  }
  return numero;
}

function verificarNombresUnicos(tipo: string, nombres: string[]): void {
  const vistos = new Set<string>();
  for (const nombre of nombres) {
    if (vistos.has(nombre)) {
      throw new Error(`Nombre duplicado en config/proveedores.yaml (${tipo}): "${nombre}".`);
    }
    vistos.add(nombre);
  }
}

/**
 * Parsea un documento YAML de proveedores y resuelve sus URLs, credenciales e intervalos desde el
 * entorno. Así los secretos nunca quedan escritos en el YAML y sumar un proveedor no requiere
 * modificar código existente (ADR-003, QA-10).
 */
export function parsearConfigProveedores(
  contenidoYaml: string,
  opciones: Omit<OpcionesCargaProveedores, 'ruta'> = {},
): ConfigIntegracionesResuelta {
  const env = opciones.env ?? process.env;
  const bruto: unknown = parse(contenidoYaml);
  const parsed = esquemaArchivoProveedores.parse(bruto);

  verificarNombresUnicos(
    'proveedores',
    parsed.proveedores.map((p) => p.nombre),
  );
  verificarNombresUnicos(
    'agencias',
    parsed.agencias.map((a) => a.nombre),
  );
  verificarNombresUnicos(
    'redes',
    parsed.redes.map((r) => r.nombre),
  );

  const intervaloGlobalEnv = leerNumeroPositivo(env, 'INTERVALO_CONSULTA_PROVEEDORES_SEG');
  const intervaloBaseSeg = opciones.intervaloGlobalSeg ?? intervaloGlobalEnv ?? 120;

  const proveedores: ConfigProveedorResuelta[] = parsed.proveedores.map((p) => {
    const url = leerCadena(env, p.urlEnv) ?? p.url ?? p.urlPorDefecto;
    if (!url) {
      throw new Error(
        `Falta URL para el proveedor "${p.nombre}" (variable ${p.urlEnv ?? 'sin definir'}).`,
      );
    }
    // Validar formato de URL también cuando viene por entorno.
    z.url().parse(url);

    const claveApi = leerCadena(env, p.claveApiEnv) ?? p.claveApiPorDefecto ?? '';
    const secretoWebhook = leerCadena(env, p.secretoWebhookEnv) ?? p.secretoWebhookPorDefecto;
    if (p.modo === 'aviso' && !secretoWebhook) {
      throw new Error(
        `El proveedor "${p.nombre}" usa modo aviso pero falta su secreto de webhook (${p.secretoWebhookEnv ?? 'secretoWebhookEnv'}).`,
      );
    }

    const intervaloEnv = leerNumeroPositivo(env, p.intervaloConsultaSegEnv);
    const intervaloSeg =
      intervaloEnv ??
      (opciones.intervaloGlobalSeg !== undefined || intervaloGlobalEnv !== undefined
        ? intervaloBaseSeg
        : (p.intervaloConsultaSeg ?? intervaloBaseSeg));

    return {
      nombre: p.nombre,
      tipo: p.tipo,
      modo: p.modo,
      url: url.replace(/\/+$/, ''),
      claveApi,
      ...(secretoWebhook ? { secretoWebhook } : {}),
      intervaloConsultaMs: Math.round(intervaloSeg * 1000),
    };
  });

  const agencias: ConfigAgenciaResuelta[] = parsed.agencias.map((a) => {
    const url = leerCadena(env, a.urlEnv) ?? a.url ?? a.urlPorDefecto;
    if (!url) {
      throw new Error(`Falta URL para la agencia "${a.nombre}".`);
    }
    z.url().parse(url);
    return {
      nombre: a.nombre,
      tipo: a.tipo,
      url: url.replace(/\/+$/, ''),
      claveApi: leerCadena(env, a.claveApiEnv) ?? a.claveApiPorDefecto ?? '',
    };
  });

  const redes: ConfigRedResuelta[] = parsed.redes.map((r) => {
    const url = leerCadena(env, r.urlEnv) ?? r.url ?? r.urlPorDefecto;
    if (!url) {
      throw new Error(`Falta URL para la red "${r.nombre}".`);
    }
    z.url().parse(url);
    return {
      nombre: r.nombre,
      tipo: r.tipo,
      url: url.replace(/\/+$/, ''),
      token: leerCadena(env, r.tokenEnv) ?? r.tokenPorDefecto ?? '',
    };
  });

  return { proveedores, agencias, redes };
}

/** Carga y valida el catálogo de proveedores desde disco (por defecto config/proveedores.yaml). */
export function cargarConfigProveedores(
  opciones: OpcionesCargaProveedores = {},
): ConfigIntegracionesResuelta {
  const ruta = opciones.ruta ?? RUTA_CONFIG_PROVEEDORES_DEFECTO;
  const contenido = readFileSync(ruta, 'utf8');
  return parsearConfigProveedores(contenido, opciones);
}
