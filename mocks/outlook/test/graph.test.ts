// Microsoft Graph contra specs/externos/outlook.md, secciones 1.6, 2, 3 y 6, y semillas.
import { buzonesDePrueba } from '@trotamundos/mocks-comun';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conectar, graph, levantar, type Entorno } from './ayuda.ts';

let e: Entorno;
let token: string;
const ANA = 'ana.garcia@outlook.example';
const SELECT = 'id,receivedDateTime,from,subject,body,internetMessageId';

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
    (r) => r.json() as Promise<{ correos: { id: string; reserva?: { numeroReserva: string } }[] }>,
  );

type Mensaje = {
  id: string;
  receivedDateTime: string;
  subject: string;
  from: { emailAddress: { name: string; address: string } };
  body: { contentType: string; content: string };
};

describe('semillas', () => {
  it('20 buzones de prueba, los últimos 5 son cuentas personales', async () => {
    const buzones = (await (await fetch(`${e.url}/admin/buzones`)).json()) as {
      email: string;
      personal: boolean;
      correos: number;
    }[];
    const esperados = buzonesDePrueba('outlook.example').map((b) => b.email);
    expect(buzones.map((b) => b.email)).toEqual(esperados);
    expect(buzones.filter((b) => b.personal).map((b) => b.email)).toEqual(esperados.slice(-5));
    for (const b of buzones) expect(b.correos).toBe(8);
  });
});

describe('1.6 GET /v1.0/me', () => {
  it('con $select devuelve id, mail y userPrincipalName', async () => {
    const { status, cuerpo } = await graph(e.url, token, '/me?$select=id,mail,userPrincipalName');
    expect(status).toBe(200);
    expect(cuerpo).toEqual({
      '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users/$entity',
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
      ) as string,
      mail: ANA,
      userPrincipalName: ANA,
    });
  });

  it('en una cuenta personal mail viene en null y se usa userPrincipalName', async () => {
    const personal = await conectar(e.url, 'valentina.rojas@outlook.example');
    const { cuerpo } = await graph(
      e.url,
      personal.access_token,
      '/me?$select=id,mail,userPrincipalName',
    );
    expect(cuerpo.mail).toBeNull();
    expect(cuerpo.userPrincipalName).toBe('valentina.rojas@outlook.example');
  });
});

describe('2. listar mensajes', () => {
  it('con el formato del ejemplo: $select, $filter ge, $orderby asc y cuerpo HTML como texto', async () => {
    const desde = new Date(e.reloj.ahora - 2.5 * 86_400_000).toISOString().slice(0, 19) + 'Z';
    const consulta = `$filter=receivedDateTime ge ${desde}&$orderby=receivedDateTime asc&$select=${SELECT}&$top=50`;
    const { status, cuerpo, headers } = await graph(e.url, token, `/me/messages?${consulta}`, {
      headers: { Prefer: 'outlook.body-content-type="html"' },
    });
    expect(status).toBe(200);
    expect(headers.get('preference-applied')).toBe('outlook.body-content-type="html"');
    expect(cuerpo['@odata.context']).toMatch(
      /^https:\/\/graph\.microsoft\.com\/v1\.0\/\$metadata#users\('[0-9a-f-]+'\)\/messages\(id,receivedDateTime,from,subject,body,internetMessageId\)$/,
    );
    expect(cuerpo['@odata.nextLink']).toBeUndefined();
    const mensajes = cuerpo.value as (Mensaje & Record<string, unknown>)[];
    // Las semillas de hace 2 y 1 día más los 5 de hoy.
    expect(mensajes).toHaveLength(7);
    for (const m of mensajes) {
      expect(Object.keys(m).sort()).toEqual(['@odata.etag', ...SELECT.split(',')].sort());
      expect(m['@odata.etag']).toMatch(/^W\/"/);
      expect(m.receivedDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(Date.parse(m.receivedDateTime)).toBeGreaterThanOrEqual(Date.parse(desde));
      expect(m.body.contentType).toBe('html');
    }
    const fechas = mensajes.map((m) => m.receivedDateTime);
    expect(fechas).toEqual([...fechas].sort());
    // El hotel de hace 2 días: remitente y JSON-LD en el cuerpo, en texto (no en base64).
    expect(mensajes[0]?.from).toEqual({
      emailAddress: { name: 'Hotel Cordillera', address: 'reservas@hotel-cordillera.example' },
    });
    expect(mensajes[0]?.body.content).toContain('"@type": "LodgingReservation"');
  });

  it('pagina con $top y @odata.nextLink, que se usa tal cual', async () => {
    const primera = await graph(e.url, token, '/me/messages?$top=3&$select=id');
    const ids = (r: typeof primera) => (r.cuerpo.value as { id: string }[]).map((m) => m.id);
    expect(ids(primera)).toHaveLength(3);
    const siguiente = String(primera.cuerpo['@odata.nextLink']);
    expect(siguiente).toContain('$skip=3');
    const respuesta = await fetch(siguiente, { headers: { Authorization: `Bearer ${token}` } });
    const segunda = (await respuesta.json()) as { value: { id: string }[] };
    expect(segunda.value).toHaveLength(3);
    expect(segunda.value.some((m) => ids(primera).includes(m.id))).toBe(false);
  });

  it('sin $orderby, del más nuevo al más viejo; $top por defecto 10', async () => {
    await inyectar(ANA, { cantidad: 5, semilla: 4 });
    const { cuerpo } = await graph(e.url, token, '/me/messages?$select=receivedDateTime');
    const fechas = (cuerpo.value as Mensaje[]).map((m) => m.receivedDateTime);
    expect(fechas).toHaveLength(10);
    expect(fechas).toEqual([...fechas].sort().reverse());
  });

  it('Prefer text: el cuerpo viene como texto plano', async () => {
    const { correos } = await inyectar(ANA, { tipo: 'vuelo', semilla: 9 });
    const { cuerpo, headers } = await graph(e.url, token, `/me/messages/${correos[0]?.id ?? ''}`, {
      headers: { Prefer: 'outlook.body-content-type="text"' },
    });
    expect(headers.get('preference-applied')).toBe('outlook.body-content-type="text"');
    expect((cuerpo as unknown as Mensaje).body).toEqual({
      contentType: 'text',
      content: expect.stringContaining(correos[0]?.reserva?.numeroReserva ?? '?') as string,
    });
  });

  it('correo sin marcado pedido en HTML: Graph lo convierte, con el texto de la plantilla', async () => {
    const { correos } = await inyectar(ANA, { tipo: 'hotel-sin-marcado' });
    const { cuerpo } = await graph(
      e.url,
      token,
      `/me/messages/${correos[0]?.id ?? ''}?$select=body`,
    );
    const { body } = cuerpo as unknown as Mensaje;
    expect(body.contentType).toBe('html');
    expect(body.content).toContain(
      'Hotel Cordillera - Confirmación de reserva<br>Número de reserva: HC-',
    );
  });

  it('errores: $filter no soportado, InefficientFilter, $select desconocido y $top fuera de rango', async () => {
    const casos: [string, string][] = [
      ["/me/messages?$filter=subject eq 'hola'", 'BadRequest'],
      [
        '/me/messages?$filter=receivedDateTime ge 2026-11-01T00:00:00Z&$orderby=subject',
        'InefficientFilter',
      ],
      ['/me/messages?$select=id,asunto', 'RequestBroker--ParseUri'],
      ['/me/messages?$top=1001', 'BadRequest'],
    ];
    for (const [ruta, code] of casos) {
      const { status, cuerpo } = await graph(e.url, token, ruta);
      expect(status, ruta).toBe(400);
      expect(cuerpo, ruta).toMatchObject({ error: { code } });
    }
  });
});

describe('3. obtener un mensaje', () => {
  it('trae los mismos campos que cada elemento de value', async () => {
    const lista = await graph(e.url, token, `/me/messages?$top=1&$select=${SELECT}`);
    const primero = (lista.cuerpo.value as Mensaje[])[0];
    const { status, cuerpo } = await graph(
      e.url,
      token,
      `/me/messages/${primero?.id ?? ''}?$select=${SELECT}`,
    );
    expect(status).toBe(200);
    // El mismo mensaje, más el @odata.context de un solo mensaje.
    expect(cuerpo).toEqual({
      ...primero,
      '@odata.context': expect.stringMatching(/\/messages\/\$entity$/) as string,
    });
  });

  it('un id que no existe o de otro buzón: 404 con el formato de Graph', async () => {
    const ajeno = await inyectar('bruno.diaz@outlook.example', { tipo: 'no-viaje' });
    for (const id of ['AAMkAGinventado', ajeno.correos[0]?.id ?? '']) {
      const { status, cuerpo } = await graph(e.url, token, `/me/messages/${id}`);
      expect(status).toBe(404);
      expect(cuerpo).toMatchObject({
        error: {
          code: 'ErrorItemNotFound',
          innerError: { 'request-id': expect.any(String) as string },
        },
      });
    }
  });
});

describe('6. límites de uso (QA-7)', () => {
  it('al superar el límite por buzón responde 429 con Retry-After y el formato de Graph', async () => {
    const limitado = await levantar({ limiteSolicitudes: 3, ventanaLimiteS: 60 });
    try {
      const { access_token } = await conectar(limitado.url, ANA);
      for (let i = 0; i < 3; i++)
        expect((await graph(limitado.url, access_token, '/me')).status).toBe(200);
      limitado.reloj.ahora += 20_000;
      const { status, headers, cuerpo } = await graph(limitado.url, access_token, '/me/messages');
      expect(status).toBe(429);
      expect(headers.get('retry-after')).toBe('40');
      expect(cuerpo).toEqual({
        error: {
          code: 'TooManyRequests',
          innerError: {
            code: '429',
            date: expect.any(String) as string,
            message: 'Please retry after',
            'request-id': expect.any(String) as string,
            status: '429',
          },
          message: 'Please retry again later.',
        },
      });
      // Otro buzón no se ve afectado; al pasar la ventana, vuelve a responder.
      const otro = await conectar(limitado.url, 'bruno.diaz@outlook.example');
      expect((await graph(limitado.url, otro.access_token, '/me')).status).toBe(200);
      limitado.reloj.ahora += 40_000;
      expect((await graph(limitado.url, access_token, '/me')).status).toBe(200);
    } finally {
      await limitado.cerrar();
    }
  });
});
