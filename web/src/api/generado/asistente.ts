// Generado con npm run web:api desde specs/openapi/asistente.yaml. No editar a mano.
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
         * @description 200 si el asistente puede atender (base conectada y reglas de intenciones cargadas), 503 si no. No depende de Viajes ni de Integraciones: si ellos caen, el asistente degrada (ADR-019).
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
    "/conversaciones": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Abrir una conversación con el asistente
         * @description Crea una conversación para el usuario del JWT, en su región. El idioma sale del claim `idioma` salvo que el cuerpo indique otro. La conversación nace con el saludo del asistente.
         */
        post: operations["crearConversacion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversaciones/{conversacionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Historial de una conversación
         * @description Devuelve la conversación con todos sus mensajes, en orden de `secuencia`. Si el `id` no existe o es de otro usuario responde 404 (ver la descripción general).
         */
        get: operations["obtenerConversacion"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversaciones/{conversacionId}/mensajes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Mensajes nuevos de una conversación
         * @description Devuelve los mensajes con `secuencia` mayor que `desde`, en orden. La ventana de chat lo llama cada 2 s mientras `consultando` sea `true` y deja de preguntar cuando pasa a `false` o cuando se cierra el chat. Si no hay mensajes nuevos devuelve la lista vacía.
         */
        get: operations["listarMensajesNuevos"];
        put?: never;
        /**
         * Enviar un mensaje al asistente
         * @description Guarda el mensaje del usuario, detecta la intención y responde. 200 con la respuesta del asistente cuando no hay que esperar a un proveedor (menos de 3 s, QA-12). 202 con `estado: consultando` cuando una reprogramación tarda más de 3 s: la respuesta llega después por `GET /conversaciones/{conversacionId}/mensajes?desde=`. Si una dependencia no responde, igual es 200 con `resultado: noDisponible` (degradación controlada, ADR-019). Si no entiende la consulta repregunta, y al segundo intento fallido deriva el caso a la agencia.
         */
        post: operations["enviarMensaje"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversaciones/{conversacionId}/confirmaciones": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Confirmar una opción de reprogramación
         * @description El usuario elige una de las opciones que el asistente mostró en esta conversación. El asistente solo acepta un `opcionId` que vino de Integraciones en la última oferta pendiente (nunca una opción inventada) y recién entonces pide aplicarla (`POST /interna/reprogramaciones/aplicar`). El cambio vuelve a entrar como `ReservaActualizada`. La confirmación queda en el historial como mensaje del usuario con el campo `confirmacion`. Igual que en `enviarMensaje`: 202 si aplicar tarda más de 3 s, y 200 con `resultado: noDisponible` si Integraciones o el proveedor no responden en 2 s.
         */
        post: operations["confirmarReprogramacion"];
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
        /** @description Cuerpo opcional para abrir una conversación. */
        NuevaConversacion: {
            idioma?: components["schemas"]["Idioma"];
        };
        /**
         * @description Zona horaria IANA del dispositivo del usuario. Es opcional: el asistente la usa para mostrar las horas en el texto de sus respuestas como las ve el usuario en el panel. Si falta o no es válida, usa UTC.
         * @example America/Argentina/Buenos_Aires
         */
        ZonaHoraria: string;
        NuevoMensaje: {
            /**
             * @description Lo que escribió el usuario.
             * @example ¿Cuál es el estado de mi vuelo XKQ7PL?
             */
            texto: string;
            zonaHoraria?: components["schemas"]["ZonaHoraria"];
        };
        Confirmacion: {
            opcionId: components["schemas"]["OpcionId"];
            zonaHoraria?: components["schemas"]["ZonaHoraria"];
        };
        Conversacion: {
            /** Format: uuid */
            conversacionId: string;
            /**
             * Format: uuid
             * @description Dueño de la conversación (`sub` del JWT).
             */
            usuarioId: string;
            region: components["schemas"]["Region"];
            idioma: components["schemas"]["Idioma"];
            /** Format: date-time */
            creadaEn: string;
            /** Format: date-time */
            actualizadaEn: string;
            /** @description `true` mientras el asistente espera a un proveedor (después de un 202). La ventana de chat lo usa para retomar la consulta cada 2 s si se recarga la página. */
            consultando: boolean;
            /** @description Todos los mensajes, ordenados por `secuencia`. */
            mensajes: components["schemas"]["Mensaje"][];
        };
        /** @description Un mensaje del historial. Los campos `intencion`, `resultado`, `reservas`, `opciones`, `caso`, `noDisponible` y `ofreceDerivar` solo aparecen en mensajes del asistente; `confirmacion` solo en mensajes del usuario enviados por `confirmarReprogramacion`. */
        Mensaje: {
            /** Format: uuid */
            mensajeId: string;
            /** @description Número creciente dentro de la conversación; es el valor que usa `desde`. */
            secuencia: number;
            /** @enum {string} */
            autor: "usuario" | "asistente";
            /** @description Texto del mensaje. Los del asistente salen de las reglas de intenciones en el idioma de la conversación (configuración externa, QA-11). */
            texto: string;
            /** Format: date-time */
            enviadoEn: string;
            intencion?: components["schemas"]["Intencion"];
            resultado?: components["schemas"]["ResultadoMensaje"];
            confirmacion?: components["schemas"]["Confirmacion"];
            /** @description Reservas que respondió el plug-in de consulta de estado (desde Viajes). */
            reservas?: components["schemas"]["ReservaResumen"][];
            /** @description Opciones de reprogramación de Integraciones, pendientes de confirmación. */
            opciones?: components["schemas"]["OpcionReprogramacion"][];
            caso?: components["schemas"]["CasoDerivado"];
            noDisponible?: components["schemas"]["FuncionNoDisponible"];
            /** @description `true` cuando el asistente ofrece derivar el caso a la agencia (ADR-019). Si el usuario responde que sí, el plug-in de derivación crea el caso. */
            ofreceDerivar?: boolean;
        };
        /**
         * @description Intención detectada por el núcleo de conversación; cada una la atiende un plug-in (ADR-018). `desconocida`: no se entendió el mensaje.
         * @enum {string}
         */
        Intencion: "estado" | "reprogramar" | "problemaMenor" | "derivar" | "desconocida";
        /**
         * @description Qué pasó con el mensaje del usuario:
         *     - `respondido`: respuesta final (estado, problema menor, saludo).
         *     - `repregunta`: no se entendió; al segundo intento fallido se deriva.
         *     - `consultando`: se espera al proveedor (más de 3 s); la respuesta llega por polling.
         *     - `opciones`: se muestran opciones de reprogramación y se espera la confirmación.
         *     - `reprogramado`: el proveedor aplicó la opción confirmada.
         *     - `opcionRechazada`: el proveedor ya no acepta la opción; se ofrece derivar.
         *     - `derivado`: se creó el caso en la agencia preferida.
         *     - `noDisponible`: degradación controlada, una dependencia no respondió (ADR-019).
         * @enum {string}
         */
        ResultadoMensaje: "respondido" | "repregunta" | "consultando" | "opciones" | "reprogramado" | "opcionRechazada" | "derivado" | "noDisponible";
        /**
         * @description Identificador opaco de una opción de reprogramación, generado por Integraciones en `POST /interna/reprogramaciones/opciones` y aceptado por `POST /interna/reprogramaciones/aplicar`. El asistente no lo interpreta.
         * @example ocr_XKQ7PL_1
         */
        OpcionId: string;
        OpcionReprogramacion: {
            opcionId: components["schemas"]["OpcionId"];
            proveedor: components["schemas"]["Proveedor"];
            /** @example XKQ7PL */
            numeroReserva: string;
            tipoReserva: components["schemas"]["TipoReserva"];
            /**
             * Format: date-time
             * @description Nuevo inicio si se aplica la opción.
             */
            inicio: string;
            /**
             * Format: date-time
             * @description Nuevo fin si se aplica la opción.
             */
            fin: string;
            /**
             * @description Solo en vuelos.
             * @example AEP
             */
            origen?: string;
            /** @example MDZ */
            destino: string;
            /**
             * @description Texto corto para mostrar en el botón de la opción.
             * @example 3 de diciembre, 10:30, sin cargo
             */
            descripcion?: string;
        };
        ReservaResumen: {
            proveedor: components["schemas"]["Proveedor"];
            /** @example XKQ7PL */
            numeroReserva: string;
            tipoReserva: components["schemas"]["TipoReserva"];
            estado: components["schemas"]["EstadoReserva"];
            /** Format: date-time */
            inicio: string;
            /** Format: date-time */
            fin: string;
            /**
             * @description Solo en vuelos.
             * @example AEP
             */
            origen?: string;
            /** @example MDZ */
            destino: string;
        };
        /** @description Caso creado en la agencia preferida a través de Integraciones (UC-6). */
        CasoDerivado: {
            /**
             * @description Identificador de la agencia preferida del usuario (lo da Usuarios).
             * @example viajes-del-plata
             */
            agencia: string;
            /**
             * @description Número de caso que devolvió la agencia.
             * @example 35436
             */
            numeroCaso: string;
        };
        /** @description Qué función quedó apagada por la degradación controlada y por qué (ADR-019). */
        FuncionNoDisponible: {
            /**
             * @description Los problemas menores nunca quedan apagados (sus respuestas son configuración).
             * @enum {string}
             */
            funcion: "estado" | "reprogramar" | "derivar";
            /**
             * @description Dependencia que no respondió en 2 s o respondió 503.
             * @enum {string}
             */
            servicio: "viajes" | "usuarios" | "integraciones" | "proveedor" | "agencia";
        };
        RespuestaMensaje: {
            /**
             * @description `respondido` con 200; `consultando` con 202 (la respuesta definitiva llega por `GET /conversaciones/{conversacionId}/mensajes?desde=`).
             * @enum {string}
             */
            estado: "respondido" | "consultando";
            mensajeUsuario: components["schemas"]["Mensaje"];
            respuesta: components["schemas"]["Mensaje"];
        };
        ListaMensajes: {
            mensajes: components["schemas"]["Mensaje"][];
            /** @description Si es `true`, la ventana de chat vuelve a preguntar en 2 s. */
            consultando: boolean;
            /** @description Secuencia del último mensaje de la conversación; el próximo `desde`. */
            ultimaSecuencia: number;
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
        /** @enum {string} */
        Idioma: "es" | "en";
        /** @enum {string} */
        Region: "region-1" | "region-2";
        /**
         * @description Identificador del proveedor, el mismo en los eventos, Viajes e Integraciones.
         * @example aerolinea-andina
         */
        Proveedor: string;
        /** @enum {string} */
        TipoReserva: "vuelo" | "hotel" | "auto";
        /** @enum {string} */
        EstadoReserva: "confirmada" | "modificada" | "cancelada";
    };
    responses: {
        /** @description El `opcionId` no está entre las opciones pendientes de esta conversación: nunca se ofreció, ya se confirmó otra, las opciones vencieron o todavía se está consultando al proveedor (409). */
        OpcionNoPendiente: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://trotamundos.example/errores/opcion-no-pendiente",
                 *       "title": "La opción no está pendiente",
                 *       "status": 409,
                 *       "detail": "La opción ocr_XKQ7PL_9 no está entre las opciones ofrecidas en esta conversación.",
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
        /** @description El recurso no existe o no es del usuario (404). */
        NoEncontrado: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://trotamundos.example/errores/no-encontrado",
                 *       "title": "No encontrado",
                 *       "status": 404,
                 *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problema"];
            };
        };
    };
    parameters: {
        /**
         * @description Identificador de la conversación.
         * @example 3b2f8c4e-6a1d-4e7b-9c3f-5d2a1b0e9f87
         */
        ConversacionId: string;
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
    crearConversacion: {
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
        requestBody?: {
            content: {
                /**
                 * @example {
                 *       "idioma": "es"
                 *     }
                 */
                "application/json": components["schemas"]["NuevaConversacion"];
            };
        };
        responses: {
            /** @description Conversación creada. */
            201: {
                headers: {
                    /**
                     * @description Ruta de la conversación creada.
                     * @example /api/asistente/conversaciones/3b2f8c4e-6a1d-4e7b-9c3f-5d2a1b0e9f87
                     */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "conversacionId": "3b2f8c4e-6a1d-4e7b-9c3f-5d2a1b0e9f87",
                     *       "usuarioId": "9c1e5a7b-2d4f-4a6c-8e1b-3f5d7a9c2e4b",
                     *       "region": "region-1",
                     *       "idioma": "es",
                     *       "creadaEn": "2026-11-20T13:45:00Z",
                     *       "actualizadaEn": "2026-11-20T13:45:00Z",
                     *       "consultando": false,
                     *       "mensajes": [
                     *         {
                     *           "mensajeId": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
                     *           "secuencia": 1,
                     *           "autor": "asistente",
                     *           "texto": "Hola, soy el asistente de Trotamundos. ¿En qué te ayudo?",
                     *           "enviadoEn": "2026-11-20T13:45:00Z",
                     *           "resultado": "respondido"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["Conversacion"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            503: components["responses"]["NoDisponible"];
        };
    };
    obtenerConversacion: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
                 * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
                 */
                "X-Request-Id"?: components["parameters"]["XRequestId"];
            };
            path: {
                /**
                 * @description Identificador de la conversación.
                 * @example 3b2f8c4e-6a1d-4e7b-9c3f-5d2a1b0e9f87
                 */
                conversacionId: components["parameters"]["ConversacionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Conversación con su historial. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "conversacionId": "3b2f8c4e-6a1d-4e7b-9c3f-5d2a1b0e9f87",
                     *       "usuarioId": "9c1e5a7b-2d4f-4a6c-8e1b-3f5d7a9c2e4b",
                     *       "region": "region-1",
                     *       "idioma": "es",
                     *       "creadaEn": "2026-11-20T13:45:00Z",
                     *       "actualizadaEn": "2026-11-20T13:45:09Z",
                     *       "consultando": false,
                     *       "mensajes": [
                     *         {
                     *           "mensajeId": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
                     *           "secuencia": 1,
                     *           "autor": "asistente",
                     *           "texto": "Hola, soy el asistente de Trotamundos. ¿En qué te ayudo?",
                     *           "enviadoEn": "2026-11-20T13:45:00Z",
                     *           "resultado": "respondido"
                     *         },
                     *         {
                     *           "mensajeId": "1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e",
                     *           "secuencia": 2,
                     *           "autor": "usuario",
                     *           "texto": "¿Cuál es el estado de mi vuelo XKQ7PL?",
                     *           "enviadoEn": "2026-11-20T13:45:08Z"
                     *         },
                     *         {
                     *           "mensajeId": "2c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f",
                     *           "secuencia": 3,
                     *           "autor": "asistente",
                     *           "texto": "Tu vuelo XKQ7PL de Buenos Aires a Mendoza sale el 2 de diciembre a las 10:30 y está confirmado.",
                     *           "enviadoEn": "2026-11-20T13:45:09Z",
                     *           "intencion": "estado",
                     *           "resultado": "respondido",
                     *           "reservas": [
                     *             {
                     *               "proveedor": "aerolinea-andina",
                     *               "numeroReserva": "XKQ7PL",
                     *               "tipoReserva": "vuelo",
                     *               "estado": "confirmada",
                     *               "inicio": "2026-12-02T10:30:00Z",
                     *               "fin": "2026-12-02T12:20:00Z",
                     *               "origen": "AEP",
                     *               "destino": "MDZ"
                     *             }
                     *           ]
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["Conversacion"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            503: components["responses"]["NoDisponible"];
        };
    };
    listarMensajesNuevos: {
        parameters: {
            query?: {
                /**
                 * @description Última `secuencia` que la ventana ya tiene. Se usa la secuencia y no una fecha para no depender de los relojes de las distintas instancias del asistente.
                 * @example 5
                 */
                desde?: number;
            };
            header?: {
                /**
                 * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
                 * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
                 */
                "X-Request-Id"?: components["parameters"]["XRequestId"];
            };
            path: {
                /**
                 * @description Identificador de la conversación.
                 * @example 3b2f8c4e-6a1d-4e7b-9c3f-5d2a1b0e9f87
                 */
                conversacionId: components["parameters"]["ConversacionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Mensajes posteriores a `desde`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListaMensajes"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            503: components["responses"]["NoDisponible"];
        };
    };
    enviarMensaje: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
                 * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
                 */
                "X-Request-Id"?: components["parameters"]["XRequestId"];
            };
            path: {
                /**
                 * @description Identificador de la conversación.
                 * @example 3b2f8c4e-6a1d-4e7b-9c3f-5d2a1b0e9f87
                 */
                conversacionId: components["parameters"]["ConversacionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "texto": "Quiero cambiar mi vuelo XKQ7PL para el día siguiente"
                 *     }
                 */
                "application/json": components["schemas"]["NuevoMensaje"];
            };
        };
        responses: {
            /** @description El asistente respondió. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RespuestaMensaje"];
                };
            };
            /** @description La reprogramación tarda más de 3 s. El asistente sigue consultando en segundo plano y deja la respuesta en el historial; la ventana de chat pregunta cada 2 s con `GET /conversaciones/{conversacionId}/mensajes?desde=<secuencia de esta respuesta>`. */
            202: {
                headers: {
                    /**
                     * @description Segundos que la ventana de chat espera antes de preguntar de nuevo.
                     * @example 2
                     */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "estado": "consultando",
                     *       "mensajeUsuario": {
                     *         "mensajeId": "3d4e5f6a-7b8c-4d9e-9f0a-2b3c4d5e6f7a",
                     *         "secuencia": 4,
                     *         "autor": "usuario",
                     *         "texto": "Quiero cambiar mi vuelo XKQ7PL para el día siguiente",
                     *         "enviadoEn": "2026-11-20T13:46:00Z"
                     *       },
                     *       "respuesta": {
                     *         "mensajeId": "4e5f6a7b-8c9d-4e0f-8a1b-3c4d5e6f7a8b",
                     *         "secuencia": 5,
                     *         "autor": "asistente",
                     *         "texto": "Estoy consultando con la aerolínea. Te muestro las opciones en cuanto lleguen.",
                     *         "enviadoEn": "2026-11-20T13:46:03Z",
                     *         "intencion": "reprogramar",
                     *         "resultado": "consultando"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["RespuestaMensaje"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            503: components["responses"]["NoDisponible"];
        };
    };
    confirmarReprogramacion: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
                 * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
                 */
                "X-Request-Id"?: components["parameters"]["XRequestId"];
            };
            path: {
                /**
                 * @description Identificador de la conversación.
                 * @example 3b2f8c4e-6a1d-4e7b-9c3f-5d2a1b0e9f87
                 */
                conversacionId: components["parameters"]["ConversacionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "opcionId": "ocr_XKQ7PL_1"
                 *     }
                 */
                "application/json": components["schemas"]["Confirmacion"];
            };
        };
        responses: {
            /** @description El asistente respondió a la confirmación. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RespuestaMensaje"];
                };
            };
            /** @description Aplicar el cambio tarda más de 3 s. La respuesta llega por `GET /conversaciones/{conversacionId}/mensajes?desde=`. */
            202: {
                headers: {
                    /**
                     * @description Segundos que la ventana de chat espera antes de preguntar de nuevo.
                     * @example 2
                     */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "estado": "consultando",
                     *       "mensajeUsuario": {
                     *         "mensajeId": "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e",
                     *         "secuencia": 7,
                     *         "autor": "usuario",
                     *         "texto": "Confirmo la opción del 3 de diciembre, 10:30",
                     *         "enviadoEn": "2026-11-20T13:46:30Z",
                     *         "confirmacion": {
                     *           "opcionId": "ocr_XKQ7PL_1"
                     *         }
                     *       },
                     *       "respuesta": {
                     *         "mensajeId": "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
                     *         "secuencia": 8,
                     *         "autor": "asistente",
                     *         "texto": "Estoy confirmando el cambio con la aerolínea. Te aviso en cuanto responda.",
                     *         "enviadoEn": "2026-11-20T13:46:33Z",
                     *         "intencion": "reprogramar",
                     *         "resultado": "consultando"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["RespuestaMensaje"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            409: components["responses"]["OpcionNoPendiente"];
            503: components["responses"]["NoDisponible"];
        };
    };
}
