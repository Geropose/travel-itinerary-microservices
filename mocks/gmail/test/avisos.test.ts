// users.watch, avisos push con el formato de Pub/Sub y cuota por usuario, contra
// specs/externos/gmail.md, secciones 5 a 7.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  conectar,
  esperarA,
  gmail,
  levantar,
  receptor,
  TOPICO,
  type Entorno,
  type Receptor,
} from './ayuda.ts';

let e: Entorno;
let r: Receptor;
let token: string;
const ANA = 'ana.garcia@gmail.example';

beforeEach(async () => {
  r = await receptor();
  e = await levantar({
    suscripciones: new Map([[TOPICO, r.url]]),
    avisos: { intervaloMs: 200, esperaMs: 20, reintentos: 2 },
    cuotaPorMinuto: 300,
  });
  ({ access_token: token } = await conectar(e.url, ANA));
});
afterEach(async () => {
  await e.cerrar();
  await r.cerrar();
});

const watch = (
  cuerpo: object = { topicName: TOPICO, labelIds: ['INBOX'], labelFilterBehavior: 'include' },
) =>
  gmail(e.url, token, '/watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

const inyectar = (cuerpo: object) =>
  fetch(`${e.url}/admin/buzones/${ANA}/correos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  }).then((res) => res.json() as Promise<{ historyId: string }>);

const datosDe = (aviso: Record<string, unknown>) => {
  const mensaje = aviso.message as { data: string };
  return JSON.parse(Buffer.from(mensaje.data, 'base64').toString()) as Record<string, string>;
};

describe('5. users.watch', () => {
  it('devuelve historyId y expiration (7 días, en ms) y manda un aviso enseguida', async () => {
    const { status, cuerpo } = await watch();
    expect(status).toBe(200);
    expect(Object.keys(cuerpo)).toEqual(['historyId', 'expiration']);
    expect(cuerpo.expiration).toBe(String(e.reloj.ahora + 7 * 86_400_000));
    await esperarA(() => r.recibidos.length === 1);
    expect(datosDe(r.recibidos[0]?.cuerpo ?? {})).toEqual({
      emailAddress: ANA,
      historyId: cuerpo.historyId,
    });
  });

  it('un topicName inválido: 400', async () => {
    expect((await watch({ topicName: 'gmail-avisos' })).status).toBe(400);
  });
});

describe('6. aviso push', () => {
  it('al entrar un correo manda el formato de Pub/Sub con emailAddress e historyId nuevos', async () => {
    await watch();
    await esperarA(() => r.recibidos.length === 1);
    await new Promise((listo) => setTimeout(listo, 250));
    const { historyId } = await inyectar({ tipo: 'vuelo' });
    await esperarA(() => r.recibidos.length === 2);
    const aviso = r.recibidos[1]?.cuerpo ?? {};
    expect(aviso).toEqual({
      message: {
        data: expect.any(String) as string,
        messageId: expect.stringMatching(/^\d+$/) as string,
        message_id: expect.any(String) as string,
        publishTime: new Date(e.reloj.ahora).toISOString(),
        publish_time: new Date(e.reloj.ahora).toISOString(),
      },
      subscription: 'projects/trotamundos/subscriptions/gmail-avisos-region-1-push',
    });
    const mensaje = aviso.message as { messageId: string; message_id: string };
    expect(mensaje.message_id).toBe(mensaje.messageId);
    // El aviso no trae el correo: solo el buzón y su historyId nuevo.
    expect(datosDe(aviso)).toEqual({ emailAddress: ANA, historyId });
  });

  it('sin watch no hay avisos; con watch vencido tampoco', async () => {
    await inyectar({ tipo: 'hotel' });
    await watch();
    await esperarA(() => r.recibidos.length === 1);
    e.reloj.ahora += 8 * 86_400_000;
    await new Promise((listo) => setTimeout(listo, 250));
    await inyectar({ tipo: 'hotel' });
    await new Promise((listo) => setTimeout(listo, 250));
    expect(r.recibidos).toHaveLength(1);
  });

  it('como máximo un aviso por intervalo por buzón, con el historyId más nuevo', async () => {
    await watch();
    await esperarA(() => r.recibidos.length === 1);
    await inyectar({ tipo: 'vuelo' });
    await inyectar({ tipo: 'hotel' });
    const { historyId } = await inyectar({ tipo: 'auto' });
    await esperarA(() => r.recibidos.length >= 2);
    await new Promise((listo) => setTimeout(listo, 300));
    expect(r.recibidos).toHaveLength(2);
    expect(datosDe(r.recibidos[1]?.cuerpo ?? {}).historyId).toBe(historyId);
    const entre = (r.recibidos[1]?.en ?? 0) - (r.recibidos[0]?.en ?? 0);
    expect(entre).toBeGreaterThanOrEqual(180);
  });

  it('si la URL responde un error, reintenta el mismo aviso', async () => {
    r.fallar.push(503, 500);
    await watch();
    await esperarA(() => r.recibidos.length === 3);
    const ids = r.recibidos.map((a) => (a.cuerpo.message as { messageId: string }).messageId);
    expect(new Set(ids).size).toBe(1);
  });
});

describe('7. límites de uso (QA-7)', () => {
  it('al superar las unidades por minuto responde 429 rateLimitExceeded; al minuto, vuelve', async () => {
    // Cuota de prueba: 300 unidades. history.list cuesta 2 y messages.get con format=full, 60.
    const perfil = await gmail(e.url, token, '/profile');
    const lista = await gmail(e.url, token, '/messages?maxResults=1');
    const id = (lista.cuerpo.messages as { id: string }[])[0]?.id ?? '';
    for (let i = 0; i < 4; i++) {
      expect((await gmail(e.url, token, `/messages/${id}`)).status).toBe(200);
    }
    // 1 + 5 + 240 = 246 unidades: otro format=full (60) se pasa, history.list (2) no.
    const limitada = await gmail(e.url, token, `/messages/${id}`);
    expect(limitada).toEqual({
      status: 429,
      cuerpo: {
        error: {
          errors: [
            {
              domain: 'usageLimits',
              reason: 'rateLimitExceeded',
              message: 'User-rate limit exceeded.',
            },
          ],
          code: 429,
          message: 'User-rate limit exceeded.',
        },
      },
    });
    const historial = `/history?startHistoryId=${String(perfil.cuerpo.historyId)}`;
    expect((await gmail(e.url, token, historial)).status).toBe(200);
    e.reloj.ahora += 60_000;
    expect((await gmail(e.url, token, `/messages/${id}`)).status).toBe(200);
  });

  it('la cuota es por usuario: otro buzón no se ve afectado', async () => {
    for (let i = 0; i < 3; i++) await watch();
    expect((await watch()).status).toBe(429);
    const otro = await conectar(e.url, 'bruno.diaz@gmail.example');
    expect((await gmail(e.url, otro.access_token, '/profile')).status).toBe(200);
  });
});
