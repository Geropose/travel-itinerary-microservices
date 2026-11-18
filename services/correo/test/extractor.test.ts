import { randomUUID } from 'node:crypto';
import { validadorEventos } from '@trotamundos/comun';
import { describe, expect, it } from 'vitest';
import { crearAzar, generarCorreo } from '../../../mocks/comun/src/generador.ts';
import type { MensajeCorreo } from '../src/adaptadores/tipos.ts';
import { extraerReservaDeCorreo, htmlATexto } from '../src/extractor.ts';
import { cumpleFiltroRemitente } from '../src/procesador.ts';

describe('Filtro de remitentes (cumpleFiltroRemitente)', () => {
  it('permite todos cuando no hay filtro o filtrosActivos es false', () => {
    expect(cumpleFiltroRemitente('cualquiera@otro.example', null)).toBe(true);
    expect(
      cumpleFiltroRemitente('cualquiera@otro.example', {
        remitentesPermitidos: ['solo@uno.example'],
        filtrosActivos: false,
      }),
    ).toBe(true);
  });

  it('valida direcciones exactas y dominios @... ignorando mayúsculas', () => {
    const filtro = {
      remitentesPermitidos: ['reservas@aerolinea-andina.example', '@hotel-cordillera.example'],
      filtrosActivos: true,
    };

    expect(cumpleFiltroRemitente('Reservas@Aerolinea-Andina.Example', filtro)).toBe(true);
    expect(cumpleFiltroRemitente('cualquier.cosita@hotel-cordillera.example', filtro)).toBe(true);
    expect(cumpleFiltroRemitente('otro@aerolinea-andina.example', filtro)).toBe(false);
    expect(cumpleFiltroRemitente('reservas@falso-hotel-cordillera.example', filtro)).toBe(false);
    expect(cumpleFiltroRemitente('reservas@viajes-baratos.example', filtro)).toBe(false);
  });
});

describe('Extractor de reservas (JSON-LD + reglas de texto + no_procesados)', () => {
  const usuarioId = randomUUID();
  const validador = validadorEventos();

  it('extrae correctamente todos los tipos y variantes del generador y valida contra ReservaDetectada.json', () => {
    const azar = crearAzar(42);
    const tipos = [
      'vuelo',
      'hotel',
      'auto',
      'vuelo-sin-marcado',
      'hotel-sin-marcado',
      'auto-sin-marcado',
    ] as const;
    const estados = ['confirmada', 'modificada', 'cancelada'] as const;

    for (const tipo of tipos) {
      for (const estado of estados) {
        const gen = generarCorreo(azar, {
          tipo,
          para: 'ana@gmail.example',
          nombre: 'Ana García',
          estado,
        });
        const mensaje: MensajeCorreo = {
          id: `msg-${tipo}-${estado}`,
          remitente: gen.correo.de.replace(/^.*<([^>]+)>$/, '$1').toLowerCase(),
          asunto: gen.correo.asunto,
          recibidoEn: gen.correo.fecha,
          ...(gen.correo.html ? { cuerpoHtml: gen.correo.html } : {}),
          ...(gen.correo.texto ? { cuerpoTexto: gen.correo.texto } : {}),
        };
        const res = extraerReservaDeCorreo(mensaje, usuarioId);
        expect(res.tipo).toBe('reserva');
        if (res.tipo === 'reserva') {
          expect(res.datos.proveedor).toBe(gen.etiqueta.reserva?.proveedor);
          expect(res.datos.tipoReserva).toBe(gen.etiqueta.reserva?.tipoReserva);
          expect(res.datos.numeroReserva).toBe(gen.etiqueta.reserva?.numeroReserva);
          expect(res.datos.estado).toBe(gen.etiqueta.reserva?.estado);

          expect(() =>
            validador.validar({
              eventId: randomUUID(),
              tipo: 'ReservaDetectada',
              version: 1,
              ocurridoEn: new Date().toISOString(),
              region: 'region-1',
              datos: res.datos,
            }),
          ).not.toThrow();
        }
      }
    }
  });

  it('extrae plantillas sin marcado aunque Outlook las convierta a HTML con <br>', () => {
    const azar = crearAzar(7);
    const gen = generarCorreo(azar, {
      tipo: 'auto-sin-marcado',
      para: 'ana@outlook.example',
      nombre: 'Ana García',
    });
    const htmlOutlook = `<html><body><div>${gen.correo.texto.replace(/\n/g, '<br>')}</div></body></html>`;
    expect(htmlATexto(htmlOutlook)).toContain('Vehículo:');

    const res = extraerReservaDeCorreo(
      {
        id: 'outlook-html-plain',
        remitente: 'reservas@rentadora-sur.example',
        asunto: gen.correo.asunto,
        recibidoEn: gen.correo.fecha,
        cuerpoHtml: htmlOutlook,
      },
      usuarioId,
    );
    expect(res.tipo).toBe('reserva');
    if (res.tipo === 'reserva') {
      expect(res.datos.numeroReserva).toBe(gen.etiqueta.reserva?.numeroReserva);
      expect(res.datos.tipoReserva).toBe('auto');
    }
  });

  it('clasifica estado-no-confirmado, marcado-invalido, proveedor-desconocido, sin-regla y no-viaje', () => {
    // Hold / Pending -> estado-no-confirmado
    const hold = extraerReservaDeCorreo(
      {
        id: 'm1',
        remitente: 'reservas@hotel-cordillera.example',
        asunto: 'Reserva en espera',
        recibidoEn: new Date(),
        cuerpoHtml: `<script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'LodgingReservation',
          reservationNumber: 'HC-1',
          reservationStatus: 'https://schema.org/ReservationHold',
          reservationFor: { name: 'Hotel', address: { addressLocality: 'Santiago' } },
          checkinDate: '2026-12-10T15:00:00Z',
          checkoutDate: '2026-12-12T11:00:00Z',
        })}</script>`,
      },
      usuarioId,
    );
    expect(hold).toMatchObject({ tipo: 'no-procesado', motivo: 'estado-no-confirmado' });

    // JSON-LD inválido o incompleto -> marcado-invalido
    const roto = extraerReservaDeCorreo(
      {
        id: 'm2',
        remitente: 'reservas@aerolinea-andina.example',
        asunto: 'Confirmación de tu reserva',
        recibidoEn: new Date(),
        cuerpoHtml: `<script type="application/ld+json">{ "@type": "FlightReservation", roto </script>`,
      },
      usuarioId,
    );
    expect(roto).toMatchObject({ tipo: 'no-procesado', motivo: 'marcado-invalido' });

    // Proveedor fuera de la tabla dominio -> proveedor -> proveedor-desconocido
    const genNoPerm = generarCorreo(crearAzar(9), {
      tipo: 'remitente-no-permitido',
      para: 'ana@gmail.example',
      nombre: 'Ana',
    });
    const desconocido = extraerReservaDeCorreo(
      {
        id: 'm3',
        remitente: 'reservas@viajes-baratos.example',
        asunto: genNoPerm.correo.asunto,
        recibidoEn: new Date(),
        cuerpoHtml: genNoPerm.correo.html,
      },
      usuarioId,
    );
    expect(desconocido).toMatchObject({ tipo: 'no-procesado', motivo: 'proveedor-desconocido' });

    // Correo de viaje que no coincide con ninguna plantilla -> sin-regla
    const sinRegla = extraerReservaDeCorreo(
      {
        id: 'm4',
        remitente: 'reservas@hotel-cordillera.example',
        asunto: 'Hotel Cordillera - Cambio de fechas',
        recibidoEn: new Date(),
        cuerpoTexto: 'Tu estadía fue movida al mes próximo.',
      },
      usuarioId,
    );
    expect(sinRegla).toMatchObject({ tipo: 'no-procesado', motivo: 'sin-regla' });

    // Correo que no es de viaje (incluso promoción de aerolínea) -> no-viaje (se ignora)
    const noViajePromo = extraerReservaDeCorreo(
      {
        id: 'm5',
        remitente: 'novedades@aerolinea-andina.example',
        asunto: 'Ofertas de la semana: volá a Mendoza',
        recibidoEn: new Date(),
        cuerpoTexto: 'Esta semana, pasajes a Mendoza desde $45.000. Comprá antes del domingo.',
      },
      usuarioId,
    );
    expect(noViajePromo).toEqual({ tipo: 'no-viaje' });
  });
});
