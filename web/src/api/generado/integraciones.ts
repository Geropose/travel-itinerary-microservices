// Generado con npm run web:api desde specs/openapi/integraciones.yaml. No editar a mano.
export interface paths {
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Estado del servicio
         * @description Responde `200` si el servicio puede atender (base y broker conectados) y `503` si no (CONVENCIONES 4.3). No consulta a los terceros: un proveedor caído no deja al servicio sin salud.
         */
        get: operations["consultarSalud"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/webhooks/proveedores/{proveedor}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Recibir el aviso de cambio de un proveedor
         * @description La llama el proveedor que avisa sus cambios (en el prototipo, solo `aerolinea-andina`; formato en specs/externos/aerolinea.md, inspirado en los webhooks de Duffel). Es pública: no lleva JWT, se autentica con la firma HMAC. El proveedor no sabe la región del usuario: el enrutador global manda el aviso a las dos regiones (gateway.yaml). Cada región lo traduce y publica ReservaActualizada en su broker; el Viajes que no tiene la reserva lo ignora.
         *
         *     **Verificación de la firma.** La cabecera `X-Webhook-Signature` tiene la forma `t=<segundos epoch>,v1=<firma>`. El adaptador calcula `HMAC-SHA256(secreto, t + "." + cuerpo)` sobre el cuerpo **tal como llegó** (los bytes crudos, sin volver a serializar el JSON), en hexadecimal en minúsculas, y lo compara con `v1` en tiempo constante. El secreto es uno por proveedor y sale de una variable de entorno. Responde `401` y no guarda ni publica nada si falta la cabecera, si no tiene el formato `t=...,v1=...`, si la firma no coincide o si `t` difiere en más de 5 minutos de la hora actual.
         *
         *     **Procesamiento.** Con la firma válida, el adaptador traduce el aviso a `ReservaActualizada.datos` (`proveedor` sale de la URL, `numeroReserva` de `booking_reference`, `estado` de `status`, `cambios` comparando `segments` con `removed`) y guarda el evento `ReservaActualizada` (specs/schemas/ReservaActualizada.json) en el outbox, en la misma transacción; el publicador lo envía al broker y Viajes lo consume. Responde en menos de 5 segundos. Un aviso repetido (mismo `proveedor` + `booking_reference` + `version`) se responde `200` con `estado: repetido` y no se publica otra vez. Un aviso con firma válida que no se puede traducir (falta `booking_reference`, `status` desconocido, segmentos vacíos sin cancelación) se guarda en `no_traducidos` con el cuerpo sin datos personales y se responde `200` con `estado: no-traducido`, así el proveedor no lo reintenta (QA-6).
         */
        post: operations["recibirAvisoProveedor"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/interna/reprogramaciones/opciones": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Pedir al proveedor las opciones para reprogramar una reserva
         * @description La usa el plug-in de reprogramación del Asistente Virtual (Iteración 7, UC-8) con el JWT del usuario. El adaptador del proveedor pide las opciones (en la aerolínea, `POST /air/order_change_requests`) y las traduce. Una reserva cancelada también puede pedir opciones (reubicación). Si el proveedor no ofrece reprogramación (hotel y rentadora en el prototipo) o no tiene opciones, responde `200` con `opciones` vacío y el asistente ofrece derivar el caso a la agencia. Integraciones recuerda las opciones que devolvió, así `aplicar` solo acepta una de ellas. No verifica que la reserva sea del usuario (Integraciones no guarda reservas): lo verifica el asistente consultando antes a Viajes con el mismo JWT.
         */
        post: operations["pedirOpcionesReprogramacion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/interna/reprogramaciones/aplicar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Aplicar una de las opciones de reprogramación
         * @description La usa el plug-in de reprogramación del Asistente Virtual solo después de que el usuario confirma la opción (Iteración 7). `opcionId` tiene que ser una de las opciones que devolvió `POST /interna/reprogramaciones/opciones` para esa misma reserva; si no, `404`. El adaptador la aplica en el proveedor (en la aerolínea, `POST /air/order_changes`). El cambio de la reserva no se devuelve acá: el proveedor lo avisa después (webhook `order.updated`), vuelve a entrar como `ReservaActualizada` y Viajes lo guarda. Si se repite el pedido de una opción que ya se aplicó desde Trotamundos, responde `200` con el mismo resultado (idempotente).
         */
        post: operations["aplicarReprogramacion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agencias/casos": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Contactar a la agencia desde la web
         * @description La usa el botón "Contactar a mi agencia" de la web (UC-6), sin pasar por el asistente, con el JWT del usuario. Hace lo mismo que la ruta interna `POST /interna/agencias/casos`: el adaptador de la agencia crea el caso con el resumen que escribió el usuario y la conversación vacía. La agencia es la preferida del perfil del usuario y el contacto (nombre y email) lo pide Integraciones al Servicio de Usuarios (GET /perfil, con el JWT propagado, ADR-019). Si el usuario no tiene agencia preferida, 409. Si la agencia no responde a tiempo o responde `503`, 503.
         */
        post: operations["contactarAgencia"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/interna/agencias/casos": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Derivar el problema del usuario a su agencia
         * @description La usa el plug-in de derivación del Asistente Virtual (Iteración 7, UC-6, ADR-019) con el JWT del usuario. El adaptador de la agencia crea el caso (en el mock, `POST /api/v2/tickets`, inspirado en Zendesk; ver specs/externos/agencia.md): `resumen` va al asunto y al comienzo del texto, y `conversacion` sigue debajo, una línea por mensaje. `usuarioId` tiene que ser el `sub` del JWT. El asistente pide antes el perfil al Servicio de Usuarios y manda el nombre y el email en `contacto`. Si la agencia no responde a tiempo o responde `503`, se responde `503` y el asistente avisa al usuario.
         */
        post: operations["crearCasoAgencia"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/interna/redes/publicar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Publicar un itinerario en una red social
         * @description La usa Viajes cuando el usuario comparte un viaje en una red social (`POST /viajes/{viajeId}/compartir-red`), con el JWT del usuario (Iteración 3, QA-7: menos de 3 s). El adaptador de la red arma el texto (título con destino y fechas, una línea por reserva, recortado a 500 caracteres) en el idioma del claim `idioma` del JWT y lo publica (en el mock, `POST /api/v1/statuses`, inspirado en Mastodon; ver specs/externos/redsocial.md) con una `Idempotency-Key` propia por pedido. El itinerario no lleva números de reserva. Simplificación del prototipo: se publica siempre con una única cuenta de Trotamundos (un token por entorno), no con la cuenta de cada usuario; en un sistema real cada usuario conectaría su cuenta con OAuth, como el correo (ADR-015).
         */
        post: operations["publicarItinerario"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/interna/no-traducidos": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Listar los mensajes de proveedores que no se pudieron traducir
         * @description Mensajes de proveedores (por webhook o por consulta periódica) que el adaptador no pudo traducir, con el cuerpo sin datos personales (ADR-003, QA-6: 99 % sin intervención manual). Sirve para revisarlos a mano y para medir QA-6 en el prototipo. No hay un usuario detrás (la usan el equipo y las pruebas): lleva el token de servicio y solo acepta el servicio pruebas. Ordenados del más nuevo al más viejo.
         */
        get: operations["listarNoTraducidos"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * @description Número o código de la reserva tal como lo emite el proveedor.
         * @example XKQ7PL
         */
        NumeroReserva: string;
        SolicitudOpciones: {
            proveedor: components["schemas"]["Proveedor"];
            numeroReserva: components["schemas"]["NumeroReserva"];
        };
        OpcionesReprogramacion: {
            proveedor: components["schemas"]["Proveedor"];
            numeroReserva: components["schemas"]["NumeroReserva"];
            /** @description Vacío si el proveedor no ofrece reprogramación o no tiene opciones. */
            opciones: components["schemas"]["OpcionReprogramacion"][];
        };
        /** @description Una opción del proveedor, traducida. En la aerolínea, `inicio` es el `departing_at` del primer segmento nuevo y `fin` el `arriving_at` del último. */
        OpcionReprogramacion: {
            /**
             * @description Identificador de la opción en el proveedor (en la aerolínea, el de la oferta).
             * @example oco_0000AN0000000101
             */
            opcionId: string;
            /**
             * Format: date-time
             * @description Hasta cuándo se puede aplicar.
             */
            venceEn: string;
            costo: components["schemas"]["Costo"];
            /** Format: date-time */
            inicio: string;
            /** Format: date-time */
            fin: string;
            /**
             * @description Código IATA del aeropuerto de salida (solo vuelos).
             * @example EZE
             */
            origen?: string;
            /**
             * @description Código IATA del aeropuerto de llegada (solo vuelos).
             * @example SCL
             */
            destino?: string;
            detalle?: {
                /**
                 * @description Código de la aerolínea y número de vuelo, como en `ReservaActualizada`.
                 * @example AN 1240
                 */
                numeroVuelo?: string;
            };
        };
        /** @description Lo que cobra el proveedor por el cambio. */
        Costo: {
            /**
             * @description Importe decimal como texto, para no perder precisión.
             * @example 0.00
             */
            monto: string;
            /**
             * @description Código ISO 4217.
             * @example USD
             */
            moneda: string;
        };
        SolicitudAplicar: {
            proveedor: components["schemas"]["Proveedor"];
            numeroReserva: components["schemas"]["NumeroReserva"];
            /** @example oco_0000AN0000000101 */
            opcionId: string;
        };
        ResultadoReprogramacion: {
            proveedor: components["schemas"]["Proveedor"];
            numeroReserva: components["schemas"]["NumeroReserva"];
            opcionId: string;
            /**
             * @description El proveedor confirmó el cambio. La reserva actualizada llega después como `ReservaActualizada`.
             * @enum {string}
             */
            estado: "aplicada";
            /** Format: date-time */
            aplicadaEn: string;
        };
        SolicitudCaso: {
            /**
             * @description Identificador de la agencia preferida del usuario (perfil en Usuarios).
             * @example viajes-del-plata
             */
            agencia: string;
            /**
             * Format: uuid
             * @description Tiene que ser el `sub` del JWT.
             */
            usuarioId: string;
            /** @description Resumen del problema que arma el asistente. */
            resumen: string;
            /** @description Nombre y email del usuario, para que la agencia lo pueda contactar (en el mock van a `ticket.requester`). Los manda quien llama, que los pide al Servicio de Usuarios (GET /perfil con el JWT del usuario). Es opcional: sin contacto la agencia solo recibe el resumen y la conversación. */
            contacto?: {
                nombre: string;
                /** Format: email */
                email: string;
            };
            /** @description Mensajes de la conversación con el asistente, en orden. Puede ir vacío si el usuario pidió la agencia sin conversar. */
            conversacion: components["schemas"]["MensajeConversacion"][];
        };
        SolicitudContactoAgencia: {
            /** @description Lo que el usuario le quiere decir a la agencia. */
            resumen: string;
        };
        MensajeConversacion: {
            /** @enum {string} */
            autor: "usuario" | "asistente";
            texto: string;
            /** Format: date-time */
            enviadoEn: string;
        };
        CasoCreado: {
            /** @example viajes-del-plata */
            agencia: string;
            /**
             * @description Número de caso que da la agencia; el asistente se lo muestra al usuario.
             * @example 35436
             */
            numeroCaso: string;
            /** Format: date-time */
            creadoEn: string;
        };
        SolicitudPublicacion: {
            /**
             * @description Identificador de la red social (configuración de adaptadores).
             * @example redsocial
             */
            red: string;
            itinerario: components["schemas"]["Itinerario"];
        };
        /** @description Lo que se publica de un viaje. No lleva números de reserva ni datos personales. */
        Itinerario: {
            /** Format: uuid */
            viajeId: string;
            /**
             * @description Destino principal del viaje, para el título.
             * @example Santiago
             */
            destino: string;
            /** Format: date-time */
            inicio: string;
            /** Format: date-time */
            fin: string;
            /** @description En orden cronológico; una línea de la publicación por reserva. */
            reservas: components["schemas"]["ReservaItinerario"][];
        };
        ReservaItinerario: {
            tipoReserva: components["schemas"]["TipoReserva"];
            /** @example Vuelo AN 1234 */
            descripcion: string;
            /** Format: date-time */
            inicio: string;
            /** Format: date-time */
            fin?: string;
            /** @description Solo vuelos. */
            origen?: string;
            /** @description Solo vuelos. */
            destino?: string;
        };
        Publicacion: {
            /** @example redsocial */
            red: string;
            /**
             * Format: uri
             * @description URL pública de la publicación, para mostrarle al usuario.
             */
            url: string;
            /** Format: date-time */
            publicadaEn: string;
        };
        ListaNoTraducidos: {
            mensajes: components["schemas"]["MensajeNoTraducido"][];
        };
        MensajeNoTraducido: {
            /** Format: uuid */
            id: string;
            proveedor: components["schemas"]["Proveedor"];
            /**
             * @description `webhook` si lo mandó el proveedor; `consulta` si salió de la consulta periódica (cada 2 minutos).
             * @enum {string}
             */
            via: "webhook" | "consulta";
            /** Format: date-time */
            recibidoEn: string;
            /** @description Por qué no se pudo traducir. */
            motivo: string;
            /** @description Cuerpo que llegó, sin datos personales. Antes de guardarlo, el adaptador reemplaza por "[quitado]" los valores de los campos con datos personales que conoce del formato del proveedor (nombres de pasajeros y huéspedes, emails, teléfonos). Si el cuerpo no es JSON no se guarda: queda "[cuerpo no JSON de N bytes]". */
            cuerpo: string;
        };
        AvisoRecibido: {
            /** @enum {string} */
            estado: "aceptado" | "repetido" | "no-traducido";
        };
        /** @description Aviso de la aerolínea, con los nombres originales. Un aviso con firma válida que no cumple este esquema no se rechaza: va a `no_traducidos` (ver la descripción de la operación). */
        AvisoAerolinea: {
            /** @example wev_0000AN0000000042 */
            id: string;
            /**
             * @description `order.airline_initiated_change_detected`: la aerolínea cambió o canceló el vuelo. `order.updated`: se aplicó una reprogramación pedida por Trotamundos.
             * @enum {string}
             */
            type: "order.airline_initiated_change_detected" | "order.updated";
            /** Format: date-time */
            created_at: string;
            /** @example XKQ7PL-v2 */
            idempotency_key: string;
            data: {
                object: {
                    order: components["schemas"]["OrdenAerolinea"];
                    /** @description Segmentos que ya no están. */
                    removed: components["schemas"]["SegmentoAerolinea"][];
                    /** @description Segmentos nuevos. Vacío en una cancelación. */
                    added: components["schemas"]["SegmentoAerolinea"][];
                };
            };
        };
        OrdenAerolinea: {
            /** @example ord_0000AN000XKQ7PL */
            id: string;
            /**
             * @description Código de reserva (PNR). Es el `numeroReserva` de Trotamundos.
             * @example XKQ7PL
             */
            booking_reference: string;
            /**
             * @description `confirmed` → `confirmada`, `changed` → `modificada`, `cancelled` → `cancelada`.
             * @enum {string}
             */
            status: "confirmed" | "changed" | "cancelled";
            /** @description Sube en 1 con cada cambio; con `booking_reference` sirve para descartar repetidos. */
            version: number;
            /** Format: date-time */
            created_at?: string;
            /** Format: date-time */
            updated_at: string;
            /** Format: date-time */
            cancelled_at: string | null;
            owner: {
                /** @example AN */
                iata_code: string;
                /** @example Aerolínea Andina */
                name: string;
            };
            passengers: {
                id: string;
                given_name: string;
                family_name: string;
            }[];
            /** @description Vuelos de la reserva, en orden. Vacío solo en una cancelación. */
            segments: components["schemas"]["SegmentoAerolinea"][];
        };
        SegmentoAerolinea: {
            /** @example seg_0001 */
            id: string;
            marketing_carrier: {
                /** @example AN */
                iata_code: string;
            };
            /** @example 1234 */
            marketing_carrier_flight_number: string;
            origin: components["schemas"]["AeropuertoAerolinea"];
            destination: components["schemas"]["AeropuertoAerolinea"];
            /**
             * Format: date-time
             * @description Con la diferencia horaria del aeropuerto (ISO 8601).
             */
            departing_at: string;
            /** Format: date-time */
            arriving_at: string;
            /** @example 14C */
            seat?: string;
        };
        AeropuertoAerolinea: {
            /** @example EZE */
            iata_code: string;
            /** @example Buenos Aires */
            city_name: string;
        };
        Salud: {
            /**
             * @example ok
             * @enum {string}
             */
            estado: "ok" | "degradado";
        };
        /** @description Error en formato application/problem+json (RFC 7807). */
        Problema: {
            /**
             * @description URI que identifica el tipo de error.
             * @example https://trotamundos.example/errores/no-autorizado
             */
            type: string;
            /** @example No autorizado */
            title: string;
            /** @example 401 */
            status: number;
            /** @example Falta el token o venció. */
            detail?: string;
            /**
             * Format: uuid
             * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
             */
            requestId: string;
            /** @description Detalle por campo, solo en errores de validación (400). */
            errores?: {
                campo: string;
                mensaje: string;
            }[];
        };
        /**
         * @description Identificador del proveedor, el mismo en los eventos, Viajes e Integraciones.
         * @example aerolinea-andina
         */
        Proveedor: string;
        /** @enum {string} */
        TipoReserva: "vuelo" | "hotel" | "auto";
    };
    responses: {
        /** @description El JWT no tiene el rol `usuario` (por ejemplo, es de un analista). La solicitud rechazada se guarda en el registro de accesos (QA-9). */
        SoloUsuarios: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://trotamundos.example/errores/prohibido",
                 *       "title": "Acceso denegado",
                 *       "status": 403,
                 *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problema"];
            };
        };
        /** @description El tercero respondió algo inesperado: un error que no es de los previstos (por ejemplo `401` porque la clave de API configurada es inválida) o una respuesta que el adaptador no pudo traducir (502). */
        ErrorTercero: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://trotamundos.example/errores/error-tercero",
                 *       "title": "Error del tercero",
                 *       "status": 502,
                 *       "detail": "Aerolínea Andina rechazó la clave de API.",
                 *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problema"];
            };
        };
        /** @description El tercero no está disponible: respondió `503` o no respondió dentro del tiempo máximo (2 s por defecto, CONVENCIONES 4.3). Quien llama degrada de forma controlada (ADR-019). También se usa si el propio servicio no puede atender. */
        TerceroNoDisponible: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://trotamundos.example/errores/tercero-no-disponible",
                 *       "title": "Tercero no disponible",
                 *       "status": 503,
                 *       "detail": "Aerolínea Andina no respondió a tiempo.",
                 *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problema"];
            };
        };
        /** @description El servicio puede atender (base y broker conectados). */
        Salud: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Salud"];
            };
        };
        /** @description El servicio o una dependencia no está disponible (503). */
        NoDisponible: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://trotamundos.example/errores/no-disponible",
                 *       "title": "Servicio no disponible",
                 *       "status": 503,
                 *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problema"];
            };
        };
        /** @description El cuerpo o los parámetros no cumplen el contrato (400). */
        SolicitudInvalida: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://trotamundos.example/errores/solicitud-invalida",
                 *       "title": "Solicitud inválida",
                 *       "status": 400,
                 *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c",
                 *       "errores": [
                 *         {
                 *           "campo": "email",
                 *           "mensaje": "no es un email válido"
                 *         }
                 *       ]
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problema"];
            };
        };
        /** @description Falta el JWT, es inválido o venció (401). */
        NoAutenticado: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://trotamundos.example/errores/no-autenticado",
                 *       "title": "No autenticado",
                 *       "status": 401,
                 *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problema"];
            };
        };
        /** @description El usuario no tiene permiso (403). La solicitud rechazada se guarda en el registro de accesos (QA-9). */
        Prohibido: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://trotamundos.example/errores/prohibido",
                 *       "title": "Acceso denegado",
                 *       "status": 403,
                 *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problema"];
            };
        };
    };
    parameters: {
        /**
         * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
         * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
         */
        XRequestId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    consultarSalud: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
                 * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
                 */
                "X-Request-Id"?: components["parameters"]["XRequestId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Salud"];
            503: components["responses"]["NoDisponible"];
        };
    };
    recibirAvisoProveedor: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Firma del aviso, `t=<segundos epoch>,v1=<HMAC-SHA256 en hexadecimal>`. Si falta o es inválida, la respuesta es `401`.
                 * @example t=1795857150,v1=5d1f8e0c3b7a4e2f9c6d8b1a0e3f5c7d9b2a4c6e8f0a1b3d5c7e9f1a3b5d7c9e
                 */
                "X-Webhook-Signature": string;
                /**
                 * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
                 * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
                 */
                "X-Request-Id"?: components["parameters"]["XRequestId"];
            };
            path: {
                /**
                 * @description Identificador del proveedor en Trotamundos (configuración de adaptadores).
                 * @example aerolinea-andina
                 */
                proveedor: components["schemas"]["Proveedor"];
            };
            cookie?: never;
        };
        /** @description Aviso en el formato original de la aerolínea (nombres en inglés, `snake_case`). */
        requestBody: {
            content: {
                "application/json": components["schemas"]["AvisoAerolinea"];
            };
        };
        responses: {
            /** @description Aviso recibido. `aceptado`: se guardó `ReservaActualizada` en el outbox. `repetido`: ya se había procesado ese cambio. `no-traducido`: se guardó en `no_traducidos`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AvisoRecibido"];
                };
            };
            /** @description El cuerpo no es JSON. Igual se guarda en `no_traducidos`, pero sin el cuerpo: solo su tamaño (QA-6). */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/solicitud-invalida",
                     *       "title": "Solicitud inválida",
                     *       "status": 400,
                     *       "detail": "El cuerpo del aviso no es JSON.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            /** @description Falta `X-Webhook-Signature`, no tiene el formato `t=...,v1=...`, la firma no coincide o `t` tiene más de 5 minutos de diferencia. No se guarda ni se publica nada. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/firma-invalida",
                     *       "title": "Firma inválida",
                     *       "status": 401,
                     *       "detail": "La firma del aviso no coincide.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            /** @description El proveedor de la URL no está configurado o no avisa cambios (por ejemplo `hotel-cordillera`, que se consulta cada 2 minutos). */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/no-encontrado",
                     *       "title": "No encontrado",
                     *       "status": 404,
                     *       "detail": "El proveedor hotel-cordillera no recibe avisos por webhook.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            503: components["responses"]["NoDisponible"];
        };
    };
    pedirOpcionesReprogramacion: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
                 * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
                 */
                "X-Request-Id"?: components["parameters"]["XRequestId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "proveedor": "aerolinea-andina",
                 *       "numeroReserva": "XKQ7PL"
                 *     }
                 */
                "application/json": components["schemas"]["SolicitudOpciones"];
            };
        };
        responses: {
            /** @description Opciones que ofrece el proveedor (de 0 a 3 en el mock de la aerolínea). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OpcionesReprogramacion"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["SoloUsuarios"];
            /** @description El proveedor no está configurado o no tiene esa reserva. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/no-encontrado",
                     *       "title": "No encontrado",
                     *       "status": 404,
                     *       "detail": "Aerolínea Andina no tiene la reserva XKQ7PX.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            502: components["responses"]["ErrorTercero"];
            503: components["responses"]["TerceroNoDisponible"];
        };
    };
    aplicarReprogramacion: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
                 * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
                 */
                "X-Request-Id"?: components["parameters"]["XRequestId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "proveedor": "aerolinea-andina",
                 *       "numeroReserva": "XKQ7PL",
                 *       "opcionId": "oco_0000AN0000000101"
                 *     }
                 */
                "application/json": components["schemas"]["SolicitudAplicar"];
            };
        };
        responses: {
            /** @description El proveedor confirmó la reprogramación. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "proveedor": "aerolinea-andina",
                     *       "numeroReserva": "XKQ7PL",
                     *       "opcionId": "oco_0000AN0000000101",
                     *       "estado": "aplicada",
                     *       "aplicadaEn": "2026-11-28T09:21:10Z"
                     *     }
                     */
                    "application/json": components["schemas"]["ResultadoReprogramacion"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["SoloUsuarios"];
            /** @description El proveedor no está configurado, o `opcionId` no es una de las opciones ofrecidas para esa reserva. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/no-encontrado",
                     *       "title": "No encontrado",
                     *       "status": 404,
                     *       "detail": "La opción oco_0000AN0000000999 no se ofreció para la reserva XKQ7PL.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            /** @description La opción venció (`venceEn` pasado) o ya se usó para otro cambio (la aerolínea responde `422 offer_no_longer_available`). Hay que pedir opciones de nuevo. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/opcion-vencida",
                     *       "title": "La opción ya no está disponible",
                     *       "status": 409,
                     *       "detail": "La opción oco_0000AN0000000101 venció. Pedí opciones de nuevo.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            502: components["responses"]["ErrorTercero"];
            503: components["responses"]["TerceroNoDisponible"];
        };
    };
    contactarAgencia: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
                 * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
                 */
                "X-Request-Id"?: components["parameters"]["XRequestId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "resumen": "Necesito cambiar la fecha de vuelta del viaje a Santiago."
                 *     }
                 */
                "application/json": components["schemas"]["SolicitudContactoAgencia"];
            };
        };
        responses: {
            /** @description La agencia creó el caso. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "agencia": "viajes-del-plata",
                     *       "numeroCaso": "35437",
                     *       "creadoEn": "2026-11-28T10:02:40Z"
                     *     }
                     */
                    "application/json": components["schemas"]["CasoCreado"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["SoloUsuarios"];
            /** @description El usuario no eligió una agencia preferida en su perfil. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/conflicto",
                     *       "title": "Sin agencia preferida",
                     *       "status": 409,
                     *       "detail": "Elegí una agencia en tu perfil para poder contactarla.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            502: components["responses"]["ErrorTercero"];
            503: components["responses"]["TerceroNoDisponible"];
        };
    };
    crearCasoAgencia: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
                 * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
                 */
                "X-Request-Id"?: components["parameters"]["XRequestId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "agencia": "viajes-del-plata",
                 *       "usuarioId": "6b1e7c2a-4f3d-4e8b-9c0a-1d2e3f4a5b6c",
                 *       "contacto": {
                 *         "nombre": "Ana García",
                 *         "email": "ana.garcia@gmail.com"
                 *       },
                 *       "resumen": "La aerolínea canceló el vuelo AN 1234 del 10/12 (reserva XKQ7PL, Aerolínea Andina). No hay opciones de reprogramación disponibles y el usuario pidió hablar con una persona.",
                 *       "conversacion": [
                 *         {
                 *           "autor": "usuario",
                 *           "texto": "Me cancelaron el vuelo a Santiago, ¿qué hago?",
                 *           "enviadoEn": "2026-11-28T09:30:05Z"
                 *         },
                 *         {
                 *           "autor": "asistente",
                 *           "texto": "Busqué opciones de reprogramación con Aerolínea Andina y no hay vuelos disponibles.",
                 *           "enviadoEn": "2026-11-28T09:30:09Z"
                 *         },
                 *         {
                 *           "autor": "usuario",
                 *           "texto": "Quiero hablar con mi agencia.",
                 *           "enviadoEn": "2026-11-28T09:31:02Z"
                 *         }
                 *       ]
                 *     }
                 */
                "application/json": components["schemas"]["SolicitudCaso"];
            };
        };
        responses: {
            /** @description La agencia creó el caso. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "agencia": "viajes-del-plata",
                     *       "numeroCaso": "35436",
                     *       "creadoEn": "2026-11-28T09:31:12Z"
                     *     }
                     */
                    "application/json": components["schemas"]["CasoCreado"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            /** @description `usuarioId` no es el `sub` del JWT, o el JWT no tiene el rol `usuario`. La solicitud rechazada se guarda en el registro de accesos (QA-9). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/prohibido",
                     *       "title": "Acceso denegado",
                     *       "status": 403,
                     *       "detail": "No se puede derivar un caso a nombre de otro usuario.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            /** @description La agencia no está configurada. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/no-encontrado",
                     *       "title": "No encontrado",
                     *       "status": 404,
                     *       "detail": "No hay un adaptador para la agencia viajes-del-sur.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            502: components["responses"]["ErrorTercero"];
            503: components["responses"]["TerceroNoDisponible"];
        };
    };
    publicarItinerario: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
                 * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
                 */
                "X-Request-Id"?: components["parameters"]["XRequestId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "red": "redsocial",
                 *       "itinerario": {
                 *         "viajeId": "3f8a2c1e-7b4d-4e9a-8c6f-1a2b3c4d5e6f",
                 *         "destino": "Santiago",
                 *         "inicio": "2026-12-10T08:30:00-03:00",
                 *         "fin": "2026-12-14T11:00:00-03:00",
                 *         "reservas": [
                 *           {
                 *             "tipoReserva": "vuelo",
                 *             "descripcion": "Vuelo AN 1234",
                 *             "inicio": "2026-12-10T08:30:00-03:00",
                 *             "fin": "2026-12-10T10:40:00-03:00",
                 *             "origen": "Buenos Aires (EZE)",
                 *             "destino": "Santiago (SCL)"
                 *           },
                 *           {
                 *             "tipoReserva": "hotel",
                 *             "descripcion": "Hotel Cordillera",
                 *             "inicio": "2026-12-10T15:00:00-03:00",
                 *             "fin": "2026-12-14T11:00:00-03:00"
                 *           }
                 *         ]
                 *       }
                 *     }
                 */
                "application/json": components["schemas"]["SolicitudPublicacion"];
            };
        };
        responses: {
            /** @description La red social publicó el itinerario. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "red": "redsocial",
                     *       "url": "https://redsocial.example/@ana_garcia/103254962155278888",
                     *       "publicadaEn": "2026-11-28T15:04:47Z"
                     *     }
                     */
                    "application/json": components["schemas"]["Publicacion"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["SoloUsuarios"];
            /** @description La red social no está configurada. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/no-encontrado",
                     *       "title": "No encontrado",
                     *       "status": 404,
                     *       "detail": "No hay un adaptador para la red otra-red.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            502: components["responses"]["ErrorTercero"];
            503: components["responses"]["TerceroNoDisponible"];
        };
    };
    listarNoTraducidos: {
        parameters: {
            query?: {
                /**
                 * @description Solo los mensajes de este proveedor.
                 * @example hotel-cordillera
                 */
                proveedor?: components["schemas"]["Proveedor"];
                /**
                 * @description Solo los mensajes recibidos en este momento o después.
                 * @example 2026-11-28T00:00:00Z
                 */
                desde?: string;
                /** @description Cantidad máxima de mensajes. */
                limite?: number;
            };
            header?: {
                /**
                 * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
                 * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
                 */
                "X-Request-Id"?: components["parameters"]["XRequestId"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Mensajes no traducidos (puede ir vacío). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "mensajes": [
                     *         {
                     *           "id": "9d2e4f6a-1b3c-4d5e-8f7a-0b1c2d3e4f5a",
                     *           "proveedor": "aerolinea-andina",
                     *           "via": "webhook",
                     *           "recibidoEn": "2026-11-28T09:40:00Z",
                     *           "motivo": "Falta booking_reference.",
                     *           "cuerpo": "{\"id\":\"wev_0000AN0000000050\",\"type\":\"order.airline_initiated_change_detected\",\"created_at\":\"2026-11-28T09:40:00Z\",\"idempotency_key\":\"-v1\",\"data\":{\"object\":{\"order\":{\"id\":\"ord_0000AN000000000\",\"status\":\"changed\",\"version\":1}}}}"
                     *         },
                     *         {
                     *           "id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
                     *           "proveedor": "hotel-cordillera",
                     *           "via": "consulta",
                     *           "recibidoEn": "2026-11-28T09:36:00Z",
                     *           "motivo": "status desconocido: waitlisted.",
                     *           "cuerpo": "{\"reservationId\":\"HC-48299\",\"status\":\"waitlisted\"}"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["ListaNoTraducidos"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            503: components["responses"]["NoDisponible"];
        };
    };
}
