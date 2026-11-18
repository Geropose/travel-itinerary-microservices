// Gmail API v1 contra specs/externos/gmail.md, secciones 1.6 a 4, y semillas.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MessagePart } from '../src/mime.ts';
import { BUZONES_PRUEBA } from '../src/semillas.ts';
import { conectar, gmail, levantar, type Entorno } from './ayuda.ts';

let e: Entorno;
let token: string;
const ANA = 'ana.garcia@gmail.example';

beforeAll(async () => {
  e = await levantar();
  ({ access_token: token } = await conectar(e.url, ANA));
});
afterAll(() => e.cerrar());

const inyectar = (email: string, cuerpo: object) =>
  fetch(`${e.url}/admin/buzones/${email}/correos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  }).then(
    (r) =>
      r.json() as Promise<{
        historyId: string;
        correos: { id: string; tipo: string; reserva?: { numeroReserva: string } }[];
      }>,
  );

const decodificar = (datos = '') => Buffer.from(datos, 'base64url').toString('utf8');

describe('semillas', () => {
  it('hay 20 buzones de prueba, cada uno con 8 correos y 3 reservas con marcado', async () => {
    const buzones = (await (await fetch(`${e.url}/admin/buzones`)).json()) as {
      email: string;
      correos: number;
    }[];
    expect(buzones.map((b) => b.email).sort()).toEqual(BUZONES_PRUEBA.map((b) => b.email).sort());
    expect(new Set(buzones.map((b) => b.email)).size).toBe(20);
    for (const b of buzones) expect(b.correos).toBeGreaterThanOrEqual(8);
    const correos = (await (await fetch(`${e.url}/admin/buzones/${ANA}/correos`)).json()) as {
      tipo: string;
    }[];
    expect(correos.slice(0, 3).map((c) => c.tipo)).toEqual(['vuelo', 'hotel', 'auto']);
  });
});

describe('1.6 users.getProfile', () => {
  it('devuelve emailAddress, messagesTotal, threadsTotal e historyId (string)', async () => {
    const { status, cuerpo } = await gmail(e.url, token, '/profile');
    expect(status).toBe(200);
    expect(cuerpo).toEqual({
      emailAddress: ANA,
      messagesTotal: expect.any(Number) as number,
      threadsTotal: expect.any(Number) as number,
      historyId: expect.stringMatching(/^\d+$/) as string,
    });
  });
});

describe('2. users.messages.list', () => {
  it('cada mensaje trae solo id y threadId, del más nuevo al más viejo', async () => {
    const { status, cuerpo } = await gmail(e.url, token, '/messages');
    expect(status).toBe(200);
    const mensajes = cuerpo.messages as { id: string; threadId: string }[];
    expect(mensajes.length).toBe(cuerpo.resultSizeEstimate);
    for (const m of mensajes) {
      expect(Object.keys(m)).toEqual(['id', 'threadId']);
      expect(m.id).toMatch(/^[0-9a-f]{16}$/);
    }
    const ids = mensajes.map((m) => m.id);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(cuerpo.nextPageToken).toBeUndefined();
  });

  it('pagina con maxResults y pageToken', async () => {
    const primera = await gmail(e.url, token, '/messages?maxResults=3');
    expect((primera.cuerpo.messages as unknown[]).length).toBe(3);
    expect(primera.cuerpo.nextPageToken).toEqual(expect.any(String));
    const segunda = await gmail(
      e.url,
      token,
      `/messages?maxResults=3&pageToken=${String(primera.cuerpo.nextPageToken)}`,
    );
    const ids = (r: typeof primera) => (r.cuerpo.messages as { id: string }[]).map((m) => m.id);
    expect(ids(segunda).some((id) => ids(primera).includes(id))).toBe(false);
  });

  it('filtra con q=after:<segundos> y from:<dirección>; sin resultados omite messages', async () => {
    // Un minuto después del último correo de las semillas.
    e.reloj.ahora += 60_000;
    const ahora = Math.floor(e.reloj.ahora / 1000);
    const vacia = await gmail(e.url, token, `/messages?q=after:${ahora + 60}`);
    expect(vacia.cuerpo).toEqual({ resultSizeEstimate: 0 });

    await inyectar(ANA, { tipo: 'hotel' });
    const nuevos = await gmail(e.url, token, `/messages?q=after:${ahora}`);
    expect(nuevos.cuerpo.resultSizeEstimate).toBe(1);

    const q = encodeURIComponent('from:reservas@hotel-cordillera.example');
    const delHotel = await gmail(e.url, token, `/messages?q=${q}`);
    expect(delHotel.cuerpo.resultSizeEstimate).toBeGreaterThanOrEqual(2);
  });
});

describe('3. users.messages.get con format=full', () => {
  it('reserva con marcado: multipart/alternative, texto y HTML en base64url con JSON-LD', async () => {
    const { correos } = await inyectar(ANA, { tipo: 'vuelo', semilla: 7 });
    const id = correos[0]?.id ?? '';
    const { status, cuerpo } = await gmail(e.url, token, `/messages/${id}?format=full`);
    expect(status).toBe(200);
    expect(cuerpo).toMatchObject({
      id,
      threadId: id,
      labelIds: ['INBOX', 'UNREAD'],
      snippet: expect.any(String) as string,
      historyId: expect.stringMatching(/^\d+$/) as string,
      internalDate: String(e.reloj.ahora),
      sizeEstimate: expect.any(Number) as number,
    });
    const payload = cuerpo.payload as MessagePart;
    expect(payload).toMatchObject({ partId: '', mimeType: 'multipart/alternative', filename: '' });
    expect(payload.body).toEqual({ size: 0 });
    const headers = Object.fromEntries(payload.headers.map((h) => [h.name, h.value]));
    expect(headers.From).toBe('Aerolínea Andina <reservas@aerolinea-andina.example>');
    expect(headers.To).toBe(ANA);
    expect(headers.Subject).toContain(correos[0]?.reserva?.numeroReserva);
    expect(headers.Date).toBe('Sat, 28 Nov 2026 12:01:00 +0000');
    expect(headers['Message-ID']).toMatch(/^<.+@aerolinea-andina\.example>$/);

    const [texto, html] = payload.parts ?? [];
    expect(texto).toMatchObject({ partId: '0', mimeType: 'text/plain' });
    expect(html).toMatchObject({ partId: '1', mimeType: 'text/html' });
    // base64url: sin + ni / ni relleno.
    expect(html?.body.data).toMatch(/^[A-Za-z0-9_-]+$/);
    const decodificado = decodificar(html?.body.data);
    expect(html?.body.size).toBe(Buffer.byteLength(decodificado));
    const jsonLd = /<script type="application\/ld\+json">([\s\S]+?)<\/script>/.exec(decodificado);
    expect(JSON.parse(jsonLd?.[1] ?? '{}')).toMatchObject({
      '@type': 'FlightReservation',
      reservationNumber: correos[0]?.reserva?.numeroReserva,
    });
  });

  it('correo sin marcado: una sola parte text/plain con la plantilla', async () => {
    const { correos } = await inyectar(ANA, { tipo: 'auto-sin-marcado' });
    const { cuerpo } = await gmail(e.url, token, `/messages/${correos[0]?.id ?? ''}`);
    const payload = cuerpo.payload as MessagePart;
    expect(payload.mimeType).toBe('text/plain');
    expect(payload.parts).toBeUndefined();
    expect(decodificar(payload.body.data)).toMatch(/^Rentadora Sur - Confirmación de reserva\n/);
  });

  it('un id que no existe (o de otro buzón): 404 notFound', async () => {
    const ajeno = await inyectar('bruno.diaz@gmail.example', { tipo: 'no-viaje' });
    for (const id of ['0000000000000000', ajeno.correos[0]?.id ?? '']) {
      const { status, cuerpo } = await gmail(e.url, token, `/messages/${id}`);
      expect(status).toBe(404);
      expect(cuerpo).toMatchObject({ error: { code: 404, errors: [{ reason: 'notFound' }] } });
    }
  });
});

describe('4. users.history.list', () => {
  it('lista los messagesAdded desde un historyId, con el historyId actual', async () => {
    const perfil = await gmail(e.url, token, '/profile');
    const inicio = String(perfil.cuerpo.historyId);
    const { correos, historyId } = await inyectar(ANA, { cantidad: 2, semilla: 3 });
    const { status, cuerpo } = await gmail(
      e.url,
      token,
      `/history?startHistoryId=${inicio}&historyTypes=messageAdded&maxResults=100`,
    );
    expect(status).toBe(200);
    expect(cuerpo.historyId).toBe(historyId);
    const historial = cuerpo.history as {
      id: string;
      messages: { id: string }[];
      messagesAdded: { message: { id: string; threadId: string; labelIds: string[] } }[];
    }[];
    expect(historial.map((h) => h.messages[0]?.id)).toEqual(correos.map((c) => c.id));
    expect(historial[0]).toEqual({
      id: String(Number(inicio) + 1),
      messages: [{ id: correos[0]?.id, threadId: correos[0]?.id }],
      messagesAdded: [
        {
          message: { id: correos[0]?.id, threadId: correos[0]?.id, labelIds: ['INBOX', 'UNREAD'] },
        },
      ],
    });
  });

  it('sin cambios omite history; un startHistoryId demasiado viejo da 404', async () => {
    const actual = String((await gmail(e.url, token, '/profile')).cuerpo.historyId);
    expect((await gmail(e.url, token, `/history?startHistoryId=${actual}`)).cuerpo).toEqual({
      historyId: actual,
    });
    expect((await gmail(e.url, token, '/history?startHistoryId=5')).status).toBe(404);
  });
});

describe('administración', () => {
  it('inyecta un correo escrito a mano y un lote mezclado', async () => {
    const manual = await inyectar('nuevo@gmail.example', {
      de: 'Alguien <alguien@correo.example>',
      asunto: 'Hola',
      texto: 'Un correo cualquiera',
    });
    expect(manual.correos).toEqual([{ id: expect.any(String) as string, tipo: 'manual' }]);
    const lote = await inyectar('nuevo@gmail.example', { cantidad: 200, semilla: 1 });
    expect(lote.correos).toHaveLength(200);
    expect(new Set(lote.correos.map((c) => c.tipo)).size).toBe(8);
  });

  it('rechaza un cuerpo inválido con 400', async () => {
    const respuesta = await fetch(`${e.url}/admin/buzones/${ANA}/correos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'tren' }),
    });
    expect(respuesta.status).toBe(400);
  });
});
