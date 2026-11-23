// Generado con npm run web:api desde specs/openapi/viajes.yaml. No editar a mano.
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
         * @description Responde 200 si la base y el broker están conectados, y 503 si no.
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
    "/panel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Panel de viajes activos del usuario
         * @description Devuelve los viajes activos (no archivados) del usuario del JWT, ordenados por fecha de inicio, cada uno con sus reservas ordenadas por fecha de inicio. Incluye las reservas canceladas, para que el usuario vea la cancelación. El gestor de viajes busca primero en la cache del panel y, si no está, lee la read replica y guarda el resultado en la cache (ADR-004, ADR-011, ADR-012). El encabezado X-Origen-Dato indica de dónde salió la respuesta, para medir QA-2.
         */
        get: operations["obtenerPanel"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/archivados": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Viajes archivados del usuario
         * @description Devuelve los viajes terminados que archivó la tarea de archivado, del más reciente al más antiguo, cada uno con sus reservas ordenadas por fecha de inicio. Se lee de la read replica.
         */
        get: operations["listarArchivados"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/viajes/{viajeId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Detalle de un viaje
         * @description Devuelve un viaje con sus reservas. Lo puede ver el dueño o una persona designada por el dueño (itinerario compartido). Viajes primero mira si quien pide es el dueño con sus propios datos; si no lo es, consulta los permisos de itinerarios del Servicio de Usuarios (GET /interna/permisos/itinerarios/{viajeId}, ADR-005). El gateway no puede hacer esta verificación porque no sabe de quién es cada viaje. La cache nunca reemplaza esa verificación. Si el Servicio de Usuarios no responde, se deniega con 503: nunca se permite el acceso por defecto.
         */
        get: operations["obtenerViaje"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/viajes/{viajeId}/compartir-red": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Publicar el itinerario en una red social
         * @description Publica el itinerario del viaje en una red social. Solo lo puede pedir el dueño del viaje. El Servicio de Viajes arma el itinerario y llama a la ruta interna POST /interna/redes/publicar del Servicio de Integraciones con el JWT del usuario; el adaptador de la red social hace la publicación (Iteración 3, QA-7: menos de 3 s). Si Integraciones o la red social fallan o no responden a tiempo, responde 503 y no se publica nada.
         */
        post: operations["compartirViajeEnRed"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/reservas": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Agregar una reserva a mano
         * @description Alta manual de una reserva (UC-4). Si no se indica viajeId, el gestor de viajes la agrupa sola en el viaje que corresponde por fechas, o crea un viaje nuevo, igual que con las reservas que llegan por correo. Se escribe en la base principal, se invalida la cache del panel del usuario y se publica ViajeActualizado con origenCambio "manual" y estado "confirmada". Responde 409 si el usuario ya tiene una reserva con el mismo proveedor y numeroReserva.
         */
        post: operations["crearReserva"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/reservas/{reservaId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Eliminar una reserva a mano
         * @description Baja manual de una reserva del usuario (UC-4). Se borra de la base principal, se invalida la cache del panel y se publica ViajeActualizado con origenCambio "manual" y estado "cancelada" (el evento no tiene un estado "eliminada"). Si el viaje queda sin reservas, también se borra. Responde 409 si la reserva está en un viaje archivado.
         */
        delete: operations["eliminarReserva"];
        options?: never;
        head?: never;
        /**
         * Modificar una reserva a mano
         * @description Cambio manual de una reserva del usuario (UC-4). Solo se mandan los campos que cambian; proveedor, numeroReserva y tipoReserva no se pueden cambiar (identifican la reserva). Con viajeId se mueve la reserva a otro viaje del usuario. Se escribe en la base principal, se invalida la cache del panel y se publica ViajeActualizado con origenCambio "manual". Responde 409 si la reserva o el viaje destino están archivados, o si fin queda antes que inicio.
         */
        patch: operations["modificarReserva"];
        trace?: never;
    };
    "/interna/reservas": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Reservas de un usuario (interna)
         * @description La usa el plug-in de consulta de estado del Asistente Virtual (Iteración 7). Recibe el JWT del usuario propagado (ADR-019): usuarioId tiene que coincidir con el claim sub, si no responde 403. Devuelve las reservas de los viajes activos ordenadas por fecha de inicio, filtradas por estado si se indica.
         */
        get: operations["listarReservasInterna"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/interna/viajes/{viajeId}/dueno": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Si el usuario del JWT es el dueño del viaje (interna)
         * @description La usa el Servicio de Usuarios para saber si quien gestiona los designados de un itinerario es el dueño del viaje. Recibe el JWT del usuario propagado (ADR-019) y responde si el sub del token es el dueño; no devuelve el usuarioId del dueño. Si el viaje no existe, 404.
         */
        get: operations["consultarDuenoViaje"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/interna/reservas/{numeroReserva}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Reserva por número y proveedor (interna)
         * @description Busca una reserva del usuario del JWT por proveedor + numeroReserva, la misma clave que usa ReservaActualizada. La usan los plug-ins de consulta de estado y de reprogramación del Asistente Virtual con el JWT del usuario propagado (ADR-019). Si la reserva no existe o es de otro usuario, responde 404.
         */
        get: operations["obtenerReservaPorNumeroInterna"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/interna/usuarios-con-viaje-proximo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Usuarios con un viaje en curso o próximo (interna)
         * @description La usa el examinador del Servicio de Correo para decidir qué buzones revisar cada 5 minutos y cuáles cada 60 (Iteración 2, ADR-010). Devuelve los usuarios de la región con un viaje en curso o que empieza dentro de los próximos `dias` días. La llama una tarea programada, sin usuario: lleva el token de servicio y solo acepta los servicios correo y pruebas. Además solo se puede alcanzar desde la red interna.
         */
        get: operations["listarUsuariosConViajeProximo"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/interna/archivado/ejecutar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ejecutar ya la tarea de archivado (interna)
         * @description Ejecuta en el momento la tarea de archivado, que normalmente corre todas las noches (Iteración 2, UC-5). Sirve para las pruebas y la demo. Archiva los viajes cuya última reserva ya terminó, invalida la cache del panel de cada usuario afectado y publica ViajeActualizado con origenCambio "archivado" por cada reserva. Lleva el token de servicio y solo acepta el servicio pruebas; además solo se puede alcanzar desde la red interna. Responde 409 si la tarea ya está corriendo.
         */
        post: operations["ejecutarArchivado"];
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
        DuenoViaje: {
            /** Format: uuid */
            viajeId: string;
            /** @description true si el usuario del JWT es el dueño del viaje. */
            esDueno: boolean;
        };
        /**
         * @description Qué originó el último cambio de la reserva, igual que en ViajeActualizado: un correo, un aviso del proveedor, una edición manual del usuario o el archivado.
         * @enum {string}
         */
        OrigenCambio: "correo" | "proveedor" | "manual" | "archivado";
        /** @description Reserva guardada en el Servicio de Viajes. Usa los mismos campos que los eventos ReservaDetectada, ReservaActualizada y ViajeActualizado. origen es obligatorio para vuelos. */
        Reserva: {
            /** Format: uuid */
            reservaId: string;
            /**
             * Format: uuid
             * @description Viaje en el que está agrupada la reserva.
             */
            viajeId: string;
            proveedor: components["schemas"]["Proveedor"];
            tipoReserva: components["schemas"]["TipoReserva"];
            /** @description Número o código de la reserva tal como lo emite el proveedor. */
            numeroReserva: string;
            /**
             * Format: date-time
             * @description Salida del vuelo, entrada al hotel o retiro del auto.
             */
            inicio: string;
            /**
             * Format: date-time
             * @description Llegada del vuelo, salida del hotel o devolución del auto.
             */
            fin: string;
            /** @description Lugar de salida del vuelo o de retiro del auto. No aplica a hoteles. */
            origen?: string;
            /** @description Llegada del vuelo, ubicación del hotel o lugar de devolución del auto. */
            destino: string;
            estado: components["schemas"]["EstadoReserva"];
            /** @description Datos propios del tipo de reserva y del proveedor. Forma libre. */
            detalle: Record<string, never>;
            origenCambio: components["schemas"]["OrigenCambio"];
            /**
             * Format: date-time
             * @description Cuándo se guardó el último cambio.
             */
            actualizadoEn: string;
        };
        /** @description Alta manual (UC-4). Mismos campos que ReservaDetectada, sin usuarioId (sale del JWT) ni correoId. Sin viajeId, la reserva se agrupa sola. */
        NuevaReserva: {
            /**
             * Format: uuid
             * @description Viaje del usuario donde agregarla. Si no viene, se agrupa sola.
             */
            viajeId?: string;
            proveedor: components["schemas"]["Proveedor"];
            tipoReserva: components["schemas"]["TipoReserva"];
            numeroReserva: string;
            /** Format: date-time */
            inicio: string;
            /** Format: date-time */
            fin: string;
            origen?: string;
            destino: string;
            /** @description Forma libre. Si no viene, se guarda vacío. */
            detalle?: Record<string, never>;
        };
        /** @description Cambio manual (UC-4). Solo los campos que cambian, como en los cambios de ReservaActualizada, más el estado y el viaje. */
        CambioReserva: {
            /**
             * Format: uuid
             * @description Mover la reserva a otro viaje activo del usuario.
             */
            viajeId?: string;
            /** Format: date-time */
            inicio?: string;
            /** Format: date-time */
            fin?: string;
            origen?: string;
            destino?: string;
            estado?: components["schemas"]["EstadoReserva"];
            detalle?: Record<string, never>;
        };
        /** @description Viaje del usuario: agrupa sus reservas. destino, inicio y fin se calculan a partir de las reservas. */
        Viaje: {
            /** Format: uuid */
            viajeId: string;
            /**
             * Format: uuid
             * @description Dueño del viaje.
             */
            usuarioId: string;
            /** @description Destino principal del viaje. */
            destino: string;
            /**
             * Format: date-time
             * @description Inicio de la primera reserva.
             */
            inicio: string;
            /**
             * Format: date-time
             * @description Fin de la última reserva.
             */
            fin: string;
            /** @enum {string} */
            estado: "activo" | "archivado";
            /** @description Reservas del viaje, ordenadas por fecha de inicio. */
            reservas: components["schemas"]["Reserva"][];
        };
        Panel: {
            /** @description Viajes activos, ordenados por fecha de inicio. */
            viajes: components["schemas"]["Viaje"][];
        };
        ListaViajes: {
            viajes: components["schemas"]["Viaje"][];
        };
        ListaReservas: {
            reservas: components["schemas"]["Reserva"][];
        };
        PedidoCompartirRed: {
            /**
             * @description Identificador de la red social configurada en Integraciones.
             * @example redsocial
             */
            red: string;
        };
        PublicacionRed: {
            red: string;
            /**
             * Format: uri
             * @description URL de la publicación que devolvió la red social.
             */
            url: string;
            /** Format: date-time */
            publicadaEn: string;
        };
        UsuariosConViajeProximo: {
            dias: number;
            /** Format: date-time */
            calculadoEn: string;
            usuarioIds: string[];
        };
        ResultadoArchivado: {
            viajesArchivados: number;
            reservasArchivadas: number;
            /** Format: date-time */
            ejecutadoEn: string;
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
        /** @enum {string} */
        EstadoReserva: "confirmada" | "modificada" | "cancelada";
    };
    responses: {
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
        /** @description El cambio choca con el estado actual (409). */
        Conflicto: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://trotamundos.example/errores/conflicto",
                 *       "title": "Conflicto",
                 *       "status": 409,
                 *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                 *     }
                 */
                "application/problem+json": components["schemas"]["Problema"];
            };
        };
    };
    parameters: {
        /**
         * @description Identificador del viaje.
         * @example 9a1d7c3e-2b4f-4e6a-8c0d-5f1e2a3b4c5d
         */
        ViajeId: string;
        /**
         * @description Identificador interno de la reserva en el Servicio de Viajes.
         * @example 4c2e8f1a-7b3d-4a5e-9c6f-0d1e2f3a4b5c
         */
        ReservaId: string;
        /**
         * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
         * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
         */
        XRequestId: string;
    };
    requestBodies: never;
    headers: {
        /**
         * @description De dónde salió la respuesta del panel: de la cache del panel o de la read replica. Sirve para medir QA-2 (ADR-004).
         * @example cache
         */
        XOrigenDato: "cache" | "replica";
        /** @description Identificador de la solicitud, el mismo que se usó en los logs. */
        XRequestId: string;
    };
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
    obtenerPanel: {
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
            /** @description Panel del usuario. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "X-Origen-Dato": components["headers"]["XOrigenDato"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Panel"];
                };
            };
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            503: components["responses"]["NoDisponible"];
        };
    };
    listarArchivados: {
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
            /** @description Viajes archivados del usuario. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListaViajes"];
                };
            };
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            503: components["responses"]["NoDisponible"];
        };
    };
    obtenerViaje: {
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
                 * @description Identificador del viaje.
                 * @example 9a1d7c3e-2b4f-4e6a-8c0d-5f1e2a3b4c5d
                 */
                viajeId: components["parameters"]["ViajeId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Detalle del viaje. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Viaje"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            503: components["responses"]["NoDisponible"];
        };
    };
    compartirViajeEnRed: {
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
                 * @description Identificador del viaje.
                 * @example 9a1d7c3e-2b4f-4e6a-8c0d-5f1e2a3b4c5d
                 */
                viajeId: components["parameters"]["ViajeId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "red": "redsocial"
                 *     }
                 */
                "application/json": components["schemas"]["PedidoCompartirRed"];
            };
        };
        responses: {
            /** @description El itinerario se publicó. */
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
                    "application/json": components["schemas"]["PublicacionRed"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            503: components["responses"]["NoDisponible"];
        };
    };
    crearReserva: {
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
                "application/json": components["schemas"]["NuevaReserva"];
            };
        };
        responses: {
            /** @description Reserva creada. */
            201: {
                headers: {
                    /**
                     * @description Ruta de la reserva creada.
                     * @example /api/viajes/reservas/4c2e8f1a-7b3d-4a5e-9c6f-0d1e2f3a4b5c
                     */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Reserva"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            409: components["responses"]["Conflicto"];
            503: components["responses"]["NoDisponible"];
        };
    };
    eliminarReserva: {
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
                 * @description Identificador interno de la reserva en el Servicio de Viajes.
                 * @example 4c2e8f1a-7b3d-4a5e-9c6f-0d1e2f3a4b5c
                 */
                reservaId: components["parameters"]["ReservaId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Reserva eliminada. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            409: components["responses"]["Conflicto"];
            503: components["responses"]["NoDisponible"];
        };
    };
    modificarReserva: {
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
                 * @description Identificador interno de la reserva en el Servicio de Viajes.
                 * @example 4c2e8f1a-7b3d-4a5e-9c6f-0d1e2f3a4b5c
                 */
                reservaId: components["parameters"]["ReservaId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "inicio": "2026-12-10T09:30:00Z",
                 *       "fin": "2026-12-10T11:45:00Z",
                 *       "estado": "modificada"
                 *     }
                 */
                "application/json": components["schemas"]["CambioReserva"];
            };
        };
        responses: {
            /** @description Reserva modificada. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "reservaId": "4c2e8f1a-7b3d-4a5e-9c6f-0d1e2f3a4b5c",
                     *       "viajeId": "9a1d7c3e-2b4f-4e6a-8c0d-5f1e2a3b4c5d",
                     *       "proveedor": "aerolinea-andina",
                     *       "tipoReserva": "vuelo",
                     *       "numeroReserva": "XKQ7PL",
                     *       "inicio": "2026-12-10T09:30:00Z",
                     *       "fin": "2026-12-10T11:45:00Z",
                     *       "origen": "Buenos Aires (EZE)",
                     *       "destino": "Santiago (SCL)",
                     *       "estado": "modificada",
                     *       "detalle": {
                     *         "numeroVuelo": "AN 1234"
                     *       },
                     *       "origenCambio": "manual",
                     *       "actualizadoEn": "2026-11-20T14:10:00Z"
                     *     }
                     */
                    "application/json": components["schemas"]["Reserva"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            409: components["responses"]["Conflicto"];
            503: components["responses"]["NoDisponible"];
        };
    };
    listarReservasInterna: {
        parameters: {
            query: {
                /**
                 * @description Usuario dueño de las reservas. Tiene que ser el mismo del JWT.
                 * @example 3b6f0c2e-5d1a-4c8e-9f7b-1a2b3c4d5e6f
                 */
                usuarioId: string;
                /**
                 * @description Filtra por estado de la reserva.
                 * @example confirmada
                 */
                estado?: components["schemas"]["EstadoReserva"];
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
            /** @description Reservas del usuario. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListaReservas"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            503: components["responses"]["NoDisponible"];
        };
    };
    consultarDuenoViaje: {
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
                 * @description Identificador del viaje.
                 * @example 9a1d7c3e-2b4f-4e6a-8c0d-5f1e2a3b4c5d
                 */
                viajeId: components["parameters"]["ViajeId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Resultado de la consulta. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "viajeId": "9a1d7c3e-2b4f-4e6a-8c0d-5f1e2a3b4c5d",
                     *       "esDueno": true
                     *     }
                     */
                    "application/json": components["schemas"]["DuenoViaje"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            404: components["responses"]["NoEncontrado"];
            503: components["responses"]["NoDisponible"];
        };
    };
    obtenerReservaPorNumeroInterna: {
        parameters: {
            query: {
                /**
                 * @description Identificador del proveedor de la reserva.
                 * @example aerolinea-andina
                 */
                proveedor: components["schemas"]["Proveedor"];
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
                 * @description Número o código de la reserva tal como lo emite el proveedor.
                 * @example XKQ7PL
                 */
                numeroReserva: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Reserva encontrada. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Reserva"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            404: components["responses"]["NoEncontrado"];
            503: components["responses"]["NoDisponible"];
        };
    };
    listarUsuariosConViajeProximo: {
        parameters: {
            query?: {
                /**
                 * @description Ventana en días desde ahora.
                 * @example 7
                 */
                dias?: number;
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
            /** @description Usuarios con un viaje en curso o próximo. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "dias": 7,
                     *       "calculadoEn": "2026-12-05T03:00:00Z",
                     *       "usuarioIds": [
                     *         "3b6f0c2e-5d1a-4c8e-9f7b-1a2b3c4d5e6f",
                     *         "5d7e9f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a"
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["UsuariosConViajeProximo"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            503: components["responses"]["NoDisponible"];
        };
    };
    ejecutarArchivado: {
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
            /** @description La tarea terminó. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "viajesArchivados": 3,
                     *       "reservasArchivadas": 7,
                     *       "ejecutadoEn": "2026-12-15T03:00:00Z"
                     *     }
                     */
                    "application/json": components["schemas"]["ResultadoArchivado"];
                };
            };
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            409: components["responses"]["Conflicto"];
            503: components["responses"]["NoDisponible"];
        };
    };
}
