import { ErrorHttp } from '@trotamundos/comun';
import { loggerDePrueba } from '@trotamundos/comun/pruebas';
import { describe, expect, it } from 'vitest';
import { crearViajes } from '../src/clientes.ts';
import { esquemaConfig, parsearAgencias } from '../src/config.ts';
import { normalizarEmail } from '../src/repositorio.ts';

describe('config de usuarios', () => {
  it('valida las variables obligatorias y aplica valores por defecto', () => {
    const config = esquemaConfig.parse({
      REGION: 'region-1',
      PUERTO: '3002',
      URL_BASE: 'postgres://usuarios:clave@postgres:5432/usuarios',
      URL_BROKER: 'amqp://trotamundos:clave@rabbitmq:5672',
      URL_JWKS: 'http://autenticacion:3001/.well-known/jwks.json',
    });
    expect(config.URL_VIAJES).toBe('http://viajes:3004');
    expect(config.AGENCIAS_CONFIGURADAS).toBe('viajes-del-plata');
  });

  it('parsearAgencias separa por coma, recorta espacios e ignora vacíos', () => {
    const agencias = parsearAgencias(' viajes-del-plata , , turismo-sur, ');
    expect([...agencias]).toEqual(['viajes-del-plata', 'turismo-sur']);
  });
});

describe('normalizarEmail', () => {
  it('convierte a minúsculas y recorta espacios', () => {
    expect(normalizarEmail('  Ana@Correo.Example  ')).toBe('ana@correo.example');
  });
});

describe('cliente de viajes (esDueno)', () => {
  const { logger } = loggerDePrueba('usuarios');
  const viajeId = '9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e';

  it('propaga el JWT y devuelve true o false según responda Viajes', async () => {
    const recibidos: { url: string; auth: string | null }[] = [];
    const viajes = crearViajes({
      urlViajes: 'http://viajes:3004',
      logger,
      fetch: async (input, init) => {
        const auth = new Headers(init?.headers).get('authorization');
        recibidos.push({ url: String(input), auth });
        return new Response(JSON.stringify({ viajeId, esDueno: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(await viajes.esDueno(viajeId, 'jwt-usuario')).toBe(true);
    expect(recibidos).toEqual([
      {
        url: `http://viajes:3004/interna/viajes/${viajeId}/dueno`,
        auth: 'Bearer jwt-usuario',
      },
    ]);
  });

  it('traduce 404 de Viajes a ErrorHttp 404', async () => {
    const viajes = crearViajes({
      urlViajes: 'http://viajes:3004',
      logger,
      fetch: async () =>
        new Response(JSON.stringify({ status: 404, title: 'No encontrado' }), {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        }),
    });

    await expect(viajes.esDueno(viajeId, 'jwt')).rejects.toMatchObject({ status: 404 });
  });

  it('traduce fallas o demoras de Viajes a ErrorHttp 503', async () => {
    const viajes = crearViajes({
      urlViajes: 'http://viajes:3004',
      logger,
      fetch: async () => {
        throw new Error('conexión rechazada');
      },
    });

    const promesa = viajes.esDueno(viajeId, 'jwt');
    await expect(promesa).rejects.toBeInstanceOf(ErrorHttp);
    await expect(promesa).rejects.toMatchObject({ status: 503 });
  });
});
