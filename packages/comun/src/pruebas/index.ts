// Helpers para las pruebas de los servicios: claves y JWT de prueba, Postgres y RabbitMQ en
// contenedores (testcontainers) y un logger que guarda las líneas. Solo para pruebas: se importan
// desde '@trotamundos/comun/pruebas', nunca desde el código del servicio.
import { Writable } from 'node:stream';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JSONWebKeySet } from 'jose';
import { getContainerRuntimeClient } from 'testcontainers';
import type { Region } from '../config.ts';
import { crearLogger, type Logger } from '../logger.ts';

export interface ClavesPrueba {
  privada: CryptoKey;
  /** JWKS público, como lo publica Autenticación en /.well-known/jwks.json */
  jwks: JSONWebKeySet;
  kid: string;
}

/** Par de claves RS256 nuevo, como el de Autenticación. */
export async function generarClaves(kid = 'clave-prueba'): Promise<ClavesPrueba> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publica = await exportJWK(publicKey);
  return {
    privada: privateKey,
    jwks: { keys: [{ ...publica, kid, alg: 'RS256', use: 'sig' }] },
    kid,
  };
}

export interface ClaimsPrueba {
  sub?: string;
  region?: Region | string;
  roles?: string[];
  idioma?: string;
  /** Segundos hasta que vence (negativo: ya vencido). Por defecto 15 min. */
  venceEnSegundos?: number;
}

export const USUARIO_PRUEBA = '6c1e8a2f-4b3d-4e5f-9a0b-1c2d3e4f5a6b';

/** Firma un JWT como los de Autenticación (por defecto: usuario de region-1, 15 min). */
export async function firmarJwt(claves: ClavesPrueba, claims: ClaimsPrueba = {}): Promise<string> {
  const ahora = Math.floor(Date.now() / 1000);
  return new SignJWT({
    region: claims.region ?? 'region-1',
    roles: claims.roles ?? ['usuario'],
    ...(claims.idioma ? { idioma: claims.idioma } : { idioma: 'es' }),
  })
    .setProtectedHeader({ alg: 'RS256', kid: claves.kid })
    .setSubject(claims.sub ?? USUARIO_PRUEBA)
    .setIssuedAt(ahora)
    .setExpirationTime(ahora + (claims.venceEnSegundos ?? 15 * 60))
    .sign(claves.privada);
}

/** Token de servicio de prueba (roles [servicio], 5 min). */
export function firmarTokenServicio(
  claves: ClavesPrueba,
  servicio: string,
  region: Region = 'region-1',
) {
  return firmarJwt(claves, { sub: servicio, roles: ['servicio'], region, venceEnSegundos: 5 * 60 });
}

/** Logger que guarda cada línea como objeto, para revisar qué se logueó. */
export function loggerDePrueba(
  servicio = 'prueba',
  region = 'region-1',
): { logger: Logger; lineas: Record<string, unknown>[] } {
  const lineas: Record<string, unknown>[] = [];
  const destino = new Writable({
    write(trozo: Buffer, _codificacion, listo) {
      for (const linea of trozo.toString('utf8').split('\n')) {
        if (linea.trim()) lineas.push(JSON.parse(linea) as Record<string, unknown>);
      }
      listo();
    },
  });
  return { logger: crearLogger({ servicio, region, nivel: 'debug', destino }), lineas };
}

/** true si hay Docker para levantar contenedores (en CI siempre; en una máquina sin Docker se saltean). */
export async function dockerDisponible(): Promise<boolean> {
  try {
    await getContainerRuntimeClient();
    return true;
  } catch {
    return false;
  }
}

export interface ContenedorPostgres {
  url: string;
  detener(): Promise<void>;
}

/** PostgreSQL 17 (la misma versión que en infra) en un contenedor. */
export async function levantarPostgres(): Promise<ContenedorPostgres> {
  const contenedor = await new PostgreSqlContainer('postgres:17-alpine').start();
  return {
    url: contenedor.getConnectionUri(),
    detener: async () => {
      await contenedor.stop();
    },
  };
}

export interface ContenedorRabbit {
  url: string;
  contenedor: StartedRabbitMQContainer;
  /** Cierra todas las conexiones de los clientes, como si se cayera el broker. */
  cortarConexiones(): Promise<void>;
  detener(): Promise<void>;
}

/** RabbitMQ 4 en un contenedor (con colas quorum, como en infra). */
export async function levantarRabbit(): Promise<ContenedorRabbit> {
  const contenedor = await new RabbitMQContainer('rabbitmq:4-alpine').start();
  return {
    url: contenedor.getAmqpUrl(),
    contenedor,
    async cortarConexiones() {
      await contenedor.exec(['rabbitmqctl', 'close_all_connections', 'prueba de reconexión']);
    },
    detener: async () => {
      await contenedor.stop();
    },
  };
}
