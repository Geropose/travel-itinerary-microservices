import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formatos from 'ajv-formats';
import { parse } from 'yaml';
import { CONFIG_E2E, ejecutarNodeEnRegion, pedirHttpE2E } from './comun.ts';

type Json = string | number | boolean | null | Json[] | { [clave: string]: Json };
type Objeto = { [clave: string]: Json };
interface Esquema {
  $ref?: string;
  required?: string[];
  properties?: Record<string, Esquema & { const?: Json }>;
  items?: Esquema;
  oneOf?: Esquema[];
  if?: { properties?: Record<string, { const?: Json }> };
  then?: { required?: string[] };
}
interface Contenido {
  schema?: Esquema;
  example?: Json;
  examples?: Record<string, { value: Json }>;
}
interface Parametro {
  $ref?: string;
  name: string;
  in: string;
  required?: boolean;
}
interface Operacion {
  operationId: string;
  parameters?: Parametro[];
  requestBody?: { required?: boolean; content: Record<string, Contenido> };
  responses: Record<string, { $ref?: string; content?: Record<string, Contenido> }>;
}
interface Contrato {
  paths: Record<string, Record<string, Operacion | Parametro[]>>;
  components: {
    schemas?: Record<string, Esquema>;
    parameters?: Record<string, Parametro>;
    responses?: Operacion['responses'];
  };
}
interface Pedido {
  ruta: string;
  metodo: string;
  headers: Record<string, string>;
  body?: string;
}
interface Respuesta {
  status: number;
  tipo: string;
  body: string;
}
interface Caso {
  ruta: string;
  metodo: string;
  operacion: Operacion;
  parametros: Parametro[];
}
interface OpcionesCaso {
  status: number;
  cuerpo?: Json;
  parametros?: Record<string, string>;
  headers?: Record<string, string>;
  parametrosInvalidos?: Record<string, string>;
  signo?: (cuerpo: string) => Record<string, string>;
  estadoWebhook?: string;
  estadoValido?: string;
  prepararVariante?: (cuerpo: Json) => Json;
  camposAceptadosPendientes?: ReadonlySet<string>;
}

export type ServicioContrato =
  | 'autenticacion'
  | 'gateway'
  | 'monitor'
  | 'usuarios'
  | 'correo'
  | 'viajes'
  | 'analitica'
  | 'asistente'
  | 'integraciones';

const DUENOS: Record<ServicioContrato, 'A' | 'B' | 'C' | 'D'> = {
  autenticacion: 'A',
  gateway: 'A',
  monitor: 'A',
  usuarios: 'B',
  correo: 'B',
  viajes: 'C',
  analitica: 'C',
  asistente: 'D',
  integraciones: 'D',
};

const PUERTOS_INTERNOS: Record<ServicioContrato, number> = {
  gateway: 3000,
  autenticacion: 3001,
  usuarios: 3002,
  correo: 3003,
  viajes: 3004,
  integraciones: 3005,
  analitica: 3006,
  asistente: 3007,
  monitor: 3010,
};

const urlContratos = new URL('../../specs/openapi/', import.meta.url);
const uri = (nombre: string) => `https://trotamundos.example/specs/openapi/${nombre}.yaml`;
const leer = (nombre: string): Contrato =>
  parse(readFileSync(new URL(`${nombre}.yaml`, urlContratos), 'utf8')) as Contrato;
const comun = leer('comun');

async function pedir(servicio: ServicioContrato, pedido: Pedido): Promise<Respuesta> {
  if (pedido.ruta.startsWith('/interna/') || servicio === 'monitor' || servicio === 'gateway') {
    // El gateway bloquea /interna y monitor/gateway se consultan directo en la red regional.
    const puerto = PUERTOS_INTERNOS[servicio];
    const codigo = `
      let entrada = '';
      for await (const parte of process.stdin) entrada += parte;
      const { ruta, metodo, ...init } = JSON.parse(entrada);
      const respuesta = await fetch('http://${servicio}:${puerto}' + ruta, {
        ...init, method: metodo, redirect: 'manual', signal: AbortSignal.timeout(20000),
      });
      console.log(JSON.stringify({
        status: respuesta.status, tipo: respuesta.headers.get('content-type') ?? '',
        body: await respuesta.text(),
      }));
    `;
    return JSON.parse(
      ejecutarNodeEnRegion('region-1', codigo, JSON.stringify(pedido)),
    ) as Respuesta;
  }
  const { ruta, metodo, ...init } = pedido;
  const respuesta = await pedirHttpE2E(`${CONFIG_E2E.urlEnrutador}/api/${servicio}${ruta}`, {
    ...init,
    method: metodo,
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  return {
    status: respuesta.status,
    tipo: respuesta.headers.get('content-type') ?? '',
    body: await respuesta.text(),
  };
}

export function prepararContrato(servicio: ServicioContrato, token: string) {
  const dueno = DUENOS[servicio];
  const contrato = leer(servicio);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  formatos.default(ajv);
  // Los JSON Pointer de OpenAPI usan components/schemas, incluidos los comunes entre documentos.
  ajv.addSchema({ $id: uri('comun'), components: { schemas: comun.components.schemas } });
  ajv.addSchema({ $id: uri(servicio), components: { schemas: contrato.components.schemas } });
  const casos = new Map<string, Caso>();
  const vistos = new Set<string>();
  const diferencias: string[] = [];
  for (const [ruta, item] of Object.entries(contrato.paths)) {
    for (const [metodo, operacion] of Object.entries(item)) {
      if (Array.isArray(operacion) || !operacion.operationId) continue;
      const parametros = [
        ...((item.parameters as Parametro[] | undefined) ?? []),
        ...(operacion.parameters ?? []),
      ];
      casos.set(operacion.operationId, {
        ruta,
        metodo: metodo.toUpperCase(),
        operacion,
        parametros,
      });
    }
  }
  function resolver<T extends { $ref?: string }>(objeto: T, seccion: string): T {
    if (!objeto.$ref) return objeto;
    const [archivo, ref] = objeto.$ref.split('#');
    const nombre = ref?.split('/').at(-1) ?? '';
    const origen = archivo ? comun : contrato;
    const componentes = origen.components as Record<string, Record<string, T> | undefined>;
    const valor = componentes[seccion]?.[nombre];
    if (!valor) throw new Error(`Referencia sin resolver: ${objeto.$ref}`);
    return resolver(valor, seccion);
  }
  function* omitirCampos(
    esquema: Esquema | undefined,
    dato: Json,
    nivel = '',
  ): Generator<[string, Json]> {
    if (!esquema || dato === null || typeof dato !== 'object') return;
    const s = resolver(esquema, 'schemas');
    if (Array.isArray(dato)) {
      // Una variante por campo del elemento del array, no por cada aparición de ese elemento.
      if (dato[0] !== undefined) {
        for (const [campo, nuevo] of omitirCampos(s.items, dato[0], `${nivel}[0]`)) {
          yield [campo, [nuevo, ...dato.slice(1)]];
        }
      }
      return;
    }
    if (s.oneOf) {
      const variante = s.oneOf
        .map((opcion) => resolver(opcion, 'schemas'))
        .find((opcion) => (opcion.required ?? []).every((campo) => campo in dato));
      if (variante) {
        yield* omitirCampos(variante, dato, nivel);
        return;
      }
    }
    const requeridos = [...(s.required ?? [])];
    if (s.if?.properties && s.then?.required) {
      const cumpleCondicion = Object.entries(s.if.properties).every(
        ([k, cond]) => cond.const !== undefined && dato[k] === cond.const,
      );
      if (cumpleCondicion) {
        for (const extra of s.then.required) {
          if (!requeridos.includes(extra)) requeridos.push(extra);
        }
      }
    }
    for (const campo of requeridos) {
      if (!(campo in dato)) throw new Error(`El ejemplo válido no contiene ${nivel}/${campo}`);
      const copia = Object.fromEntries(Object.entries(dato).filter(([clave]) => clave !== campo));
      yield [`${nivel}/${campo}`, copia];
    }
    for (const [campo, hijo] of Object.entries(dato)) {
      for (const [ruta, nuevo] of omitirCampos(s.properties?.[campo], hijo, `${nivel}/${campo}`)) {
        yield [ruta, { ...dato, [campo]: nuevo }];
      }
    }
  }
  function ejemplo(id: string): Json | undefined {
    const contenido = casos.get(id)?.operacion.requestBody?.content['application/json'];
    return structuredClone(
      contenido?.example ?? Object.values(contenido?.examples ?? {})[0]?.value,
    );
  }
  async function probar(id: string, ops: OpcionesCaso): Promise<Json | undefined> {
    const encontrado = casos.get(id);
    if (!encontrado) throw new Error(`Operación sin contrato: ${servicio}/${id}`);
    const caso: Caso = encontrado;
    const parametrosResueltos = caso.parametros.map((p) => resolver(p, 'parameters'));
    vistos.add(id);
    const cabeceras = { Authorization: `Bearer ${token}`, 'X-Region': 'region-1', ...ops.headers };

    async function validar(
      campo: string,
      opciones: {
        cuerpo?: Json;
        status: number;
        headerAusente?: string;
        parametroInvalido?: string;
        queryAusente?: string;
        estado?: string;
        estadoConocido?: string;
      },
    ): Promise<Json | undefined> {
      const cab = new Headers(cabeceras);
      const cuerpo = opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo);
      if (caso.operacion.requestBody?.content['application/json']) {
        cab.set('content-type', 'application/json');
      }
      for (const [k, v] of Object.entries(ops.signo?.(cuerpo ?? '') ?? {})) cab.set(k, v);
      if (opciones.headerAusente) cab.delete(opciones.headerAusente);
      const parametros = { ...ops.parametros };
      if (opciones.parametroInvalido)
        parametros[opciones.parametroInvalido] =
          ops.parametrosInvalidos?.[opciones.parametroInvalido] ?? '!';
      let ruta = caso.ruta.replace(/\{([^}]+)\}/g, (_, nombre: string) =>
        encodeURIComponent(parametros[nombre] ?? ''),
      );
      const query = new URLSearchParams();
      for (const p of parametrosResueltos) {
        if (p.in !== 'query' || p.name === opciones.queryAusente) continue;
        const valor = parametros[p.name];
        if (valor !== undefined) query.set(p.name, valor);
      }
      const queryTexto = query.toString();
      if (queryTexto) ruta += `?${queryTexto}`;

      const contexto = `[${servicio} · dueño ${dueno}] ${caso.metodo} ${caso.ruta} · ${campo}`;
      let respuesta: Respuesta;
      try {
        respuesta = await pedir(servicio, {
          ruta,
          metodo: caso.metodo,
          headers: Object.fromEntries(cab),
          ...(cuerpo !== undefined ? { body: cuerpo } : {}),
        });
      } catch (error) {
        const detalle = error instanceof Error && error.cause ? ` (${String(error.cause)})` : '';
        throw new Error(`${contexto}: ${String(error)}${detalle}`, { cause: error });
      }
      if (respuesta.status !== opciones.status) {
        throw new Error(`${contexto}: HTTP ${respuesta.status}, esperado ${opciones.status}`);
      }
      const declarada = caso.operacion.responses[String(respuesta.status)];
      if (!declarada) throw new Error(`${contexto}: HTTP ${respuesta.status} sin contrato`);
      const esquemaRespuesta = resolver(declarada, 'responses');
      if (!esquemaRespuesta.content) {
        return undefined;
      }
      const tipo = respuesta.tipo.split(';')[0]?.trim() ?? '';
      const schema = esquemaRespuesta.content[tipo]?.schema;
      if (!schema) throw new Error(`${contexto}: Content-Type ${tipo} sin esquema`);
      const origen = declarada.$ref?.startsWith('./comun.yaml#') ? 'comun' : servicio;
      const refSchema = schema.$ref;
      const refResuelto = refSchema?.startsWith('#')
        ? uri(origen) + refSchema
        : refSchema?.startsWith('./comun.yaml#')
          ? uri('comun') + refSchema.slice('./comun.yaml'.length)
          : undefined;
      const validarRespuesta = ajv.compile({
        $id: `${uri(origen)}-${id}-${opciones.status}-${encodeURIComponent(campo)}-${encodeURIComponent(tipo)}`,
        ...schema,
        ...(refResuelto ? { $ref: refResuelto } : {}),
      });
      const valor = JSON.parse(respuesta.body) as Json;
      if (!validarRespuesta(valor)) {
        throw new Error(`${contexto}: ${ajv.errorsText(validarRespuesta.errors)}`);
      }
      const estado = (valor as Objeto | null)?.estado;
      if (opciones.estado && estado !== opciones.estado) {
        const detalle = `${contexto}: estado recibido ${String(estado)}, esperado ${opciones.estado}`;
        if (!opciones.estadoConocido || estado !== opciones.estadoConocido) {
          throw new Error(detalle);
        }
        process.stderr.write(`Diferencia de contrato conocida: ${detalle}\n`);
      }
      return valor;
    }

    const cuerpo = ops.cuerpo ?? ejemplo(id);
    async function ejecutar(campo: string, opciones: Parameters<typeof validar>[1]) {
      try {
        return await validar(campo, opciones);
      } catch (error) {
        diferencias.push(error instanceof Error ? error.message : String(error));
        return undefined;
      }
    }
    const resultado = await ejecutar('ejemplo válido', {
      status: ops.status,
      ...(ops.estadoValido ? { estado: ops.estadoValido } : {}),
      ...(cuerpo !== undefined ? { cuerpo } : {}),
    });
    const schema = caso.operacion.requestBody?.content['application/json']?.schema;
    if (cuerpo !== undefined) {
      for (const [campo, inv] of omitirCampos(schema, cuerpo)) {
        await ejecutar(`falta ${campo}`, {
          cuerpo: ops.prepararVariante?.(inv) ?? inv,
          status: ops.estadoWebhook ? 200 : 400,
          ...(ops.estadoWebhook ? { estado: ops.estadoWebhook } : {}),
          ...(ops.camposAceptadosPendientes?.has(campo) ? { estadoConocido: 'aceptado' } : {}),
        });
      }
    }
    if (caso.operacion.requestBody?.required) {
      await ejecutar('falta el cuerpo', { status: 400 });
    }
    for (const parametro of parametrosResueltos) {
      if (!parametro.required) continue;
      const datos = cuerpo !== undefined ? { cuerpo } : {};
      if (parametro.in === 'path') {
        await ejecutar(`parámetro inválido ${parametro.name}`, {
          ...datos,
          parametroInvalido: parametro.name,
          status: ops.estadoWebhook ? 404 : 400,
        });
      }
      if (parametro.in === 'query') {
        await ejecutar(`falta ${parametro.name}`, {
          ...datos,
          queryAusente: parametro.name,
          status: 400,
        });
      }
      if (parametro.in === 'header') {
        await ejecutar(`falta ${parametro.name}`, {
          ...datos,
          headerAusente: parametro.name,
          status: 401,
        });
      }
    }
    return resultado;
  }
  return {
    probar,
    ejemplo,
    verificar() {
      const pendientes = [...casos.keys()].filter((id) => !vistos.has(id));
      const problemas = [
        ...pendientes.map((id) => `[${servicio} · dueño ${dueno}] Falta probar ${id}`),
        ...diferencias,
      ];
      if (problemas.length) throw new Error(problemas.join('\n'));
    },
  };
}
