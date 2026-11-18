import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  entornoRegion,
  generarSecretos,
  generarValor,
  leerEnv,
  leerOpciones,
  pasosBajar,
  pasosLevantar,
} from './entorno.ts';

const ejemplo = readFileSync(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8');

describe('secretos de desarrollo', () => {
  it('reemplaza cada valor "cambiar-..." y deja igual el resto', () => {
    const { texto, generadas } = generarSecretos(ejemplo);
    const env = leerEnv(texto);
    expect(Object.keys(env)).toEqual(Object.keys(leerEnv(ejemplo)));
    expect(Object.values(env).some((v) => v.startsWith('cambiar-'))).toBe(false);
    expect(env.NIVEL_LOG).toBe('info');
    expect(env.PUERTO_NGINX_REGION_1).toBe('8081');
    expect(generadas).toContain('SECRETO_ANALITICA');
    // Los comentarios quedan.
    expect(texto).toContain('# Clave AES-256');
  });

  it('genera una clave RSA del JWT por región, AES de 32 bytes y contraseñas distintas', () => {
    const env = leerEnv(generarSecretos(ejemplo).texto);
    for (const region of ['REGION_1', 'REGION_2']) {
      const pem = Buffer.from(env[`JWT_CLAVE_PRIVADA_${region}`] ?? '', 'base64').toString();
      expect(createPrivateKey(pem).asymmetricKeyType).toBe('rsa');
    }
    expect(env.JWT_CLAVE_PRIVADA_REGION_1).not.toBe(env.JWT_CLAVE_PRIVADA_REGION_2);
    expect(Buffer.from(env.CLAVE_TOKENS_CORREO ?? '', 'base64')).toHaveLength(32);
    // Las contraseñas van en URLs (postgres://usuario:clave@...): solo hexadecimal.
    expect(env.CLAVE_BD_USUARIOS).toMatch(/^[0-9a-f]{48}$/);
    expect(env.CLAVE_BD_USUARIOS).not.toBe(env.CLAVE_BD_VIAJES);
  });

  it('no cambia las variables que ya están en el .env (solo completa las nuevas)', () => {
    const { texto, generadas } = generarSecretos(ejemplo, { CLAVE_BD_USUARIOS: 'la-de-antes' });
    expect(leerEnv(texto).CLAVE_BD_USUARIOS).toBe('la-de-antes');
    expect(generadas).not.toContain('CLAVE_BD_USUARIOS');
  });

  it('generarValor usa el formato que corresponde al nombre', () => {
    expect(generarValor('SECRETO_X')).toMatch(/^[0-9a-f]{48}$/);
    expect(generarValor('JWT_CLAVE_PRIVADA_REGION_1')).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('leerEnv ignora comentarios, líneas vacías y fin de línea de Windows', () => {
    expect(leerEnv('# comentario\r\nA=1\r\n\r\nB=x=y\r\n')).toEqual({ A: '1', B: 'x=y' });
  });
});

describe('opciones de los scripts', () => {
  it('por defecto las dos regiones; --solo una; --ha y el resto pasan a compose', () => {
    expect(leerOpciones([])).toEqual({ regiones: ['r1', 'r2'], solo: false, ha: false, resto: [] });
    expect(leerOpciones(['--solo', 'r2', '--ha', '--scale', 'gateway=3'])).toEqual({
      regiones: ['r2'],
      solo: true,
      ha: true,
      resto: ['--scale', 'gateway=3'],
    });
    expect(() => leerOpciones(['--solo', 'r3'])).toThrow(/r1 o r2/);
  });

  it('cada región recibe su REGION, su puerto de nginx y su clave del JWT', () => {
    const env = { PUERTO_NGINX_REGION_2: '8082', JWT_CLAVE_PRIVADA_REGION_2: 'clave-2' };
    expect(entornoRegion('r2', { ...env, PUERTO_NGINX_REGION_1: '8081' })).toEqual({
      REGION: 'region-2',
      OTRA_REGION: 'region-1',
      PUERTO_NGINX: '8082',
      PUERTO_NGINX_OTRA_REGION: '8081',
      JWT_CLAVE_PRIVADA: 'clave-2',
    });
  });
});

describe('pasos de docker compose', () => {
  const env = leerEnv(ejemplo);

  it('levantar: global, las imágenes una sola vez y cada región sana y con sus semillas', () => {
    const pasos = pasosLevantar(leerOpciones(['--ha']), env);
    const semillas = [
      'exec',
      '-T',
      'autenticacion',
      'node',
      'services/autenticacion/src/semillas.ts',
    ];
    expect(pasos.map((p) => p.args.slice(0, 3).concat(p.args.slice(7)))).toEqual([
      ['compose', '-p', 'global', 'up', '-d', '--wait'],
      ['compose', '-p', 'r1', 'build'],
      ['compose', '-p', 'r1', '--profile', 'ha', 'up', '-d', '--wait', '--wait-timeout', '300'],
      ['compose', '-p', 'r1', ...semillas],
      ['compose', '-p', 'r2', '--profile', 'ha', 'up', '-d', '--wait', '--wait-timeout', '300'],
      ['compose', '-p', 'r2', ...semillas],
    ]);
    expect(pasos[4]?.entorno.REGION).toBe('region-2');
  });

  it('una región que ya se levantó con --ha sigue con el perfil ha', () => {
    const pasos = pasosLevantar(leerOpciones([]), env, ['r2']);
    expect(pasos[2]?.args).not.toContain('--profile');
    expect(pasos[4]?.args).toEqual(expect.arrayContaining(['--profile', 'ha']));
  });

  it('bajar con --solo no toca lo global; reset borra los volúmenes', () => {
    const solo = pasosBajar(leerOpciones(['--solo', 'r1']), env, false);
    expect(solo).toHaveLength(1);
    expect(solo[0]?.args).toContain('down');
    expect(solo[0]?.args).not.toContain('--volumes');
    const reset = pasosBajar(leerOpciones([]), env, true);
    expect(reset.map((p) => p.args[2])).toEqual(['r1', 'r2', 'global']);
    expect(reset.every((p) => p.args.includes('--volumes'))).toBe(true);
  });
});
