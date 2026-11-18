import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { crearRegistroAdaptadores } from '../src/adaptadores/registro.ts';
import type { AdaptadorCorreo } from '../src/adaptadores/tipos.ts';
import {
  derivarClaveState,
  desencriptarTexto,
  encriptarTexto,
  firmarState,
  leerClaveTokens,
  validarClaveTokensBase64,
  verificarState,
} from '../src/cifrado.ts';
import { esquemaConfig, resolverConfigAdaptadores } from '../src/config.ts';

describe('cifrado AES-256-GCM y state OAuth', () => {
  const claveB64 = randomBytes(32).toString('base64');
  const clave = leerClaveTokens(claveB64);
  const claveState = derivarClaveState(clave);

  it('valida la longitud exacta de 32 bytes base64 para CLAVE_TOKENS_CORREO', () => {
    expect(validarClaveTokensBase64(claveB64)).toBe(true);
    expect(validarClaveTokensBase64('cambiar-clave-tokens')).toBe(false);
    expect(validarClaveTokensBase64(randomBytes(16).toString('base64'))).toBe(false);
    expect(() => leerClaveTokens('no-valida')).toThrow();
  });

  it('cifra y descifra tokens con IV único y autenticación AAD', () => {
    const secreto = 'ya29.token-secreto-de-prueba';
    const usuarioId = randomUUID();

    const c1 = encriptarTexto(clave, secreto, usuarioId);
    const c2 = encriptarTexto(clave, secreto, usuarioId);

    expect(c1).not.toBe(c2);
    expect(c1).toMatch(/^v1\./);
    expect(c1).not.toContain(secreto);
    expect(desencriptarTexto(clave, c1, usuarioId)).toBe(secreto);
    expect(desencriptarTexto(clave, c2, usuarioId)).toBe(secreto);

    // Otro usuarioId (AAD distinto) o texto alterado deben fallar la verificación GCM.
    expect(() => desencriptarTexto(clave, c1, randomUUID())).toThrow();
    const alterado = `${c1.slice(0, -2)}AA`;
    expect(() => desencriptarTexto(clave, alterado, usuarioId)).toThrow();
  });

  it('firma y verifica el state OAuth rechazando alteraciones, otra región o vencimiento', () => {
    const ahora = 1_700_000_000_000;
    const datos = {
      nonce: randomUUID(),
      usuarioId: randomUUID(),
      region: 'region-1' as const,
      proveedor: 'gmail',
      venceEn: ahora + 600_000,
    };

    const state = firmarState(claveState, datos);
    expect(verificarState(claveState, state, 'region-1', ahora + 1000)).toEqual(datos);
    expect(verificarState(claveState, state, 'region-2', ahora + 1000)).toBeNull();
    expect(verificarState(claveState, state, 'region-1', ahora + 600_001)).toBeNull();
    expect(verificarState(claveState, `${state}x`, 'region-1', ahora)).toBeNull();
  });
});

describe('configuración y extensibilidad de adaptadores', () => {
  it('aplica valores por defecto y resuelve URLs públicas y de región', () => {
    const clave = randomBytes(32).toString('base64');
    const config = esquemaConfig.parse({
      REGION: 'region-2',
      PUERTO: '3003',
      URL_BASE: 'postgres://correo:clave@postgres:5432/correo',
      URL_BROKER: 'amqp://trotamundos:clave@rabbitmq:5672',
      URL_JWKS: 'http://autenticacion:3001/.well-known/jwks.json',
      CLAVE_TOKENS_CORREO: clave,
    });
    const resuelta = resolverConfigAdaptadores(config);
    expect(resuelta.urlCallbackOAuth).toBe(
      'http://localhost:8000/region-2/api/correo/oauth/callback',
    );
    expect(resuelta.gmail.urlApi).toBe('http://mock-gmail:4001');
    expect(resuelta.gmail.urlPublica).toBe('http://localhost:4001');
    expect(resuelta.gmail.topicoWatch).toBe('projects/trotamundos/topics/gmail-avisos-region-2');
    expect(resuelta.outlook.urlApi).toBe('http://mock-outlook:4002');
    expect(resuelta.outlook.urlPublica).toBe('http://localhost:4002');
    expect(resuelta.outlook.urlAvisos).toBe(
      'http://enrutador:8000/region-2/api/correo/notificaciones/outlook',
    );
  });

  it('permite agregar un adaptador nuevo sin modificar los existentes (ADR-003)', () => {
    const falsoYahoo: AdaptadorCorreo = {
      proveedor: 'yahoo',
      urlAutorizacion: (s) => `https://yahoo.example/auth?state=${s}`,
      canjearCodigo: async () => ({
        credenciales: {
          accessToken: 'a',
          refreshToken: 'r',
          expiraEn: new Date(),
          scope: 'mail-r',
        },
        perfil: { email: 'u@yahoo.example' },
      }),
      renovarToken: async () => ({
        accessToken: 'a2',
        expiraEn: new Date(),
        scope: 'mail-r',
      }),
      listarNuevos: async () => ({ mensajes: [] }),
      leerMensaje: async () => ({
        id: '1',
        remitente: 'x@example.com',
        asunto: 's',
        recibidoEn: new Date(),
      }),
      suscribirAvisos: async () => null,
    };

    const registro = crearRegistroAdaptadores([falsoYahoo]);
    expect(registro.obtener('yahoo')).toBe(falsoYahoo);
    expect(registro.obtener('gmail')).toBeUndefined();
    expect(registro.listar()).toHaveLength(1);
  });

  it('esquemaConfig rechaza un placeholder inseguro en CLAVE_TOKENS_CORREO', () => {
    expect(() =>
      esquemaConfig.parse({
        REGION: 'region-1',
        PUERTO: '3003',
        URL_BASE: 'postgres://correo:clave@postgres:5432/correo',
        URL_BROKER: 'amqp://trotamundos:clave@rabbitmq:5672',
        URL_JWKS: 'http://autenticacion:3001/.well-known/jwks.json',
        CLAVE_TOKENS_CORREO: 'cambiar-clave-tokens-correo',
      }),
    ).toThrow();
  });
});
