# Lo compartido por los mocks de correo (`mocks/comun`)

Paquete `@trotamundos/mocks-comun`, que usan [`mocks/gmail`](../gmail/README.md) y
[`mocks/outlook`](../outlook/README.md). Cada mock guarda los correos con el formato de su proveedor (Gmail:
árbol MIME en base64url; Outlook: mensaje de Graph con el cuerpo en texto); lo de acá no depende del
proveedor.

| Archivo | Qué tiene |
|---|---|
| `src/generador.ts` | Generador de correos de prueba |
| `src/semillas.ts` | Los 20 buzones de prueba y sus correos |
| `src/admin.ts` | Rutas `/admin` (cada mock le pasa cómo guardar y listar sus correos) |
| `src/enviador.ts` | Envío de avisos con reintentos y espera exponencial |
| `src/correo.ts` | El correo antes de guardarlo (`Correo`), su `Etiqueta` y `remitente()` |

## Rutas de administración (solo para pruebas, no son parte del formato real)

| Ruta | Qué hace |
|---|---|
| `GET /admin/buzones` | Lista los buzones con su cantidad de correos (y lo propio de cada mock) |
| `GET /admin/buzones/{email}/correos` | Correos del buzón con su tipo y la reserva que lleva (para comprobar lo que detectan los procesadores) |
| `POST /admin/buzones/{email}/correos` | Inyecta correos (crea el buzón si no existe) y, si el buzón tiene un aviso activo, sale el aviso |
| `POST /admin/buzones/{email}/vencer-tokens` | Hace vencer los access tokens del buzón (para probar la renovación) |
| `POST /admin/buzones/{email}/revocar-tokens` | Revoca los tokens del buzón: la renovación da `invalid_grant` |

Cuerpo de `POST /admin/buzones/{email}/correos`, una de tres formas:

```jsonc
{ "tipo": "vuelo", "estado": "confirmada", "semilla": 7 }   // un correo generado
{ "cantidad": 1000, "semilla": 2026 }                        // un lote mezclado
{ "de": "Alguien <a@correo.example>", "asunto": "Hola", "texto": "...", "html": "<p>...</p>" }
```

Responde `201` con `{ "correos": [{ "id", "tipo", "reserva"? }] }` (Gmail agrega el `historyId`).

## Generador de correos

Arma los correos de [`specs/externos/correos-reserva.md`](../../specs/externos/correos-reserva.md). Con
la misma semilla genera siempre los mismos.

| Tipo | Qué es |
|---|---|
| `vuelo`, `hotel`, `auto` | Reserva con JSON-LD de schema.org en el HTML, del remitente del proveedor de prueba. Usa los dos nombres de estado y de `@context` (Google y schema.org) que el procesador tiene que aceptar |
| `vuelo-sin-marcado`, `hotel-sin-marcado`, `auto-sin-marcado` | La misma reserva, solo texto, con la plantilla fija de la sección 4 |
| `no-viaje` | Noticias, facturas, compras, mensajes personales y una promoción de la aerolínea (que no es una reserva) |
| `remitente-no-permitido` | Reserva con marcado válido de `reservas@viajes-baratos.example`, que no es un proveedor de prueba |

El estado puede ser `confirmada`, `modificada` (con `modifiedTime`) o `cancelada`. Un lote mezcla 45 %
de reservas con marcado, 15 % sin marcado, 30 % que no son de viaje y 10 % de remitentes no permitidos.

## Semillas

Los dos mocks arrancan (`SEMILLAS=true`) con los mismos 20 nombres, de Ana García a Valentina Rojas, con
el dominio de cada uno (`ana.garcia@gmail.example`, `ana.garcia@outlook.example`). Cada buzón tiene una
reserva de vuelo, una de hotel y una de auto con marcado, y 5 correos más al azar.
