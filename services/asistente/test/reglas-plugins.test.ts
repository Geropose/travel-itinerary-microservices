// Pruebas unitarias de P2.D4: reglas YAML es/en con recarga sin reiniciar, detección rápida
// (< 10 ms), extensibilidad ADR-018 (sumar plug-in sin tocar el núcleo) y cada plug-in aislado.
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loggerDePrueba, USUARIO_PRUEBA } from '@trotamundos/comun/pruebas';
import { describe, expect, it, vi } from 'vitest';
import type { ClienteIntegraciones, ClienteUsuarios, ClienteViajes } from '../src/clientes.ts';
import { crearPluginDerivacion } from '../src/plugins/derivacion.ts';
import { crearPluginEstado } from '../src/plugins/estado.ts';
import { crearPluginProblemasMenores } from '../src/plugins/problemas-menores.ts';
import { crearRegistroPlugins } from '../src/plugins/registro.ts';
import { crearPluginReprogramacion } from '../src/plugins/reprogramacion.ts';
import {
  formatearFechaHora,
  type ContextoPlugin,
  type PluginConsulta,
} from '../src/plugins/tipos.ts';
import {
  crearGestorReglas,
  detectarIntencionConReglas,
  DIR_REGLAS_DEFECTO,
} from '../src/reglas.ts';

function contextoBase(
  idioma: 'es' | 'en',
  gestor = crearGestorReglas(),
  token = 'jwt-usuario-1',
): ContextoPlugin {
  return {
    conversacionId: '3b2f8c4e-6a1d-4e7b-9c3f-5d2a1b0e9f87',
    usuarioId: USUARIO_PRUEBA,
    region: 'region-1',
    idioma,
    token,
    reglas: gestor.obtener(idioma),
    historial: [
      {
        mensajeId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
        secuencia: 1,
        autor: 'asistente',
        texto: gestor.obtener(idioma).textos.saludo,
        enviadoEn: '2026-11-20T13:45:00Z',
        resultado: 'respondido',
      },
    ],
  };
}

describe('Reglas externas (config/reglas.{es,en}.yaml) y detección rápida', () => {
  it('detecta las 4 intenciones y desconocida en español e inglés en menos de 10 ms', () => {
    const gestor = crearGestorReglas();
    const es = gestor.obtener('es');
    const en = gestor.obtener('en');

    const inicio = performance.now();
    expect(detectarIntencionConReglas('¿Cuál es el estado de mi vuelo XKQ7PL?', es)).toBe('estado');
    expect(detectarIntencionConReglas('Quiero cambiar mi vuelo XKQ7PL para mañana', es)).toBe(
      'reprogramar',
    );
    expect(detectarIntencionConReglas('¿Cuánto equipaje puedo llevar en mi vuelo?', es)).toBe(
      'problemaMenor',
    );
    expect(detectarIntencionConReglas('¿Cómo comparto mi itinerario?', es)).toBe('problemaMenor');
    expect(detectarIntencionConReglas('Quiero hablar con una persona de mi agencia', es)).toBe(
      'derivar',
    );
    expect(detectarIntencionConReglas('lo del otro día', es)).toBe('desconocida');
    expect(detectarIntencionConReglas('sí, por favor', es, true)).toBe('derivar');

    expect(detectarIntencionConReglas('What is the status of my flight XKQ7PL?', en)).toBe(
      'estado',
    );
    expect(detectarIntencionConReglas('I want to reschedule my flight XKQ7PL', en)).toBe(
      'reprogramar',
    );
    expect(detectarIntencionConReglas('How much baggage can I bring on my flight?', en)).toBe(
      'problemaMenor',
    );
    expect(detectarIntencionConReglas('How do I share my itinerary?', en)).toBe('problemaMenor');
    expect(detectarIntencionConReglas('Please transfer me to a human agent', en)).toBe('derivar');
    expect(detectarIntencionConReglas('something random here', en)).toBe('desconocida');
    expect(detectarIntencionConReglas('yes please', en, true)).toBe('derivar');
    const duracionMs = performance.now() - inicio;

    // Promedio por mensaje muy por debajo de los 10 ms de Iteración 7 (QA-12).
    expect(duracionMs / 14).toBeLessThan(10);
  });

  it('recarga reglas modificadas en disco sin reiniciar y conserva las válidas ante YAML roto', () => {
    const dirTemp = mkdtempSync(join(tmpdir(), 'asistente-reglas-'));
    try {
      // No usamos cpSync recursivo: en Windows con rutas con ñ (como "DiseñodeSoftware") cierra Node.
      for (const archivo of readdirSync(DIR_REGLAS_DEFECTO)) {
        copyFileSync(join(DIR_REGLAS_DEFECTO, archivo), join(dirTemp, archivo));
      }
      const gestor = crearGestorReglas({
        dirReglas: dirTemp,
        logger: loggerDePrueba('asistente').logger,
      });

      expect(gestor.obtener('es').textos.saludo).toContain('Trotamundos');

      // Modificamos el saludo en disco y avanzamos mtime para simular edición en caliente.
      const rutaEs = join(dirTemp, 'reglas.es.yaml');
      const original = readFileSync(rutaEs, 'utf8');
      const editado = original.replace(
        'Hola, soy el asistente de Trotamundos. ¿En qué te ayudo?',
        'Hola recargado sin reiniciar.',
      );
      writeFileSync(rutaEs, editado, 'utf8');
      const futuro = new Date(Date.now() + 5000);
      utimesSync(rutaEs, futuro, futuro);

      expect(gestor.obtener('es').textos.saludo).toBe('Hola recargado sin reiniciar.');

      // Si el archivo se rompe, mantiene la última versión válida sin caer.
      writeFileSync(rutaEs, 'idioma: fr\nintenciones: []\n', 'utf8');
      const futuro2 = new Date(Date.now() + 10_000);
      utimesSync(rutaEs, futuro2, futuro2);
      expect(gestor.obtener('es').textos.saludo).toBe('Hola recargado sin reiniciar.');
    } finally {
      rmSync(dirTemp, { recursive: true, force: true });
    }
  });
});

describe('Plug-ins independientes y registro extensible (ADR-018)', () => {
  it('permite registrar un nuevo plug-in sin modificar el núcleo ni los existentes', async () => {
    const pluginNuevo: PluginConsulta = {
      intencion: 'climaDestino',
      async atender() {
        return { texto: 'Soleado 22 °C en Santiago.', resultado: 'respondido' };
      },
    };
    const registro = crearRegistroPlugins([crearPluginProblemasMenores()]);
    registro.registrar(pluginNuevo);

    expect(registro.obtener('climaDestino')).toBe(pluginNuevo);
    const resp = await registro.obtener('climaDestino')?.atender(contextoBase('es'), 'clima');
    expect(resp?.texto).toContain('22 °C');
  });

  it('plug-in de estado propaga JWT, filtra por código y no ve reservas ajenas', async () => {
    const listarReservas = vi.fn<ClienteViajes['listarReservas']>(async () => [
      {
        reservaId: 'r-1',
        proveedor: 'aerolinea-andina',
        numeroReserva: 'XKQ7PL',
        tipoReserva: 'vuelo',
        estado: 'confirmada',
        inicio: '2026-12-10T08:30:00Z',
        fin: '2026-12-10T10:40:00Z',
        origen: 'EZE',
        destino: 'SCL',
      },
    ]);
    const plugin = crearPluginEstado({ listarReservas });
    const ctx = contextoBase('es', undefined, 'jwt-exclusivo-ana');

    const respOk = await plugin.atender(ctx, '¿Cómo está mi vuelo XKQ7PL?');
    expect(listarReservas).toHaveBeenCalledWith(USUARIO_PRUEBA, 'jwt-exclusivo-ana');
    expect(respOk.resultado).toBe('respondido');
    expect(respOk.reservas).toHaveLength(1);
    expect(respOk.texto).toContain('XKQ7PL');

    // Pedir una reserva que pertenece a otro usuario (Viajes no la devolvió para este JWT).
    const respAjena = await plugin.atender(ctx, 'Estado de mi vuelo ZZZ999');
    expect(respAjena.reservas).toEqual([]);
    expect(respAjena.texto).toContain('ZZZ999');
  });

  it('muestra la hora en la zona horaria del usuario y, si falta o no es válida, en UTC', async () => {
    // Las reservas se guardan en UTC: 11:30 UTC son las 08:30 en Buenos Aires (UTC-3).
    const iso = '2026-12-10T11:30:00Z';
    expect(formatearFechaHora(iso, 'es')).toContain('11:30');
    expect(formatearFechaHora(iso, 'es', 'America/Argentina/Buenos_Aires')).toContain('08:30');
    expect(formatearFechaHora(iso, 'es', 'Zona/Inventada')).toContain('11:30');

    const listarReservas = vi.fn<ClienteViajes['listarReservas']>(async () => [
      {
        reservaId: 'r-1',
        proveedor: 'aerolinea-andina',
        numeroReserva: 'XKQ7PL',
        tipoReserva: 'vuelo',
        estado: 'confirmada',
        inicio: iso,
        fin: '2026-12-10T13:40:00Z',
        origen: 'EZE',
        destino: 'SCL',
      },
    ]);
    const plugin = crearPluginEstado({ listarReservas });
    const ctx = {
      ...contextoBase('es'),
      zonaHoraria: 'America/Argentina/Buenos_Aires',
    };
    const resp = await plugin.atender(ctx, '¿Cómo está mi vuelo XKQ7PL?');
    expect(resp.texto).toContain('08:30');
    expect(resp.texto).not.toContain('11:30');
  });

  it('plug-in de reprogramación solo pide opciones y nunca aplica sin confirmar()', async () => {
    const aplicarReprogramacion = vi.fn<ClienteIntegraciones['aplicarReprogramacion']>();
    const pedirOpcionesReprogramacion = vi.fn<ClienteIntegraciones['pedirOpcionesReprogramacion']>(
      async () => [
        {
          opcionId: 'oco_1',
          venceEn: '2026-12-01T10:00:00Z',
          costo: { monto: '0.00', moneda: 'USD' },
          inicio: '2026-12-10T14:00:00Z',
          fin: '2026-12-10T16:10:00Z',
          origen: 'EZE',
          destino: 'SCL',
          detalle: { numeroVuelo: 'AN 1240' },
        },
      ],
    );
    const plugin = crearPluginReprogramacion({
      viajes: {
        listarReservas: async () => [
          {
            reservaId: 'r-1',
            proveedor: 'aerolinea-andina',
            numeroReserva: 'XKQ7PL',
            tipoReserva: 'vuelo',
            estado: 'confirmada',
            inicio: '2026-12-10T08:30:00Z',
            fin: '2026-12-10T10:40:00Z',
            origen: 'EZE',
            destino: 'SCL',
          },
        ],
      },
      integraciones: {
        pedirOpcionesReprogramacion,
        aplicarReprogramacion,
        crearCasoAgencia: vi.fn(),
      },
    });

    const resp = await plugin.atender(contextoBase('en'), 'Reschedule my flight XKQ7PL');
    expect(resp.resultado).toBe('opciones');
    expect(resp.opciones).toHaveLength(1);
    expect(resp.opciones?.[0]?.opcionId).toBe('oco_1');
    expect(aplicarReprogramacion).not.toHaveBeenCalled();
  });

  it('plug-in de derivación consulta perfil en Usuarios y crea caso en Integraciones', async () => {
    const obtenerPerfil = vi.fn<ClienteUsuarios['obtenerPerfil']>(async () => ({
      usuarioId: USUARIO_PRUEBA,
      email: 'ana@correo.example',
      nombre: 'Ana García',
      agenciaPreferida: 'viajes-del-plata',
    }));
    const crearCasoAgencia = vi.fn<ClienteIntegraciones['crearCasoAgencia']>(async () => ({
      agencia: 'viajes-del-plata',
      numeroCaso: '35436',
      creadoEn: '2026-11-28T09:31:12Z',
    }));

    const plugin = crearPluginDerivacion({
      usuarios: { obtenerPerfil },
      integraciones: {
        pedirOpcionesReprogramacion: vi.fn(),
        aplicarReprogramacion: vi.fn(),
        crearCasoAgencia,
      },
    });

    const resp = await plugin.atender(contextoBase('es', undefined, 'jwt-ana'), 'Quiero un agente');
    expect(obtenerPerfil).toHaveBeenCalledWith('jwt-ana');
    expect(crearCasoAgencia).toHaveBeenCalledWith(
      expect.objectContaining({
        agencia: 'viajes-del-plata',
        usuarioId: USUARIO_PRUEBA,
        contacto: { nombre: 'Ana García', email: 'ana@correo.example' },
      }),
      'jwt-ana',
    );
    expect(resp.resultado).toBe('derivado');
    expect(resp.caso).toEqual({ agencia: 'viajes-del-plata', numeroCaso: '35436' });
  });
});
