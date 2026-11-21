// Generado con npm run web:api desde specs/openapi/usuarios.yaml. No editar a mano.
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
         * @description Responde 200 si el servicio puede atender (base y broker conectados) y 503 si no. Lo consulta el monitor de salud (ADR-007).
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
    "/perfil": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Perfil del usuario autenticado
         * @description Devuelve el perfil del usuario del JWT (claim sub). Solo el propio usuario lo ve.
         */
        get: operations["obtenerPerfil"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Cambiar las preferencias del usuario
         * @description Cambia solo los campos enviados (al menos uno). agenciaPreferida tiene que ser una de las agencias configuradas en Integraciones; null la quita. Si cambia el idioma, en la misma transacción guarda el evento IdiomaActualizado en el outbox (specs/asyncapi/eventos.yaml, datos según specs/schemas/IdiomaActualizado.json): Autenticación lo guarda en la credencial y el cambio se refleja en el claim idioma del JWT recién cuando se renueva o en el próximo login.
         */
        patch: operations["actualizarPerfil"];
        trace?: never;
    };
    "/whitelist": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Whitelist de remitentes del usuario
         * @description Devuelve la lista de remitentes permitidos y si los filtros están activos. Si el usuario nunca la guardó, responde la lista vacía con filtrosActivos en false.
         */
        get: operations["obtenerWhitelist"];
        /**
         * Reemplazar la whitelist de remitentes
         * @description Reemplaza la lista completa de remitentes permitidos y el estado de los filtros (UC-2). En la misma transacción guarda el evento FiltrosActualizados en el outbox (specs/asyncapi/eventos.yaml, datos según specs/schemas/FiltrosActualizados.json: usuarioId, remitentesPermitidos y filtrosActivos, con la lista completa); el filtro de remitentes del Servicio de Correo lo consume. Cada remitente es una dirección completa (reservas@aerolinea.example) o un dominio (@aerolinea.example) y se guarda en minúscula.
         */
        put: operations["guardarWhitelist"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/itinerarios/{viajeId}/designados": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /**
                 * @description Viaje (itinerario) del Servicio de Viajes.
                 * @example 9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e
                 */
                viajeId: components["parameters"]["ViajeId"];
            };
            cookie?: never;
        };
        /**
         * Personas designadas para ver un itinerario
         * @description Lista las personas que pueden ver el itinerario del viaje. Solo lo consulta el dueño del viaje; cualquier otro recibe 403 y el intento queda en el registro de accesos (QA-9). Para saber si quien llama es el dueño, Usuarios consulta a Viajes (GET /interna/viajes/{viajeId}/dueno, con el JWT del usuario propagado, ADR-019); si Viajes no responde, responde 503 y no deja pasar.
         */
        get: operations["listarDesignados"];
        put?: never;
        /**
         * Designar a una persona para ver el itinerario
         * @description El dueño del viaje designa a una persona por email. Si esa persona ya tiene cuenta en la región, se guarda su usuarioId; si no, usuarioId queda en null hasta que se registre. No se puede designar al propio dueño (400) ni a alguien ya designado (409). Si quien llama no es el dueño, 403. Para saber si quien llama es el dueño, Usuarios consulta a Viajes (GET /interna/viajes/{viajeId}/dueno, con el JWT del usuario propagado, ADR-019); si Viajes no responde, responde 503 y no deja pasar.
         */
        post: operations["designarPersona"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/itinerarios/{viajeId}/designados/{email}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /**
                 * @description Viaje (itinerario) del Servicio de Viajes.
                 * @example 9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e
                 */
                viajeId: components["parameters"]["ViajeId"];
                /**
                 * @description Email de la persona designada (con la @ codificada como %40 si hace falta).
                 * @example juan@correo.example
                 */
                email: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Quitar a una persona designada
         * @description El dueño del viaje le quita el permiso a una persona. Desde ese momento la consulta interna de permisos responde que no puede ver el itinerario. Si quien llama no es el dueño, 403. Para saber si quien llama es el dueño, Usuarios consulta a Viajes (GET /interna/viajes/{viajeId}/dueno, con el JWT del usuario propagado, ADR-019); si Viajes no responde, responde 503 y no deja pasar.
         */
        delete: operations["quitarDesignado"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/interna/permisos/itinerarios/{viajeId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /**
                 * @description Viaje (itinerario) del Servicio de Viajes.
                 * @example 9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e
                 */
                viajeId: components["parameters"]["ViajeId"];
            };
            cookie?: never;
        };
        /**
         * Si un usuario puede ver un itinerario
         * @description La usa el Servicio de Viajes en GET /viajes/{viajeId} cuando quien pide no es el dueño del viaje (el dueño lo resuelve Viajes con sus propios datos; Usuarios no sabe de quién es cada viaje). Responde puedeVer true si el usuario es una persona designada del itinerario. Tiene que responder rápido (índice por viajeId y usuario; la Iteración 5 estima 20 ms) y el que llama la corta a los 2 s. Recibe el JWT del usuario propagado (ADR-019): usuarioId tiene que ser el sub del token, si no responde 403. Un viaje desconocido no es un error: responde puedeVer false.
         */
        get: operations["consultarPermisoItinerario"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/interna/cuentas": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Crear la cuenta de un usuario recién registrado
         * @description La llama el Servicio de Autenticación en POST /registro, después de crear la credencial. Si responde un error, Autenticación deshace el registro. No hay JWT del usuario todavía (se está registrando): lleva el token de servicio y solo acepta el servicio autenticacion. La cuenta se crea con moneda USD, sin agencia preferida y con la whitelist vacía y los filtros inactivos. La región tiene que ser la de este servicio (CONST-6), si no responde 400.
         */
        post: operations["crearCuenta"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/interna/usuarios/{usuarioId}/agencia": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /**
                 * @description Usuario del que se pide la agencia preferida.
                 * @example 3fa85f64-5717-4562-b3fc-2c963f66afa6
                 */
                usuarioId: string;
            };
            cookie?: never;
        };
        /**
         * Agencia preferida de un usuario
         * @description La usa el plug-in de derivación del Asistente Virtual para mandar el problema a la agencia del usuario a través de Integraciones (Iteración 7). Recibe el JWT del usuario propagado (ADR-019): usuarioId tiene que ser el sub del token, si no responde 403. Si el usuario no eligió agencia, agenciaPreferida es null.
         */
        get: operations["obtenerAgenciaPreferida"];
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
         * @description Código de moneda ISO 4217 en mayúsculas.
         * @example ARS
         */
        Moneda: string;
        /**
         * @description Identificador de la agencia de viajes, el mismo que usa la configuración de Integraciones.
         * @example viajes-del-plata
         */
        Agencia: string;
        /**
         * @description Dirección completa (reservas@aerolinea.example) o dominio entero (@aerolinea.example). Mismo patrón que FiltrosActualizados.remitentesPermitidos.
         * @example @aerolinea-andina.example
         */
        Remitente: string;
        /** @description Cuenta y preferencias del usuario. */
        Perfil: {
            /** Format: uuid */
            usuarioId: string;
            /** Format: email */
            email: string;
            nombre: string;
            region: components["schemas"]["Region"];
            idioma: components["schemas"]["Idioma"];
            moneda: components["schemas"]["Moneda"];
            /** @description Agencia preferida, o null si no eligió ninguna. */
            agenciaPreferida: components["schemas"]["Agencia"] | null;
            /** Format: date-time */
            creadoEn: string;
        };
        /** @description Campos del perfil que el usuario puede cambiar. Al menos uno. */
        CambioPerfil: {
            nombre?: string;
            idioma?: components["schemas"]["Idioma"];
            moneda?: components["schemas"]["Moneda"];
            /** @description Agencia configurada en Integraciones, o null para quitarla. */
            agenciaPreferida?: components["schemas"]["Agencia"] | null;
        };
        /** @description Datos que manda Autenticación al registrar a un usuario. */
        NuevaCuenta: {
            /**
             * Format: uuid
             * @description El mismo usuarioId de la credencial (claim sub del JWT).
             */
            usuarioId: string;
            /** Format: email */
            email: string;
            nombre: string;
            region: components["schemas"]["Region"];
            idioma: components["schemas"]["Idioma"];
        };
        /** @description Filtros y whitelist de remitentes del usuario. */
        Whitelist: {
            /** Format: uuid */
            usuarioId: string;
            remitentesPermitidos: components["schemas"]["Remitente"][];
            /** @description Si es true, el Servicio de Correo solo procesa los correos de remitentes permitidos; si es false, procesa todos. */
            filtrosActivos: boolean;
            /** @description Último cambio, o null si el usuario nunca la guardó. */
            actualizadoEn: string | null;
        };
        /** @description Lista completa que reemplaza a la anterior (no es una diferencia). */
        CambioWhitelist: {
            remitentesPermitidos: components["schemas"]["Remitente"][];
            filtrosActivos: boolean;
        };
        NuevoDesignado: {
            /**
             * Format: email
             * @description Email de la persona que va a poder ver el itinerario.
             */
            email: string;
        };
        /** @description Persona designada para ver un itinerario. */
        Designado: {
            /** Format: email */
            email: string;
            /** @description Cuenta de la persona en esta región, o null si todavía no se registró. */
            usuarioId: string | null;
            /** Format: date-time */
            designadoEn: string;
        };
        ListaDesignados: {
            /** Format: uuid */
            viajeId: string;
            designados: components["schemas"]["Designado"][];
        };
        /** @description Respuesta del permiso de itinerario para el Validador de Intercepción. */
        PermisoItinerario: {
            /** Format: uuid */
            viajeId: string;
            /** Format: uuid */
            usuarioId: string;
            puedeVer: boolean;
            /**
             * @description Por qué puede (o no) verlo. "ninguno" va con puedeVer false; el validador lo usa como motivo en el registro de accesos. No existe "dueno": Usuarios no sabe de quién es cada viaje, eso lo resuelve Viajes.
             * @enum {string}
             */
            motivo: "designado" | "ninguno";
        };
        AgenciaPreferida: {
            /** Format: uuid */
            usuarioId: string;
            /** @description Agencia preferida, o null si el usuario no eligió ninguna. */
            agenciaPreferida: components["schemas"]["Agencia"] | null;
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
        Region: "region-1" | "region-2";
        /** @enum {string} */
        Idioma: "es" | "en";
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
         * @description Viaje (itinerario) del Servicio de Viajes.
         * @example 9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e
         */
        ViajeId: string;
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
    obtenerPerfil: {
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
            /** @description Perfil del usuario. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "usuarioId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                     *       "email": "ana@correo.example",
                     *       "nombre": "Ana Pérez",
                     *       "region": "region-1",
                     *       "idioma": "es",
                     *       "moneda": "ARS",
                     *       "agenciaPreferida": "viajes-del-plata",
                     *       "creadoEn": "2026-11-01T12:00:00Z"
                     *     }
                     */
                    "application/json": components["schemas"]["Perfil"];
                };
            };
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            503: components["responses"]["NoDisponible"];
        };
    };
    actualizarPerfil: {
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
                 *       "idioma": "en",
                 *       "moneda": "USD",
                 *       "agenciaPreferida": "viajes-del-plata"
                 *     }
                 */
                "application/json": components["schemas"]["CambioPerfil"];
            };
        };
        responses: {
            /** @description Perfil actualizado. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "usuarioId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                     *       "email": "ana@correo.example",
                     *       "nombre": "Ana Pérez",
                     *       "region": "region-1",
                     *       "idioma": "en",
                     *       "moneda": "USD",
                     *       "agenciaPreferida": "viajes-del-plata",
                     *       "creadoEn": "2026-11-01T12:00:00Z"
                     *     }
                     */
                    "application/json": components["schemas"]["Perfil"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            503: components["responses"]["NoDisponible"];
        };
    };
    obtenerWhitelist: {
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
            /** @description Whitelist del usuario. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "usuarioId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                     *       "remitentesPermitidos": [
                     *         "reservas@aerolinea-andina.example",
                     *         "@hotel-cordillera.example"
                     *       ],
                     *       "filtrosActivos": true,
                     *       "actualizadoEn": "2026-11-10T09:30:00Z"
                     *     }
                     */
                    "application/json": components["schemas"]["Whitelist"];
                };
            };
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            503: components["responses"]["NoDisponible"];
        };
    };
    guardarWhitelist: {
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
                 *       "remitentesPermitidos": [
                 *         "reservas@aerolinea-andina.example",
                 *         "@hotel-cordillera.example",
                 *         "@rentadora-sur.example"
                 *       ],
                 *       "filtrosActivos": true
                 *     }
                 */
                "application/json": components["schemas"]["CambioWhitelist"];
            };
        };
        responses: {
            /** @description Whitelist guardada. El evento FiltrosActualizados queda en el outbox. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "usuarioId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                     *       "remitentesPermitidos": [
                     *         "reservas@aerolinea-andina.example",
                     *         "@hotel-cordillera.example",
                     *         "@rentadora-sur.example"
                     *       ],
                     *       "filtrosActivos": true,
                     *       "actualizadoEn": "2026-11-16T22:10:00Z"
                     *     }
                     */
                    "application/json": components["schemas"]["Whitelist"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            503: components["responses"]["NoDisponible"];
        };
    };
    listarDesignados: {
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
                 * @description Viaje (itinerario) del Servicio de Viajes.
                 * @example 9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e
                 */
                viajeId: components["parameters"]["ViajeId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Designados del itinerario (puede ser una lista vacía). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "viajeId": "9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e",
                     *       "designados": [
                     *         {
                     *           "email": "juan@correo.example",
                     *           "usuarioId": "6c1e8a2f-4b3d-4e5f-9a0b-1c2d3e4f5a6b",
                     *           "designadoEn": "2026-11-12T18:00:00Z"
                     *         },
                     *         {
                     *           "email": "maria@correo.example",
                     *           "usuarioId": null,
                     *           "designadoEn": "2026-11-13T10:15:00Z"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["ListaDesignados"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            503: components["responses"]["NoDisponible"];
        };
    };
    designarPersona: {
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
                 * @description Viaje (itinerario) del Servicio de Viajes.
                 * @example 9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e
                 */
                viajeId: components["parameters"]["ViajeId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "email": "juan@correo.example"
                 *     }
                 */
                "application/json": components["schemas"]["NuevoDesignado"];
            };
        };
        responses: {
            /** @description Persona designada. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "email": "juan@correo.example",
                     *       "usuarioId": "6c1e8a2f-4b3d-4e5f-9a0b-1c2d3e4f5a6b",
                     *       "designadoEn": "2026-11-12T18:00:00Z"
                     *     }
                     */
                    "application/json": components["schemas"]["Designado"];
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
    quitarDesignado: {
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
                 * @description Viaje (itinerario) del Servicio de Viajes.
                 * @example 9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e
                 */
                viajeId: components["parameters"]["ViajeId"];
                /**
                 * @description Email de la persona designada (con la @ codificada como %40 si hace falta).
                 * @example juan@correo.example
                 */
                email: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Designado quitado. */
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
            503: components["responses"]["NoDisponible"];
        };
    };
    consultarPermisoItinerario: {
        parameters: {
            query: {
                /**
                 * @description Usuario que quiere ver el itinerario.
                 * @example 6c1e8a2f-4b3d-4e5f-9a0b-1c2d3e4f5a6b
                 */
                usuarioId: string;
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
                 * @description Viaje (itinerario) del Servicio de Viajes.
                 * @example 9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e
                 */
                viajeId: components["parameters"]["ViajeId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Resultado de la consulta de permiso. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "viajeId": "9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e",
                     *       "usuarioId": "6c1e8a2f-4b3d-4e5f-9a0b-1c2d3e4f5a6b",
                     *       "puedeVer": true,
                     *       "motivo": "designado"
                     *     }
                     */
                    "application/json": components["schemas"]["PermisoItinerario"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            503: components["responses"]["NoDisponible"];
        };
    };
    crearCuenta: {
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
                 *       "usuarioId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                 *       "email": "ana@correo.example",
                 *       "nombre": "Ana Pérez",
                 *       "region": "region-1",
                 *       "idioma": "es"
                 *     }
                 */
                "application/json": components["schemas"]["NuevaCuenta"];
            };
        };
        responses: {
            /** @description Cuenta creada. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "usuarioId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                     *       "email": "ana@correo.example",
                     *       "nombre": "Ana Pérez",
                     *       "region": "region-1",
                     *       "idioma": "es",
                     *       "moneda": "USD",
                     *       "agenciaPreferida": null,
                     *       "creadoEn": "2026-11-16T22:00:00Z"
                     *     }
                     */
                    "application/json": components["schemas"]["Perfil"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            409: components["responses"]["Conflicto"];
            503: components["responses"]["NoDisponible"];
        };
    };
    obtenerAgenciaPreferida: {
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
                 * @description Usuario del que se pide la agencia preferida.
                 * @example 3fa85f64-5717-4562-b3fc-2c963f66afa6
                 */
                usuarioId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Agencia preferida del usuario. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "usuarioId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                     *       "agenciaPreferida": "viajes-del-plata"
                     *     }
                     */
                    "application/json": components["schemas"]["AgenciaPreferida"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            503: components["responses"]["NoDisponible"];
        };
    };
}
