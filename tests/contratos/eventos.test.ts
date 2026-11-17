import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Parser, fromFile, DiagnosticSeverity } from '@asyncapi/parser';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import modFormatos from 'ajv-formats';
import { beforeAll, describe, expect, it } from 'vitest';

// Pruebas de contrato de los eventos (docs/CONVENCIONES.md 4.5): los ejemplos válidos cumplen su
// esquema, cada ejemplo inválido falla por el motivo esperado y el AsyncAPI es válido y coincide con
// la tabla de eventos (quién publica y quién consume).

const agregarFormatos = modFormatos.default;

const dirSchemas = fileURLToPath(new URL('../../specs/schemas/', import.meta.url));
const dirEjemplos = fileURLToPath(new URL('../../specs/schemas/ejemplos/', import.meta.url));
const archivoAsyncApi = fileURLToPath(
  new URL('../../specs/asyncapi/eventos.yaml', import.meta.url),
);

type Esquema = Record<string, unknown> & { properties: Record<string, unknown> };

function leerJson<T = unknown>(ruta: string): T {
  return JSON.parse(readFileSync(ruta, 'utf8')) as T;
}

const leerEsquema = (nombre: string) => leerJson<Esquema>(`${dirSchemas}${nombre}.json`);
const leerEjemplo = (nombre: string) => leerJson(`${dirEjemplos}${nombre}.json`);

const EVENTOS = [
  'ReservaDetectada',
  'ReservaActualizada',
  'FiltrosActualizados',
  'ViajeActualizado',
] as const;
type Evento = (typeof EVENTOS)[number];

/** Por qué tiene que fallar cada ejemplo inválido: palabra clave de JSON Schema y ubicación. */
const MOTIVO_INVALIDO: Record<Evento | 'ViajeAnonimizado', { keyword: string; ruta: string }> = {
  // Un vuelo sin origen.
  ReservaDetectada: { keyword: 'required', ruta: '/datos' },
  // En ReservaActualizada el cambio siempre lo origina el proveedor.
  ReservaActualizada: { keyword: 'const', ruta: '/datos/origenCambio' },
  // "hotelesdelsur" no es ni una dirección ni un dominio (@dominio).
  FiltrosActualizados: { keyword: 'pattern', ruta: '/datos/remitentesPermitidos/1' },
  // "archivado" es un origen de cambio, no un estado de la reserva.
  ViajeActualizado: { keyword: 'enum', ruta: '/datos/estado' },
  // La fila anonimizada no puede llevar usuarioId.
  ViajeAnonimizado: { keyword: 'additionalProperties', ruta: '' },
};

/** Publicador y consumidor de cada evento, como en la tabla de docs/CONVENCIONES.md 4.5. */
const TABLA: Record<Evento, { publica: string; consume: string }> = {
  ReservaDetectada: { publica: 'correo', consume: 'viajes' },
  ReservaActualizada: { publica: 'integraciones', consume: 'viajes' },
  FiltrosActualizados: { publica: 'usuarios', consume: 'correo' },
  ViajeActualizado: { publica: 'viajes', consume: 'analitica' },
};

function nuevoAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strictTypes: true, strictTuples: true });
  agregarFormatos(ajv);
  ajv.addSchema(leerEsquema('Sobre'), 'Sobre.json');
  for (const evento of EVENTOS) ajv.addSchema(leerEsquema(evento), `${evento}.json`);
  return ajv;
}

/** Mismo armado que el payload de cada mensaje en eventos.yaml: el sobre más los datos del evento. */
function validadorDeMensaje(ajv: Ajv, evento: Evento): ValidateFunction {
  return ajv.compile({
    allOf: [
      { $ref: 'Sobre.json' },
      {
        type: 'object',
        properties: {
          tipo: { type: 'string', const: evento },
          version: { type: 'integer', const: 1 },
          datos: { $ref: `${evento}.json` },
        },
      },
    ],
  });
}

function errores(validar: ValidateFunction): ErrorObject[] {
  return validar.errors ?? [];
}

describe('contrato de eventos: JSON Schema', () => {
  const ajv = nuevoAjv();

  describe.each(EVENTOS)('%s', (evento) => {
    const validar = validadorDeMensaje(ajv, evento);

    it('acepta el ejemplo válido', () => {
      const valido = validar(leerEjemplo(`${evento}.valido`));
      expect(errores(validar)).toEqual([]);
      expect(valido).toBe(true);
    });

    it('rechaza el ejemplo inválido por el motivo esperado', () => {
      expect(validar(leerEjemplo(`${evento}.invalido`))).toBe(false);
      expect(errores(validar)).toContainEqual(
        expect.objectContaining({
          keyword: MOTIVO_INVALIDO[evento].keyword,
          instancePath: MOTIVO_INVALIDO[evento].ruta,
        }),
      );
    });

    it('rechaza el sobre si el tipo no coincide con el evento', () => {
      const ejemplo = leerEjemplo(`${evento}.valido`) as Record<string, unknown>;
      const otro = EVENTOS.find((e) => e !== evento);
      expect(validar({ ...ejemplo, tipo: otro })).toBe(false);
    });
  });

  it('el sobre rechaza campos de más, regiones desconocidas y fechas sin zona horaria', () => {
    const validarSobre = ajv.getSchema('Sobre.json');
    if (!validarSobre) throw new Error('No se cargó Sobre.json');
    const ejemplo = leerEjemplo('ReservaDetectada.valido') as Record<string, unknown>;
    expect(validarSobre(ejemplo)).toBe(true);
    expect(validarSobre({ ...ejemplo, extra: 1 })).toBe(false);
    expect(validarSobre({ ...ejemplo, region: 'region-3' })).toBe(false);
    expect(validarSobre({ ...ejemplo, ocurridoEn: '2026-11-20T13:45:00' })).toBe(false);
    expect(validarSobre({ ...ejemplo, eventId: 'no-es-un-uuid' })).toBe(false);
  });
});

describe('contrato de la fila anonimizada (ViajeAnonimizado)', () => {
  const ajv = new Ajv({ allErrors: true, strictTypes: true, strictTuples: true });
  agregarFormatos(ajv);
  const esquema = leerEsquema('ViajeAnonimizado');
  const validar = ajv.compile(esquema);

  it('acepta el ejemplo válido', () => {
    const valido = validar(leerEjemplo('ViajeAnonimizado.valido'));
    expect(errores(validar)).toEqual([]);
    expect(valido).toBe(true);
  });

  it('rechaza el ejemplo inválido por el motivo esperado', () => {
    expect(validar(leerEjemplo('ViajeAnonimizado.invalido'))).toBe(false);
    expect(errores(validar)).toContainEqual(
      expect.objectContaining({
        keyword: MOTIVO_INVALIDO.ViajeAnonimizado.keyword,
        instancePath: MOTIVO_INVALIDO.ViajeAnonimizado.ruta,
        params: { additionalProperty: 'usuarioId' },
      }),
    );
  });

  it('no tiene ningún campo que identifique al usuario o a la reserva', () => {
    for (const campo of ['usuarioId', 'viajeId', 'reservaId', 'numeroReserva']) {
      expect(esquema.properties).not.toHaveProperty(campo);
    }
  });

  it('usa los mismos tipos que ViajeActualizado en los campos que comparten', () => {
    const viaje = leerEsquema('ViajeActualizado');
    const sobre = leerEsquema('Sobre');
    const sinDescripcion = (s: unknown) => ({ ...(s as object), description: undefined });
    for (const campo of Object.keys(esquema.properties)) {
      if (campo === 'codigoReserva') continue;
      const original = campo === 'region' ? sobre.properties[campo] : viaje.properties[campo];
      expect(sinDescripcion(esquema.properties[campo]), campo).toEqual(sinDescripcion(original));
    }
  });
});

describe('contrato de eventos: AsyncAPI', () => {
  let salida: Awaited<ReturnType<ReturnType<typeof fromFile>['parse']>>;

  beforeAll(async () => {
    salida = await fromFile(new Parser(), archivoAsyncApi).parse();
  }, 30_000);

  it('es un documento AsyncAPI 3.0 válido', () => {
    const graves = salida.diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error);
    expect(graves.map((d) => `${d.path.join('.')}: ${d.message}`)).toEqual([]);
    expect(salida.document?.version()).toBe('3.0.0');
  });

  it('tiene un canal por evento sobre el exchange trotamundos.eventos', () => {
    const documento = salida.document;
    if (!documento) throw new Error('El AsyncAPI no se pudo leer');
    const canales = documento.channels().all();
    expect(canales.map((c) => c.address()).sort()).toEqual([...EVENTOS].sort());
    for (const canal of canales) {
      const amqp = canal.bindings().get('amqp')?.value() as
        { is: string; exchange: { name: string; type: string } } | undefined;
      expect(amqp?.is).toBe('routingKey');
      expect(amqp?.exchange).toMatchObject({ name: 'trotamundos.eventos', type: 'topic' });
    }
  });

  it.each(EVENTOS)('%s: publica y consume quien dice la tabla de convenciones', (evento) => {
    const documento = salida.document;
    if (!documento) throw new Error('El AsyncAPI no se pudo leer');
    const operaciones = documento
      .operations()
      .all()
      .filter((op) => op.channels().all()[0]?.address() === evento);
    const servicio = (accion: 'send' | 'receive') =>
      operaciones
        .filter((op) => op.action() === accion)
        .map((op) => op.extensions().get('x-servicio')?.value());
    expect(servicio('send')).toEqual([TABLA[evento].publica]);
    expect(servicio('receive')).toEqual([TABLA[evento].consume]);
  });

  it.each(EVENTOS)('%s: el ejemplo del mensaje es el ejemplo válido', (evento) => {
    const documento = salida.document;
    if (!documento) throw new Error('El AsyncAPI no se pudo leer');
    const mensaje = documento.components().messages().get(evento);
    const ejemplos = mensaje
      ?.examples()
      .all()
      .map((e) => e.payload());
    expect(ejemplos).toEqual([leerEjemplo(`${evento}.valido`)]);
  });

  it('declara la fila ViajeAnonimizado sin publicarla en ningún canal', () => {
    const documento = salida.document;
    if (!documento) throw new Error('El AsyncAPI no se pudo leer');
    expect(documento.components().schemas().get('ViajeAnonimizado')).toBeDefined();
    expect(
      documento
        .channels()
        .all()
        .map((c) => c.address()),
    ).not.toContain('ViajeAnonimizado');
  });
});
