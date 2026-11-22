// QA-11 (Iteración 4): el idioma que el usuario elige en Preferencias queda en su cuenta. Usuarios
// guarda el perfil y publica IdiomaActualizado; Autenticación lo guarda en la credencial, así el
// próximo login (por ejemplo, desde otro dispositivo) trae el JWT con el idioma nuevo.
import { describe, expect, it } from 'vitest';
import {
  CONFIG_E2E,
  esperarCondicion,
  pedirJson,
  registrarYLogin,
  sistemaDisponible,
} from './comun.ts';

const haySistema = await sistemaDisponible();

/** Claim idioma de un JWT (sin verificar la firma: el JWT lo acaba de dar Autenticación). */
const idiomaDe = (jwt: string) =>
  (JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as { idioma: string })
    .idioma;

describe.skipIf(!haySistema)('QA-11: el idioma elegido queda en la cuenta', () => {
  it('después de cambiar el idioma en el perfil, un login nuevo trae el JWT en ese idioma', async () => {
    const sesion = await registrarYLogin({ idioma: 'es' });
    expect(idiomaDe(sesion.jwt)).toBe('es');

    const cambio = await pedirJson(`${CONFIG_E2E.urlEnrutador}/api/usuarios/perfil`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sesion.jwt}`,
        'X-Region': sesion.region,
      },
      body: JSON.stringify({ idioma: 'en' }),
    });
    expect(cambio.status).toBe(200);

    // El evento pasa por el outbox (cada 500 ms) y el broker: se espera unos segundos.
    const idioma = await esperarCondicion(async () => {
      const login = await pedirJson<{ jwt: string }>(
        `${CONFIG_E2E.urlEnrutador}/api/autenticacion/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Region': sesion.region },
          body: JSON.stringify({ email: sesion.email, contrasena: sesion.contrasena }),
        },
      );
      const claim = login.datos ? idiomaDe(login.datos.jwt) : undefined;
      return claim === 'en' ? claim : undefined;
    }, 10_000);
    expect(idioma).toBe('en');
  });
});
