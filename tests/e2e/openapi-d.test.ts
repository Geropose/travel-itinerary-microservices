import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leerEnv } from '../../infra/scripts/entorno.ts';
import {
  CONFIG_E2E,
  eliminarReservasUsuario,
  pedirJson,
  registrarYLogin,
  reiniciarMock,
  tokenServicioDePruebas,
  type SesionE2E,
} from './comun.ts';
import { prepararContrato } from './openapi-contratos.ts';

interface AvisoDePrueba {
  id?: string;
  idempotency_key?: string;
  data?: { object?: { order?: { booking_reference?: string } } };
}

function aislarAviso(aviso: AvisoDePrueba): void {
  const sufijo = randomUUID();
  const referencia = `CT${sufijo.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const orden = aviso.data?.object?.order;
  // Cada variante usa un PNR propio y conserva el campo que la prueba omitió.
  if (orden?.booking_reference !== undefined) orden.booking_reference = referencia;
  if (aviso.id !== undefined) aviso.id = `wev_${sufijo}`;
  if (aviso.idempotency_key !== undefined) aviso.idempotency_key = `${referencia}-v2`;
}

describe.skipIf(process.env.CONTRATOS_EN_VIVO !== '1')(
  'Contratos HTTP de Asistente e Integraciones (dueño D)',
  () => {
    let sesion: SesionE2E;
    let asistente: ReturnType<typeof prepararContrato>;
    let integraciones: ReturnType<typeof prepararContrato>;
    let secretoWebhook: string;
    const fecha = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    const inicio = fecha.toISOString();
    const fin = new Date(fecha.getTime() + 3 * 60 * 60_000).toISOString();

    async function vuelo(): Promise<string> {
      const numeroReserva = `CT${randomUUID().slice(0, 4).toUpperCase()}`;
      const orden = await pedirJson(`${CONFIG_E2E.urlMockAerolinea}/admin/ordenes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          booking_reference: numeroReserva,
          departing_at: inicio,
          arriving_at: fin,
        }),
      });
      expect(orden.status).toBe(201);
      return numeroReserva;
    }

    beforeAll(async () => {
      sesion = await registrarYLogin();
      asistente = prepararContrato('asistente', sesion.jwt);
      integraciones = prepararContrato('integraciones', sesion.jwt);
      const perfil = await pedirJson(`${CONFIG_E2E.urlEnrutador}/api/usuarios/perfil`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sesion.jwt}` },
        body: JSON.stringify({ agenciaPreferida: 'viajes-del-plata' }),
      });
      expect(perfil.status).toBe(200);
      const env = leerEnv(readFileSync(new URL('../../.env', import.meta.url), 'utf8'));
      secretoWebhook = process.env.SECRETO_WEBHOOK_AEROLINEA ?? env.SECRETO_WEBHOOK_AEROLINEA ?? '';
      expect(secretoWebhook).not.toBe('');
    });

    afterAll(async () => {
      if (!sesion) return;
      await eliminarReservasUsuario(sesion);
      await reiniciarMock(CONFIG_E2E.urlMockAerolinea);
      await reiniciarMock(CONFIG_E2E.urlMockAgencia);
      await reiniciarMock(CONFIG_E2E.urlMockRedSocial);
      const diferencias: unknown[] = [];
      for (const contrato of [asistente, integraciones]) {
        try {
          contrato?.verificar();
        } catch (error) {
          diferencias.push(error);
        }
      }
      if (diferencias.length)
        throw new AggregateError(diferencias, 'Diferencias de contratos HTTP');
    });

    it('comprueba las seis operaciones de Asistente', async () => {
      await asistente.probar('consultarSalud', { status: 200 });
      const conversacion = (await asistente.probar('crearConversacion', { status: 201 })) as
        | {
            conversacionId: string;
          }
        | undefined;
      if (!conversacion) throw new Error('No se pudo preparar la conversación E2E');
      const parametros = { conversacionId: conversacion.conversacionId };
      await asistente.probar('obtenerConversacion', { status: 200, parametros });
      await asistente.probar('listarMensajesNuevos', { status: 200, parametros });

      const numeroReserva = await vuelo();
      const reserva = await pedirJson(`${CONFIG_E2E.urlEnrutador}/api/viajes/reservas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sesion.jwt}` },
        body: JSON.stringify({
          numeroReserva,
          proveedor: 'aerolinea-andina',
          tipoReserva: 'vuelo',
          origen: 'EZE',
          destino: 'SCL',
          inicio,
          fin,
        }),
      });
      expect(reserva.status).toBe(201);
      const turno = (await asistente.probar('enviarMensaje', {
        status: 200,
        parametros,
        cuerpo: { texto: `Quiero cambiar mi vuelo ${numeroReserva} para mañana` },
      })) as { respuesta: { opciones?: { opcionId: string }[] } } | undefined;
      const opcionId = turno?.respuesta.opciones?.[0]?.opcionId;
      if (!opcionId) throw new Error('[asistente · dueño D] El asistente no devolvió opciones');
      await asistente.probar('confirmarReprogramacion', {
        status: 200,
        parametros,
        cuerpo: { opcionId },
      });
    }, 90_000);

    it('comprueba salud, agencia y red social de Integraciones', async () => {
      await integraciones.probar('consultarSalud', { status: 200 });
      await integraciones.probar('contactarAgencia', { status: 201 });
      const ejemplo = integraciones.ejemplo('crearCasoAgencia');
      if (!ejemplo || Array.isArray(ejemplo) || typeof ejemplo !== 'object')
        throw new Error('Falta el ejemplo de la operación crearCasoAgencia');
      await integraciones.probar('crearCasoAgencia', {
        status: 201,
        cuerpo: { ...ejemplo, usuarioId: sesion.usuarioId },
      });
      await integraciones.probar('publicarItinerario', { status: 201 });
    }, 90_000);

    it('comprueba las dos operaciones internas de reprogramación', async () => {
      const numeroReserva = await vuelo();
      const reserva = { proveedor: 'aerolinea-andina', numeroReserva };
      const resultado = (await integraciones.probar('pedirOpcionesReprogramacion', {
        status: 200,
        cuerpo: reserva,
      })) as { opciones: { opcionId: string }[] } | undefined;
      const opcionId = resultado?.opciones?.[0]?.opcionId;
      if (!opcionId) throw new Error('[integraciones · dueño D] El proveedor no devolvió opciones');
      await integraciones.probar('aplicarReprogramacion', {
        status: 200,
        cuerpo: { ...reserva, opcionId },
      });
    }, 90_000);

    it('comprueba el webhook firmado y la consulta de avisos no traducidos', async () => {
      const ejemplo = integraciones.ejemplo('recibirAvisoProveedor');
      if (!ejemplo) throw new Error('Falta el ejemplo de webhook de Aerolínea Andina');
      aislarAviso(ejemplo as AvisoDePrueba);
      await integraciones.probar('recibirAvisoProveedor', {
        status: 200,
        parametros: { proveedor: 'aerolinea-andina' },
        parametrosInvalidos: { proveedor: 'hotel-cordillera' },
        cuerpo: ejemplo,
        estadoValido: 'aceptado',
        estadoWebhook: 'no-traducido',
        prepararVariante(cuerpo) {
          const aviso = structuredClone(cuerpo);
          aislarAviso(aviso as AvisoDePrueba);
          return aviso;
        },
        signo(cuerpo) {
          const t = Math.floor(Date.now() / 1000);
          const firma = createHmac('sha256', secretoWebhook).update(`${t}.${cuerpo}`).digest('hex');
          return { 'X-Webhook-Signature': `t=${t},v1=${firma}` };
        },
      });
      const tokenServicio = tokenServicioDePruebas(sesion.region);
      await integraciones.probar('listarNoTraducidos', {
        status: 200,
        headers: { Authorization: `Bearer ${tokenServicio}` },
      });
    }, 90_000);
  },
);
