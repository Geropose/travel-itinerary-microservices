// Generado con npm run web:api desde specs/openapi/autenticacion.yaml. No editar a mano.
export interface paths {
    "/registro": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Registrar una cuenta nueva
         * @description Crea la cuenta en la región indicada en el cuerpo: guarda el email y el hash de la contraseña y crea también la cuenta en el Servicio de Usuarios con una llamada interna (nombre, región e idioma). El rol inicial es `usuario`. Si la región del cuerpo no es la de esta instancia, responde 307 hacia la otra región para que la cuenta se guarde en su región (CONST-6).
         */
        post: operations["registrarCuenta"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Iniciar sesión
         * @description Verifica el email y la contraseña y devuelve un JWT (15 minutos), un token de renovación (7 días) y la región de la cuenta, que la aplicación recuerda para los próximos inicios de sesión (Iteración 6). Si la cuenta no está en esta región pero sí en la otra (consulta a `GET /interna/cuentas/existe` de la otra región), responde 307 con la región correcta: pasa cuando se inicia sesión desde un dispositivo nuevo, que todavía no conoce su región. La aplicación manda la región que recuerda en `X-Region`, que usa el enrutador global para elegir la región (gateway.yaml).
         */
        post: operations["iniciarSesion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/renovar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Pedir un JWT nuevo con el token de renovación
         * @description Devuelve un JWT nuevo sin volver a pedir la contraseña, mientras el token de renovación siga vigente (7 días) y no se haya cerrado la sesión. Es pública porque el JWT anterior puede estar vencido.
         */
        post: operations["renovarJwt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cerrar sesión
         * @description Invalida el token de renovación indicado. El JWT vigente sigue sirviendo hasta que vence (como máximo 15 minutos, ADR-014). Es idempotente: si el token ya estaba invalidado responde 204 igual. Si el token es de otro usuario (no coincide con el `sub` del JWT) responde 403.
         */
        post: operations["cerrarSesion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/.well-known/jwks.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Obtener la clave pública para validar los JWT
         * @description Publica las claves públicas RS256 en formato JWKS (RFC 7517). Los validadores de intercepción del gateway y de cada servicio las descargan una vez (y de nuevo si aparece un `kid` desconocido) y verifican los JWT sin usar la red en cada solicitud (ADR-014, QA-9).
         */
        get: operations["obtenerClavesPublicas"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/interna/cuentas/existe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Indicar si la cuenta existe en esta región
         * @description La usa el Servicio de Autenticación de la otra región durante el inicio de sesión desde un dispositivo nuevo y el registro, para saber si una cuenta está en esta región (Iteración 6). Solo responde sí o no: no devuelve datos de la cuenta, así ningún dato personal sale de su región (CONST-6). No hay usuario autenticado todavía: lleva el token de servicio que emitió la Autenticación de la otra región (sub autenticacion, region de la otra región), y se valida con la clave pública de esa región (su /.well-known/jwks.json, descargada una vez). Solo acepta el servicio autenticacion.
         */
        get: operations["existeCuenta"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/interna/tokens-servicio": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Emitir un token de servicio
         * @description Emite el token de servicio (tokenServicio en comun.yaml) que usan las rutas internas sin usuario: el registro, las tareas programadas y las pruebas. El servicio que llama manda su nombre y su secreto (variable de entorno SECRETO_SERVICIO_<SERVICIO>, distinta en cada región; en el repositorio solo va un valor de ejemplo en .env.example). El servicio pruebas solo existe si está definida SECRETO_SERVICIO_PRUEBAS (entorno local y CI). El token dura 5 minutos; quien llama lo guarda y pide otro cuando está por vencer. La Autenticación no se llama a sí misma: firma sus propios tokens de servicio. Si el nombre o el secreto no coinciden responde 401 y lo publica como AccesoRechazado.
         */
        post: operations["emitirTokenServicio"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Consultar el estado del servicio
         * @description Responde 200 si el servicio puede atender (base de datos conectada y claves de firma cargadas) y 503 si no. Lo usa el monitor de salud (ADR-007).
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
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * Format: email
         * @example ana@correo.example
         */
        Email: string;
        /**
         * @description Contraseña en texto plano; solo viaja por HTTPS y se guarda con hash (ADR-014).
         * @example viajar-es-lindo-2026
         */
        Contrasena: string;
        /** @description JWT firmado con RS256. Claims: sub (usuarioId), region, roles, idioma, exp (15 minutos). */
        Jwt: string;
        /** @description Token opaco en base64url, válido 7 días. El servicio guarda solo su hash. */
        TokenRenovacion: string;
        SolicitudRegistro: {
            email: components["schemas"]["Email"];
            contrasena: components["schemas"]["Contrasena"];
            /** @example Ana Pérez */
            nombre: string;
            region: components["schemas"]["Region"];
            idioma: components["schemas"]["Idioma"];
        };
        CuentaCreada: {
            /**
             * Format: uuid
             * @example 3fa85f64-5717-4562-b3fc-2c963f66afa6
             */
            usuarioId: string;
        };
        SolicitudLogin: {
            email: components["schemas"]["Email"];
            contrasena: components["schemas"]["Contrasena"];
        };
        Sesion: {
            jwt: components["schemas"]["Jwt"];
            tokenRenovacion: components["schemas"]["TokenRenovacion"];
            region: components["schemas"]["Region"];
        };
        SolicitudRenovacion: {
            tokenRenovacion: components["schemas"]["TokenRenovacion"];
        };
        JwtRenovado: {
            jwt: components["schemas"]["Jwt"];
        };
        RedireccionRegion: {
            region: components["schemas"]["Region"];
        };
        /** @description JSON Web Key Set (RFC 7517) con las claves públicas de firma. */
        Jwks: {
            keys: components["schemas"]["ClavePublica"][];
        };
        /** @description Clave pública RSA en formato JWK. */
        ClavePublica: {
            /** @constant */
            kty: "RSA";
            /** @constant */
            use: "sig";
            /** @constant */
            alg: "RS256";
            /**
             * @description Identificador de la clave; viaja en el encabezado del JWT.
             * @example r1-2026-11
             */
            kid: string;
            /** @description Módulo RSA en base64url. */
            n: string;
            /**
             * @description Exponente RSA en base64url.
             * @example AQAB
             */
            e: string;
        };
        SolicitudTokenServicio: {
            /**
             * @description Servicio que pide el token. Va en el claim sub.
             * @enum {string}
             */
            servicio: "autenticacion" | "usuarios" | "correo" | "viajes" | "integraciones" | "analitica" | "asistente" | "gateway" | "pruebas";
            /** @description Secreto del servicio (SECRETO_SERVICIO_<SERVICIO>). */
            secreto: string;
        };
        TokenServicioEmitido: {
            tokenServicio: components["schemas"]["Jwt"];
            /**
             * @description Segundos hasta que vence (5 minutos).
             * @constant
             */
            expiraEn: 300;
        };
        ExistenciaCuenta: {
            /** @example true */
            existe: boolean;
            /** @description Región que responde (la de esta instancia). */
            region: components["schemas"]["Region"];
        };
        /** @enum {string} */
        Region: "region-1" | "region-2";
        /** @enum {string} */
        Idioma: "es" | "en";
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
        Salud: {
            /**
             * @example ok
             * @enum {string}
             */
            estado: "ok" | "degradado";
        };
    };
    responses: {
        /** @description La cuenta (o la región pedida en el registro) es de la otra región. `Location` apunta a la misma ruta en la región correcta; el cliente repite la solicitud ahí con el mismo cuerpo y recuerda la región para los próximos inicios de sesión (Iteración 6). */
        OtraRegion: {
            headers: {
                /**
                 * @description URL de la misma operación en la región correcta.
                 * @example http://localhost:8082/api/autenticacion/login
                 */
                Location: string;
                "X-Request-Id": components["headers"]["XRequestId"];
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "region": "region-2"
                 *     }
                 */
                "application/json": components["schemas"]["RedireccionRegion"];
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
        /** @description El servicio puede atender (base y broker conectados). */
        Salud: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Salud"];
            };
        };
    };
    parameters: {
        /**
         * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
         * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
         */
        XRequestId: string;
        /**
         * @description Región de la cuenta que la aplicación recuerda del último inicio de sesión o registro (Iteración 6). La lee solo el enrutador global para elegir la región cuando todavía no hay JWT. Si no viene (dispositivo nuevo), va a la región por defecto y, si la cuenta es de la otra, la respuesta es 307.
         * @example region-1
         */
        XRegion: components["schemas"]["Region"];
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
    registrarCuenta: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
                 * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
                 */
                "X-Request-Id"?: components["parameters"]["XRequestId"];
                /**
                 * @description Región de la cuenta que la aplicación recuerda del último inicio de sesión o registro (Iteración 6). La lee solo el enrutador global para elegir la región cuando todavía no hay JWT. Si no viene (dispositivo nuevo), va a la región por defecto y, si la cuenta es de la otra, la respuesta es 307.
                 * @example region-1
                 */
                "X-Region"?: components["parameters"]["XRegion"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "email": "ana@correo.example",
                 *       "contrasena": "viajar-es-lindo-2026",
                 *       "nombre": "Ana Pérez",
                 *       "region": "region-1",
                 *       "idioma": "es"
                 *     }
                 */
                "application/json": components["schemas"]["SolicitudRegistro"];
            };
        };
        responses: {
            /** @description Cuenta creada. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "usuarioId": "3fa85f64-5717-4562-b3fc-2c963f66afa6"
                     *     }
                     */
                    "application/json": components["schemas"]["CuentaCreada"];
                };
            };
            307: components["responses"]["OtraRegion"];
            400: components["responses"]["SolicitudInvalida"];
            /** @description Ya existe una cuenta con ese email (en esta región o en la otra). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/conflicto",
                     *       "title": "El email ya está registrado",
                     *       "status": 409,
                     *       "detail": "Ya existe una cuenta con ese email.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            503: components["responses"]["NoDisponible"];
        };
    };
    iniciarSesion: {
        parameters: {
            query?: never;
            header?: {
                /**
                 * @description Identificador de la solicitud. Si no viene, el gateway lo crea y lo propaga.
                 * @example 7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c
                 */
                "X-Request-Id"?: components["parameters"]["XRequestId"];
                /**
                 * @description Región de la cuenta que la aplicación recuerda del último inicio de sesión o registro (Iteración 6). La lee solo el enrutador global para elegir la región cuando todavía no hay JWT. Si no viene (dispositivo nuevo), va a la región por defecto y, si la cuenta es de la otra, la respuesta es 307.
                 * @example region-1
                 */
                "X-Region"?: components["parameters"]["XRegion"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "email": "ana@correo.example",
                 *       "contrasena": "viajar-es-lindo-2026"
                 *     }
                 */
                "application/json": components["schemas"]["SolicitudLogin"];
            };
        };
        responses: {
            /** @description Sesión iniciada. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "jwt": "eyJhbGciOiJSUzI1NiIsImtpZCI6InIxLTIwMjYtMTEifQ.eyJzdWIiOiIzZmE4NWY2NC01NzE3LTQ1NjItYjNmYy0yYzk2M2Y2NmFmYTYiLCJyZWdpb24iOiJyZWdpb24tMSIsInJvbGVzIjpbInVzdWFyaW8iXSwiaWRpb21hIjoiZXMiLCJleHAiOjE3OTU2OTAzMDB9.c2lnbmF0dXJh",
                     *       "tokenRenovacion": "Qm9yZGVyLXRva2VuLWRlLXJlbm92YWNpb24tZWplbXBsbw",
                     *       "region": "region-1"
                     *     }
                     */
                    "application/json": components["schemas"]["Sesion"];
                };
            };
            307: components["responses"]["OtraRegion"];
            400: components["responses"]["SolicitudInvalida"];
            /** @description El email o la contraseña son incorrectos, o la cuenta no existe en ninguna región. No se indica cuál de los dos falló. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/credenciales-incorrectas",
                     *       "title": "Credenciales incorrectas",
                     *       "status": 401,
                     *       "detail": "El email o la contraseña no son correctos.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            /** @description Demasiados intentos fallidos con ese email: 5 en 15 minutos (QA-8). No se verifica la contraseña hasta que pase el tiempo indicado en `Retry-After`. */
            429: {
                headers: {
                    /**
                     * @description Segundos que hay que esperar para volver a intentar.
                     * @example 840
                     */
                    "Retry-After"?: number;
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/demasiados-intentos",
                     *       "title": "Demasiados intentos",
                     *       "status": 429,
                     *       "detail": "Hubo 5 intentos fallidos con ese email. Probá de nuevo en 14 minutos.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            503: components["responses"]["NoDisponible"];
        };
    };
    renovarJwt: {
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
                 *       "tokenRenovacion": "Qm9yZGVyLXRva2VuLWRlLXJlbm92YWNpb24tZWplbXBsbw"
                 *     }
                 */
                "application/json": components["schemas"]["SolicitudRenovacion"];
            };
        };
        responses: {
            /** @description JWT nuevo. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "jwt": "eyJhbGciOiJSUzI1NiIsImtpZCI6InIxLTIwMjYtMTEifQ.eyJzdWIiOiIzZmE4NWY2NC01NzE3LTQ1NjItYjNmYy0yYzk2M2Y2NmFmYTYiLCJyZWdpb24iOiJyZWdpb24tMSIsInJvbGVzIjpbInVzdWFyaW8iXSwiaWRpb21hIjoiZXMiLCJleHAiOjE3OTU2OTEyMDB9.c2lnbmF0dXJh"
                     *     }
                     */
                    "application/json": components["schemas"]["JwtRenovado"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            /** @description El token de renovación no existe, venció o ya se cerró la sesión. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/token-renovacion-invalido",
                     *       "title": "Token de renovación inválido",
                     *       "status": 401,
                     *       "detail": "El token de renovación venció. Hay que iniciar sesión de nuevo.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            503: components["responses"]["NoDisponible"];
        };
    };
    cerrarSesion: {
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
                 *       "tokenRenovacion": "Qm9yZGVyLXRva2VuLWRlLXJlbm92YWNpb24tZWplbXBsbw"
                 *     }
                 */
                "application/json": components["schemas"]["SolicitudRenovacion"];
            };
        };
        responses: {
            /** @description Sesión cerrada; el token de renovación ya no sirve. */
            204: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            503: components["responses"]["NoDisponible"];
        };
    };
    obtenerClavesPublicas: {
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
            /** @description Claves públicas vigentes. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    /**
                     * @description Cuánto tiempo pueden guardar las claves los validadores.
                     * @example public, max-age=3600
                     */
                    "Cache-Control"?: string;
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "keys": [
                     *         {
                     *           "kty": "RSA",
                     *           "use": "sig",
                     *           "alg": "RS256",
                     *           "kid": "r1-2026-11",
                     *           "n": "u1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunVTLw7onLRnrq0_IzW7yWR7QkrmBL7jTKEn5u-qKhbwKfBstIs-bMY2Zkp18gnTxKLxoS2tFczGkPLPgizskuemMghRniWaoLcyehkd3qqGElvW_VDL5AaWTg0nLVkjRo9z-40RQzuVaE8AkAFmxZzow3x-VJYKdjykkJ0iT9wCS0DRTXu269V264Vf_3jvredZiKRkgwlL9xNAwxXFg0x_XFw005UWVRIkdgcKWTjpBP2dPwVZ4WWC-9aGVd-Gyn1o0CLelf4rEjGoXbAAEgAqeGUxrcIlbjXfbcmw",
                     *           "e": "AQAB"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["Jwks"];
                };
            };
            503: components["responses"]["NoDisponible"];
        };
    };
    existeCuenta: {
        parameters: {
            query: {
                /**
                 * @description Email de la cuenta que se busca.
                 * @example ana@correo.example
                 */
                email: components["schemas"]["Email"];
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
            /** @description Resultado de la búsqueda en esta región. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "existe": true,
                     *       "region": "region-2"
                     *     }
                     */
                    "application/json": components["schemas"]["ExistenciaCuenta"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            503: components["responses"]["NoDisponible"];
        };
    };
    emitirTokenServicio: {
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
                 *       "servicio": "correo",
                 *       "secreto": "secreto-de-ejemplo-correo-0123456789"
                 *     }
                 */
                "application/json": components["schemas"]["SolicitudTokenServicio"];
            };
        };
        responses: {
            /** @description Token emitido. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "tokenServicio": "eyJhbGciOiJSUzI1NiIsImtpZCI6InIxLTIwMjYtMTEifQ.eyJzdWIiOiJjb3JyZW8iLCJyb2xlcyI6WyJzZXJ2aWNpbyJdLCJyZWdpb24iOiJyZWdpb24tMSJ9.ZmlybWE",
                     *       "expiraEn": 300
                     *     }
                     */
                    "application/json": components["schemas"]["TokenServicioEmitido"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            503: components["responses"]["NoDisponible"];
        };
    };
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
}
