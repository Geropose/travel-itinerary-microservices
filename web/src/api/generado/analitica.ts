// Generado con npm run web:api desde specs/openapi/analitica.yaml. No editar a mano.
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
         * @description Pública, sin JWT. Responde 200 si el servicio puede atender (base de analítica y broker conectados) y 503 si no (docs/CONVENCIONES.md 4.3).
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
    "/consultas/destinos": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Destinos más reservados
         * @description Requiere un JWT con el rol analista; si no lo tiene, responde 403 (Prohibido). Cuenta las reservas (por codigoReserva) cuyo inicio cae entre desde y hasta, ambos incluidos, y que no están canceladas, agrupadas por destino y ordenadas de mayor a menor. Junta los datos de todas las regiones.
         */
        get: operations["consultarDestinos"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/consultas/cancelaciones": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Tasa de cancelación por proveedor o destino
         * @description Requiere un JWT con el rol analista; si no lo tiene, responde 403 (Prohibido). Toma las reservas (por codigoReserva) cuyo inicio cae entre desde y hasta, ambos incluidos, las agrupa por proveedor o por destino y calcula qué parte quedó en estado cancelada. Junta los datos de todas las regiones.
         */
        get: operations["consultarCancelaciones"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/consultas/tendencias": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Reservas por mes
         * @description Requiere un JWT con el rol analista; si no lo tiene, responde 403 (Prohibido). Cuenta las reservas (por codigoReserva) cuyo inicio cae en cada mes del año pedido, con el detalle por tipo de reserva y cuántas quedaron canceladas. Devuelve los 12 meses, aunque alguno tenga cero reservas. Junta los datos de todas las regiones.
         */
        get: operations["consultarTendencias"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/consultas/{tipo}/ejecutar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Lanzar una consulta pesada con Map-Reduce
         * @description Requiere un JWT con el rol analista; si no lo tiene, responde 403 (Prohibido). Lanza la consulta del tipo pedido en segundo plano: los procesadores Map-Reduce se encienden, recorren bloques de la base de analítica en paralelo (map), juntan los resultados parciales (reduce) y se apagan al terminar (Iteración 6, táctica 3). Responde enseguida con 202 y el consultaId; el estado y el resultado se piden a GET /consultas/ejecuciones/{consultaId}. El cuerpo tiene que ser el del tipo de la ruta (destinos, cancelaciones o tendencias); si no coincide, responde 400. Si ya hay una ejecución en curso del mismo tipo con los mismos parámetros, responde 409 y no lanza otra (los procesadores cuestan mientras corren).
         */
        post: operations["ejecutarConsulta"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/consultas/ejecuciones/{consultaId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Estado y resultado de una consulta pesada
         * @description Requiere un JWT con el rol analista; si no lo tiene, responde 403 (Prohibido). Devuelve el estado de la ejecución, cuántos procesadores Map-Reduce usa, cuánto tardó y, cuando terminó, el resultado (con el mismo formato que la consulta en el momento del mismo tipo). Si el consultaId no existe, responde 404.
         */
        get: operations["obtenerEjecucion"];
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
        /** @example 2025 */
        Anio: number;
        /** @description Valor entre 0 y 1. */
        Proporcion: number;
        /** @enum {string} */
        TipoConsulta: "destinos" | "cancelaciones" | "tendencias";
        /** @enum {string} */
        AgrupacionCancelaciones: "proveedor" | "destino";
        /**
         * @description Período de agrupación de tendencias (por defecto mes).
         * @enum {string}
         */
        AgrupacionTendencias: "mes";
        /** @description Cantidad de procesadores Map-Reduce a encender. Si no viene, el servicio la elige según el tamaño del período. El máximo de 50 sale de QA-5 (Iteración 6). */
        Procesadores: number;
        /**
         * @description pendiente: en cola, los procesadores todavía no arrancaron. enCurso: los procesadores están recorriendo los datos. terminada: hay resultado. fallida: no se pudo terminar (ver error).
         * @enum {string}
         */
        EstadoEjecucion: "pendiente" | "enCurso" | "terminada" | "fallida";
        ParametrosDestinos: {
            /** Format: date */
            desde: string;
            /** Format: date */
            hasta: string;
            /** @description Cantidad máxima de destinos a devolver (por defecto 10). */
            limite?: number;
            procesadores?: components["schemas"]["Procesadores"];
        };
        ParametrosCancelaciones: {
            /** Format: date */
            desde: string;
            /** Format: date */
            hasta: string;
            agruparPor: components["schemas"]["AgrupacionCancelaciones"];
            procesadores?: components["schemas"]["Procesadores"];
        };
        ParametrosTendencias: {
            anio: components["schemas"]["Anio"];
            agruparPor?: components["schemas"]["AgrupacionTendencias"];
            procesadores?: components["schemas"]["Procesadores"];
        };
        /** @description Parámetros de una consulta pesada. Son los mismos que los de la consulta en el momento del mismo tipo, más procesadores. El tipo de la ruta decide cuál de los tres corresponde. */
        ParametrosConsulta: components["schemas"]["ParametrosDestinos"] | components["schemas"]["ParametrosCancelaciones"] | components["schemas"]["ParametrosTendencias"];
        DestinoReservado: {
            /**
             * @description Destino de la fila anonimizada.
             * @example SCL
             */
            destino: string;
            /**
             * @description Reservas no canceladas con ese destino.
             * @example 1840
             */
            reservas: number;
            /**
             * @description Parte del total de reservas del período que va a ese destino.
             * @example 0.184
             */
            proporcion: components["schemas"]["Proporcion"];
        };
        ResultadoDestinos: {
            /** Format: date */
            desde: string;
            /** Format: date */
            hasta: string;
            /** @description Reservas no canceladas de todo el período, de todos los destinos. */
            totalReservas: number;
            /** @description Destinos ordenados de más a menos reservas, hasta el límite pedido. */
            destinos: components["schemas"]["DestinoReservado"][];
            /**
             * Format: date-time
             * @description Momento en que se calculó el resultado.
             */
            generadoEn: string;
        };
        TasaCancelacion: {
            /** @description Reservas del grupo, canceladas o no. */
            reservas: number;
            /** @description Reservas del grupo en estado cancelada. */
            canceladas: number;
            /** @description canceladas / reservas (0 si el grupo no tiene reservas). */
            tasaCancelacion: components["schemas"]["Proporcion"];
        };
        GrupoCancelaciones: {
            /**
             * @description Valor del campo agrupado (un proveedor o un destino).
             * @example aerolinea-andina
             */
            clave: string;
            reservas: number;
            canceladas: number;
            tasaCancelacion: components["schemas"]["Proporcion"];
        };
        ResultadoCancelaciones: {
            /** Format: date */
            desde: string;
            /** Format: date */
            hasta: string;
            agruparPor: components["schemas"]["AgrupacionCancelaciones"];
            total: components["schemas"]["TasaCancelacion"];
            /** @description Un elemento por proveedor o destino, ordenados de mayor a menor tasa. */
            grupos: components["schemas"]["GrupoCancelaciones"][];
            /** Format: date-time */
            generadoEn: string;
        };
        /** @description Reservas separadas por tipoReserva. */
        ReservasPorTipo: {
            vuelo: number;
            hotel: number;
            auto: number;
        };
        TendenciaMes: {
            mes: number;
            /** @description Reservas cuyo inicio cae en el mes, canceladas o no. */
            reservas: number;
            canceladas: number;
            porTipoReserva: components["schemas"]["ReservasPorTipo"];
        };
        ResultadoTendencias: {
            anio: components["schemas"]["Anio"];
            agruparPor: components["schemas"]["AgrupacionTendencias"];
            /** @description Los 12 meses del año, de enero a diciembre. */
            periodos: components["schemas"]["TendenciaMes"][];
            /** Format: date-time */
            generadoEn: string;
        };
        ConsultaLanzada: {
            /** Format: uuid */
            consultaId: string;
            tipo: components["schemas"]["TipoConsulta"];
            estado: components["schemas"]["EstadoEjecucion"];
            /** Format: date-time */
            creadaEn: string;
        };
        /** @description Estado de una consulta pesada. Según el estado vienen más campos: enCurso trae iniciadaEn; terminada trae iniciadaEn, terminadaEn, duracionMs y resultado; fallida trae terminadaEn, duracionMs y error. */
        Ejecucion: {
            /** Format: uuid */
            consultaId: string;
            tipo: components["schemas"]["TipoConsulta"];
            parametros: components["schemas"]["ParametrosConsulta"];
            estado: components["schemas"]["EstadoEjecucion"];
            /** @description Procesadores Map-Reduce asignados a la ejecución (0 mientras está pendiente). Al terminar, los que se usaron. */
            procesadores: number;
            /** @description Parte de los bloques de datos ya procesados. */
            progreso: components["schemas"]["Proporcion"];
            /** Format: date-time */
            creadaEn: string;
            /**
             * Format: date-time
             * @description Cuándo arrancaron los procesadores. No viene mientras está pendiente.
             */
            iniciadaEn?: string;
            /**
             * Format: date-time
             * @description Solo cuando está terminada o fallida.
             */
            terminadaEn?: string;
            /** @description Milisegundos entre iniciadaEn y terminadaEn. Solo cuando está terminada o fallida. */
            duracionMs?: number;
            /** @description Solo cuando está terminada. Mismo formato que la consulta en el momento del mismo tipo. */
            resultado?: components["schemas"]["ResultadoDestinos"] | components["schemas"]["ResultadoCancelaciones"] | components["schemas"]["ResultadoTendencias"];
            /** @description Motivo del fallo. Solo cuando está fallida. */
            error?: string;
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
    };
    responses: {
        /** @description Los parámetros o el cuerpo no cumplen el contrato (400): falta un parámetro, una fecha es inválida, hasta es anterior a desde, o el cuerpo no corresponde al tipo de la ruta. */
        ParametrosInvalidos: {
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
                 *           "campo": "hasta",
                 *           "mensaje": "tiene que ser igual o posterior a desde"
                 *         }
                 *       ]
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
         * @description Primer día del período, incluido. Se compara con el inicio de cada reserva.
         * @example 2025-01-01
         */
        Desde: string;
        /**
         * @description Último día del período, incluido. Tiene que ser igual o posterior a desde; si no, responde 400.
         * @example 2025-12-31
         */
        Hasta: string;
        /**
         * @description Cantidad máxima de destinos a devolver.
         * @example 10
         */
        Limite: number;
        /**
         * @description Año a analizar.
         * @example 2025
         */
        Anio: components["schemas"]["Anio"];
        /**
         * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
         * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
         */
        XRequestId: string;
    };
    requestBodies: never;
    headers: {
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
    consultarDestinos: {
        parameters: {
            query: {
                /**
                 * @description Primer día del período, incluido. Se compara con el inicio de cada reserva.
                 * @example 2025-01-01
                 */
                desde: components["parameters"]["Desde"];
                /**
                 * @description Último día del período, incluido. Tiene que ser igual o posterior a desde; si no, responde 400.
                 * @example 2025-12-31
                 */
                hasta: components["parameters"]["Hasta"];
                /**
                 * @description Cantidad máxima de destinos a devolver.
                 * @example 10
                 */
                limite?: components["parameters"]["Limite"];
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
            /** @description Destinos ordenados por cantidad de reservas. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResultadoDestinos"];
                };
            };
            400: components["responses"]["ParametrosInvalidos"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            503: components["responses"]["NoDisponible"];
        };
    };
    consultarCancelaciones: {
        parameters: {
            query: {
                /**
                 * @description Primer día del período, incluido. Se compara con el inicio de cada reserva.
                 * @example 2025-01-01
                 */
                desde: components["parameters"]["Desde"];
                /**
                 * @description Último día del período, incluido. Tiene que ser igual o posterior a desde; si no, responde 400.
                 * @example 2025-12-31
                 */
                hasta: components["parameters"]["Hasta"];
                /**
                 * @description Campo de la fila anonimizada por el que se agrupan las reservas.
                 * @example proveedor
                 */
                agruparPor: components["schemas"]["AgrupacionCancelaciones"];
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
            /** @description Tasa de cancelación de cada grupo y del total. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResultadoCancelaciones"];
                };
            };
            400: components["responses"]["ParametrosInvalidos"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            503: components["responses"]["NoDisponible"];
        };
    };
    consultarTendencias: {
        parameters: {
            query: {
                /**
                 * @description Año a analizar.
                 * @example 2025
                 */
                anio: components["parameters"]["Anio"];
                /**
                 * @description Período por el que se agrupan las reservas. Por ahora solo mes.
                 * @example mes
                 */
                agruparPor?: components["schemas"]["AgrupacionTendencias"];
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
            /** @description Reservas de cada mes del año. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResultadoTendencias"];
                };
            };
            400: components["responses"]["ParametrosInvalidos"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            503: components["responses"]["NoDisponible"];
        };
    };
    ejecutarConsulta: {
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
                 * @description Tipo de consulta a ejecutar.
                 * @example cancelaciones
                 */
                tipo: components["schemas"]["TipoConsulta"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ParametrosConsulta"];
            };
        };
        responses: {
            /** @description La consulta quedó en cola; se sigue su estado con el consultaId. */
            202: {
                headers: {
                    /**
                     * @description Ruta de la ejecución, para consultar su estado.
                     * @example /api/analitica/consultas/ejecuciones/3b9e2f4a-1c7d-4e8b-9a6f-5d2c1b0e9f8a
                     */
                    Location?: string;
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "consultaId": "3b9e2f4a-1c7d-4e8b-9a6f-5d2c1b0e9f8a",
                     *       "tipo": "cancelaciones",
                     *       "estado": "pendiente",
                     *       "creadaEn": "2026-11-20T14:00:00Z"
                     *     }
                     */
                    "application/json": components["schemas"]["ConsultaLanzada"];
                };
            };
            400: components["responses"]["ParametrosInvalidos"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            /** @description Ya hay una ejecución en curso del mismo tipo con los mismos parámetros (409). El detail indica su consultaId para seguirla. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/conflicto",
                     *       "title": "Consulta ya en curso",
                     *       "status": 409,
                     *       "detail": "Ya se está ejecutando la consulta 3b9e2f4a-1c7d-4e8b-9a6f-5d2c1b0e9f8a con los mismos parámetros.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            503: components["responses"]["NoDisponible"];
        };
    };
    obtenerEjecucion: {
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
                 * @description Identificador que devolvió POST /consultas/{tipo}/ejecutar.
                 * @example 3b9e2f4a-1c7d-4e8b-9a6f-5d2c1b0e9f8a
                 */
                consultaId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Estado de la ejecución y, si terminó, su resultado. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Ejecucion"];
                };
            };
            400: components["responses"]["ParametrosInvalidos"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            404: components["responses"]["NoEncontrado"];
            503: components["responses"]["NoDisponible"];
        };
    };
}
