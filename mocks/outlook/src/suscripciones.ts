// Suscripciones a change notifications de Graph (specs/externos/outlook.md, secciones 4 y 5): alta con
// el handshake de validationToken, renovación, baja y aviso cuando entra un correo.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Logger } from '@trotamundos/comun';
import { crearEnviador } from '@trotamundos/mocks-comun';
import { fechaGraph, type Buzon, type Guardado } from './buzones.ts';

/** Vida máxima para mensajes de Outlook: 10.080 minutos (sección 4.1). */
export const VIDA_MAXIMA_MS = 10_080 * 60_000;
/** Un pedido con menos de 45 minutos se lleva a 45 minutos. */
export const VIDA_MINIMA_MS = 45 * 60_000;
/** Tenant de prueba del mock (en Microsoft, el del directorio del usuario). */
export const TENANT = '84bd8158-6d4d-4958-8b9f-9d6445542f95';

/** Bandeja de entrada o todos los mensajes del usuario: me/... o users/{id}/... */
const RECURSO = /^(me|users\/[^/]+)\/(mailfolders\((['"]?)inbox\3\)\/)?messages$/i;

export interface Suscripcion {
  id: string;
  email: string;
  applicationId: string;
  creatorId: string;
  changeType: string;
  resource: string;
  notificationUrl: string;
  clientState: string | null;
  expiration: number;
}

export interface OpcionesSuscripciones {
  logger: Logger;
  reloj: () => number;
  /** Para las pruebas: espera de los reintentos de los avisos. */
  reintentos?: number;
  esperaMs?: number;
}

export type Resultado<T> = { ok: T } | { status: number; code: string; message: string };

export interface Pedido {
  changeType?: unknown;
  notificationUrl?: unknown;
  resource?: unknown;
  expirationDateTime?: unknown;
  clientState?: unknown;
}

/** Recurso `subscription` de Graph, con el orden de campos del ejemplo de la sección 4.1. */
export const aRecurso = (s: Suscripcion) => ({
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#subscriptions/$entity',
  id: s.id,
  resource: s.resource,
  applicationId: s.applicationId,
  changeType: s.changeType,
  clientState: s.clientState,
  notificationUrl: s.notificationUrl,
  expirationDateTime: fechaGraph(s.expiration),
  creatorId: s.creatorId,
  latestSupportedTlsVersion: 'v1_2',
  notificationContentType: 'application/json',
});

export function crearSuscripciones({ logger, reloj, reintentos, esperaMs }: OpcionesSuscripciones) {
  const suscripciones = new Map<string, Suscripcion>();
  // Graph tiene 3 s para que el Servicio de Correo responda el aviso (sección 5).
  const enviador = crearEnviador({
    logger,
    tiempoMaximoMs: 3000,
    ...(reintentos === undefined ? {} : { reintentos }),
    ...(esperaMs === undefined ? {} : { esperaMs }),
  });
  /** Avisos que esperan salir, por URL: los que entran juntos van en el mismo `value`. */
  const porSalir = new Map<string, object[]>();

  const vigente = (s: Suscripcion) => s.expiration > reloj();

  /** Vencimiento pedido, con los límites de Graph. */
  function vencimiento(valor: unknown): Resultado<number> {
    const ms = typeof valor === 'string' ? Date.parse(valor) : NaN;
    const ahora = reloj();
    if (Number.isNaN(ms) || ms <= ahora) {
      return {
        status: 400,
        code: 'InvalidRequest',
        message: 'expirationDateTime must be a future date.',
      };
    }
    if (ms > ahora + VIDA_MAXIMA_MS) {
      return {
        status: 400,
        code: 'InvalidRequest',
        message: 'Subscription expiration can only be 10080 minutes in the future.',
      };
    }
    return { ok: Math.max(ms, ahora + VIDA_MINIMA_MS) };
  }

  /**
   * Handshake de la sección 4.2: POST a la URL con ?validationToken=, cuerpo vacío en text/plain.
   * Tiene que responder 200, text/plain y el token decodificado, en menos de 10 s.
   */
  async function validarUrl(url: string): Promise<boolean> {
    const token = `Validation: Testing client application reachability for subscription Request-Id: ${randomUUID()}`;
    try {
      const destino = new URL(url);
      destino.searchParams.set('validationToken', token);
      const respuesta = await fetch(destino, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: '',
        signal: AbortSignal.timeout(10_000),
      });
      const cuerpo = await respuesta.text();
      const tipo = respuesta.headers.get('content-type') ?? '';
      return respuesta.status === 200 && tipo.startsWith('text/plain') && cuerpo === token;
    } catch {
      return false;
    }
  }

  async function crear(
    buzon: Buzon,
    applicationId: string,
    pedido: Pedido,
  ): Promise<Resultado<Suscripcion>> {
    const { changeType, notificationUrl, resource, clientState } = pedido;
    const tipos = typeof changeType === 'string' ? changeType.split(',').map((t) => t.trim()) : [];
    if (tipos.length === 0 || !tipos.every((t) => ['created', 'updated', 'deleted'].includes(t))) {
      return { status: 400, code: 'InvalidRequest', message: 'changeType is invalid.' };
    }
    if (typeof resource !== 'string' || !RECURSO.test(resource)) {
      return { status: 400, code: 'InvalidRequest', message: 'The resource is not supported.' };
    }
    if (typeof notificationUrl !== 'string' || !URL.canParse(notificationUrl)) {
      return { status: 400, code: 'InvalidRequest', message: 'notificationUrl is invalid.' };
    }
    if (
      clientState !== undefined &&
      (typeof clientState !== 'string' || clientState.length > 128)
    ) {
      return { status: 400, code: 'InvalidRequest', message: 'clientState is invalid.' };
    }
    const vence = vencimiento(pedido.expirationDateTime);
    if (!('ok' in vence)) return vence;

    const repetida = [...suscripciones.values()].some(
      (s) =>
        vigente(s) &&
        s.email === buzon.email &&
        s.changeType === tipos.join(',') &&
        s.resource.toLowerCase() === resource.toLowerCase(),
    );
    if (repetida) {
      return {
        status: 409,
        code: 'Conflict',
        message: 'A subscription with the same changeType and resource already exists.',
      };
    }
    // Antes de crearla, Graph valida la URL; si falla, no la crea y responde 400.
    if (!(await validarUrl(notificationUrl))) {
      return {
        status: 400,
        code: 'ValidationError',
        message:
          'Subscription validation request failed. Notification endpoint must respond with 200 OK to validation request.',
      };
    }
    const suscripcion: Suscripcion = {
      id: randomUUID(),
      email: buzon.email,
      applicationId,
      creatorId: buzon.id,
      changeType: tipos.join(','),
      resource,
      notificationUrl,
      clientState: clientState ?? null,
      expiration: vence.ok,
    };
    suscripciones.set(suscripcion.id, suscripcion);
    return { ok: suscripcion };
  }

  /** La suscripción, si es de este buzón y de esta aplicación y no venció (si no, 404). */
  function buscar(id: string, buzon: Buzon, applicationId: string) {
    const s = suscripciones.get(id);
    if (!s || !vigente(s) || s.email !== buzon.email || s.applicationId !== applicationId) {
      return undefined;
    }
    return s;
  }

  function renovar(s: Suscripcion, expirationDateTime: unknown): Resultado<Suscripcion> {
    const vence = vencimiento(expirationDateTime);
    if (!('ok' in vence)) return vence;
    s.expiration = vence.ok;
    return { ok: s };
  }

  function salir(url: string) {
    const avisos = porSalir.get(url) ?? [];
    porSalir.delete(url);
    // Como máximo 100 avisos en cada `value`.
    for (let i = 0; i < avisos.length; i += 100) {
      enviador.enviar(url, { value: avisos.slice(i, i + 100) });
    }
  }

  /** Change notification de un correo nuevo para cada suscripción vigente del buzón (sección 5). */
  function avisar(buzon: Buzon, guardado: Guardado) {
    for (const s of suscripciones.values()) {
      if (s.email !== buzon.email || !vigente(s) || !s.changeType.split(',').includes('created')) {
        continue;
      }
      const recurso = `Users/${buzon.id}/Messages/${guardado.id}`;
      const aviso = {
        id: randomBytes(10).toString('base64url'),
        subscriptionId: s.id,
        subscriptionExpirationDateTime: fechaGraph(s.expiration),
        clientState: s.clientState,
        changeType: 'created',
        resource: recurso,
        tenantId: TENANT,
        resourceData: {
          '@odata.type': '#Microsoft.Graph.Message',
          '@odata.id': recurso,
          '@odata.etag': guardado.etag,
          id: guardado.id,
        },
      };
      const lista = porSalir.get(s.notificationUrl);
      if (lista) {
        lista.push(aviso);
      } else {
        porSalir.set(s.notificationUrl, [aviso]);
        enviador.programar(0, () => salir(s.notificationUrl));
      }
    }
  }

  return {
    crear,
    buscar,
    renovar,
    borrar: (id: string) => suscripciones.delete(id),
    avisar,
    vigentes: (email: string) =>
      [...suscripciones.values()].filter((s) => s.email === email && vigente(s)).length,
    detener: () => enviador.detener(),
  };
}

export type Suscripciones = ReturnType<typeof crearSuscripciones>;
