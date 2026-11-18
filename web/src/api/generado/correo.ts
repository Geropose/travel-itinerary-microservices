// Generado con npm run web:api desde specs/openapi/correo.yaml. No editar a mano.
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
         * @description Responde 200 si el servicio puede atender (base y broker conectados) y 503 si no (docs/CONVENCIONES.md 4.3). Lo usa el monitor de salud (ADR-007).
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
    "/cuentas-correo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Cuentas de correo conectadas del usuario
         * @description Devuelve las cuentas de correo que el usuario del JWT conectó, con su estado y la fecha de la última revisión del buzón. Nunca devuelve los tokens (están encriptados, ADR-015).
         */
        get: operations["listarCuentasCorreo"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cuentas-correo/{proveedorCorreo}/conectar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Empezar a conectar una cuenta de correo
         * @description Arma la URL de la pantalla de permiso del proveedor con el scope de solo lectura (`gmail.readonly` en Gmail; `offline_access Mail.Read User.Read` en Outlook) y un `state` firmado por el Servicio de Correo. El `state` lleva el usuarioId, la región, el proveedor y un nonce de un solo uso, y vence a los 10 minutos. La web redirige al usuario a `urlAutorizacion`; al volver, el proveedor llama a GET /oauth/callback. Trotamundos nunca pide ni guarda la contraseña del correo (QA-8). No tiene cuerpo.
         */
        post: operations["conectarCuentaCorreo"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cuentas-correo/{cuentaId}": {
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
         * Desconectar una cuenta de correo
         * @description Borra el token guardado de la cuenta, da de baja los avisos push (Gmail `watch` o la suscripción de Microsoft Graph) y saca el buzón del Examinador. Las reservas que ya llegaron al Servicio de Viajes no se tocan. Solo el dueño de la cuenta puede desconectarla; si la cuenta es de otro usuario responde 404 para no revelar que existe.
         */
        delete: operations["desconectarCuentaCorreo"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/oauth/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Vuelta desde la pantalla de permiso del proveedor
         * @description Pública: la llama el navegador del usuario cuando el proveedor de correo lo redirige (`redirect_uri`), así que no trae JWT. Cada región registra su propio `redirect_uri` con el prefijo de región del enrutador global (por ejemplo `http://localhost:8000/region-1/api/correo/oauth/callback`, gateway.yaml), así la vuelta llega a la región del usuario. El usuario se identifica por el `state`: se verifica la firma, el vencimiento y que el nonce no se haya usado; si falla, responde 400 y no se conecta nada. Con un `state` válido, el adaptador del proveedor canjea `code` por los tokens, comprueba que el scope concedido incluya el de solo lectura, guarda los tokens encriptados con AES-256-GCM, activa los avisos push y deja la cuenta con prioridad máxima para el Examinador (se revisa en el primer minuto, QA-7). Siempre termina redirigiendo a la pantalla Correo de la web, con el resultado en la query: `resultado=conectada&cuentaId=<uuid>` o `resultado=error&motivo=<motivo>`, donde motivo es `permiso-denegado` (el usuario rechazó), `scope-insuficiente`, `codigo-invalido` (`invalid_grant`), `cuenta-de-otro-usuario` o `proveedor-no-disponible`. Los nombres de los parámetros son los del proveedor (OAuth 2.0).
         */
        get: operations["completarConexionOAuth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/notificaciones/gmail": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Aviso push de Gmail (formato Pub/Sub)
         * @description Pública: la llama Google Cloud Pub/Sub (en el prototipo, el mock de Gmail) cuando entra un correo a un buzón con `watch` activo (specs/externos/gmail.md, sección 6). El cuerpo usa los nombres originales de Google. El aviso no trae el correo: `message.data` decodificado solo dice qué buzón cambió (`emailAddress`) y su `historyId` nuevo. El adaptador busca la cuenta por `emailAddress`, encola el buzón para el Examinador (cola correo.buzones-a-revisar, ADR-010) y responde enseguida; los procesadores llaman después a `history.list`. Cada región crea su `watch` con su propia URL de avisos, con el prefijo de región del enrutador global (`/region-1/api/correo/notificaciones/gmail`), así el aviso llega a la región del buzón.
         *     Verificación: la URL de avisos configurada en la suscripción push lleva un secreto en la query (`?token=<secreto>`, como recomienda Pub/Sub para endpoints push); si no coincide con el configurado por entorno responde 401. También se comprueba que `subscription` sea la configurada. Un `messageId` repetido o un `emailAddress` sin cuenta conectada se aceptan (202) y se ignoran, para que Pub/Sub no reintente. Si no se puede encolar responde 503 y Pub/Sub reintenta más tarde.
         */
        post: operations["recibirAvisoGmail"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/notificaciones/outlook": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Validación y avisos de Microsoft Graph
         * @description Pública: la llama Microsoft Graph (en el prototipo, el mock de Outlook). Cada región crea la suscripción con su propia URL, con el prefijo de región del enrutador global (`/region-1/api/correo/notificaciones/outlook`), así el aviso llega a la región del buzón. Atiende dos casos (specs/externos/outlook.md, secciones 4.2 y 5), con los nombres originales de Microsoft:
         *     1. Validación de la URL al crear la suscripción: viene `validationToken` en la query y un cuerpo `text/plain` vacío. Responde 200 `text/plain` con el token decodificado, sin cambios, dentro de 10 segundos.
         *     2. Change notifications: cuerpo JSON con `value`. Responde 202 dentro de 3 segundos y procesa después: encola el buzón para el Examinador (ADR-010) y los procesadores leen cada mensaje por `resourceData.id`.
         *     Verificación: cada aviso trae el `clientState` secreto que el Servicio de Correo eligió al crear la suscripción de esa cuenta. Se compara con el guardado para su `subscriptionId`; los avisos que no coinciden o de suscripciones desconocidas se descartan (y se loguean), pero la respuesta sigue siendo 202 como pide Microsoft. Si no se puede encolar responde 503 y Graph reintenta.
         */
        post: operations["recibirAvisoOutlook"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/no-procesados": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Correos de viaje que no se pudieron interpretar
         * @description Correos de viaje del usuario del JWT que los procesadores no pudieron traducir a `ReservaDetectada` (tabla no_procesados, P2.B6). Sirve para medir el 99 % sin intervención manual de QA-6 y QA-7: detectados = correos de viaje del lote - `total`. Se guardan solo los metadatos del correo, nunca el cuerpo. Los correos que no son de viaje y los de remitentes fuera de la whitelist no aparecen. Ordenados por `registradoEn`, del más nuevo al más viejo.
         */
        get: operations["listarNoProcesados"];
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
         * @description Proveedor de correo. No confundir con `Proveedor` (aerolínea, hotel o rentadora) de los eventos. Agregar uno nuevo es agregar un adaptador (ADR-003).
         * @enum {string}
         */
        ProveedorCorreo: "gmail" | "outlook";
        /**
         * @description `conectada`: el token sirve y el Examinador revisa el buzón. `sin-permiso`: el proveedor rechazó el token (`invalid_grant`, por ejemplo porque el usuario quitó el permiso); el usuario tiene que volver a conectar la cuenta (ADR-015, consecuencia "Malo").
         * @enum {string}
         */
        EstadoCuentaCorreo: "conectada" | "sin-permiso";
        CuentaCorreo: {
            /** Format: uuid */
            id: string;
            proveedorCorreo: components["schemas"]["ProveedorCorreo"];
            /**
             * Format: email
             * @description Dirección del buzón conectado. La pide el adaptador después del canje del código: Gmail `GET /gmail/v1/users/me/profile` (`emailAddress`) y Outlook `GET /v1.0/me` (`mail` o, si viene vacío, `userPrincipalName`); ver specs/externos.
             */
            email: string;
            estado: components["schemas"]["EstadoCuentaCorreo"];
            /**
             * Format: date-time
             * @description Cuándo se dio el permiso por última vez.
             */
            conectadaEn: string;
            /**
             * Format: date-time
             * @description Última vez que un procesador leyó el buzón. `null` si todavía no se revisó.
             */
            ultimaRevision: string | null;
        };
        ListaCuentasCorreo: {
            cuentas: components["schemas"]["CuentaCorreo"][];
        };
        AutorizacionCorreo: {
            proveedorCorreo: components["schemas"]["ProveedorCorreo"];
            /**
             * Format: uri
             * @description Pantalla de permiso del proveedor, con scope de solo lectura y el `state` firmado.
             */
            urlAutorizacion: string;
            /**
             * Format: date-time
             * @description Hasta cuándo se acepta la vuelta a GET /oauth/callback con ese `state`.
             */
            stateVenceEn: string;
        };
        /**
         * @description `sin-regla`: no hay JSON-LD y el texto no coincide con ninguna plantilla. `marcado-invalido`: hay JSON-LD de reserva pero no se puede leer o le faltan datos obligatorios de ReservaDetectada. `estado-no-confirmado`: la reserva viene cancelada o en espera (ReservaDetectada no tiene estado; ver specs/externos/correos-reserva.md). `proveedor-desconocido`: el dominio del remitente no está en la tabla dominio → proveedor.
         * @enum {string}
         */
        MotivoNoProcesado: "sin-regla" | "marcado-invalido" | "estado-no-confirmado" | "proveedor-desconocido";
        NoProcesado: {
            /** Format: uuid */
            id: string;
            /**
             * Format: uuid
             * @description Cuenta de correo donde llegó.
             */
            cuentaId: string;
            proveedorCorreo: components["schemas"]["ProveedorCorreo"];
            /** @description Id del correo en el proveedor (el mismo campo `correoId` de ReservaDetectada). */
            correoId: string;
            /** Format: email */
            remitente: string;
            asunto?: string;
            /** Format: date-time */
            recibidoEn: string;
            /**
             * Format: date-time
             * @description Cuándo el procesador lo dejó en no_procesados.
             */
            registradoEn: string;
            motivo: components["schemas"]["MotivoNoProcesado"];
            /** @description Explicación del procesador, para revisar el caso a mano. */
            detalle?: string;
        };
        ListaNoProcesados: {
            /** @description Cantidad total que cumple los filtros, aunque `noProcesados` traiga menos por `limite`. */
            total: number;
            noProcesados: components["schemas"]["NoProcesado"][];
        };
        /** @description Mensaje push de Cloud Pub/Sub, con los nombres originales de Google. Admite campos extra (`attributes`, `deliveryAttempt`, etc.): Google pide ignorar los que no se conocen, por eso no lleva additionalProperties false. */
        AvisoPushGmail: {
            message: {
                /** @description JSON de DatosAvisoGmail en base64 (Pub/Sub) o base64url (guía de Gmail); se aceptan los dos alfabetos. */
                data: string;
                /** @description Id de Pub/Sub (no del correo). Puede llegar repetido; el repetido se ignora. */
                messageId: string;
                message_id?: string;
                /** Format: date-time */
                publishTime?: string;
                /** Format: date-time */
                publish_time?: string;
            } & {
                [key: string]: unknown;
            };
            /** @description Suscripción push de Pub/Sub. Tiene que ser la configurada. */
            subscription: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * @description Contenido de `message.data` decodificado (specs/externos/gmail.md, sección 6).
         * @example {
         *       "emailAddress": "ana.garcia@gmail.com",
         *       "historyId": "9876543210"
         *     }
         */
        DatosAvisoGmail: {
            /**
             * Format: email
             * @description Buzón que cambió.
             */
            emailAddress: string;
            /** @description historyId nuevo del buzón. Los procesadores llaman a history.list desde el último guardado. */
            historyId: string;
        } & {
            [key: string]: unknown;
        };
        /** @description Colección de change notifications de Microsoft Graph, con los nombres originales. Admite campos extra (Microsoft pide ignorar los que no se conocen). */
        AvisosGraph: {
            /** @description Puede traer varios avisos, incluso de suscripciones distintas. */
            value: components["schemas"]["AvisoGraph"][];
        } & {
            [key: string]: unknown;
        };
        AvisoGraph: {
            id?: string;
            /**
             * Format: uuid
             * @description Suscripción de la cuenta. Con ella se busca la cuenta y su clientState.
             */
            subscriptionId: string;
            /**
             * Format: date-time
             * @description Vencimiento de la suscripción; el servicio la renueva antes.
             */
            subscriptionExpirationDateTime?: string;
            /** @description Secreto de la suscripción. Si falta o no coincide con el guardado, el aviso se descarta. */
            clientState?: string;
            /** @enum {string} */
            changeType: "created" | "updated" | "deleted";
            resource: string;
            /** Format: uuid */
            tenantId?: string;
            resourceData: {
                "@odata.type"?: string;
                "@odata.id"?: string;
                "@odata.etag"?: string;
                /** @description Id del mensaje. El procesador lo lee con GET /v1.0/me/messages/{id}. */
                id: string;
            } & {
                [key: string]: unknown;
            };
        } & {
            [key: string]: unknown;
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
        /** @description El aviso no pasó la verificación (falta el secreto de la URL de avisos o no coincide). No se encola nada. */
        AvisoNoVerificado: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "type": "https://trotamundos.example/errores/aviso-no-verificado",
                 *       "title": "Aviso no verificado",
                 *       "status": 401,
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
    listarCuentasCorreo: {
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
            /** @description Cuentas del usuario (lista vacía si no conectó ninguna). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "cuentas": [
                     *         {
                     *           "id": "3b1f0c9e-6a2d-4f5b-9c8e-1a2b3c4d5e6f",
                     *           "proveedorCorreo": "gmail",
                     *           "email": "ana.garcia@gmail.com",
                     *           "estado": "conectada",
                     *           "conectadaEn": "2026-11-28T12:00:05Z",
                     *           "ultimaRevision": "2026-11-28T12:12:35Z"
                     *         },
                     *         {
                     *           "id": "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
                     *           "proveedorCorreo": "outlook",
                     *           "email": "ana.garcia@outlook.com",
                     *           "estado": "sin-permiso",
                     *           "conectadaEn": "2026-11-20T09:30:00Z",
                     *           "ultimaRevision": "2026-11-27T22:00:00Z"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["ListaCuentasCorreo"];
                };
            };
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            503: components["responses"]["NoDisponible"];
        };
    };
    conectarCuentaCorreo: {
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
                 * @description Proveedor de correo. Cada uno tiene su adaptador (ADR-003).
                 * @example gmail
                 */
                proveedorCorreo: components["schemas"]["ProveedorCorreo"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description URL de autorización a la que la web tiene que redirigir al usuario. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AutorizacionCorreo"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            503: components["responses"]["NoDisponible"];
        };
    };
    desconectarCuentaCorreo: {
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
                 * @description Id de la cuenta de correo (campo `id` de GET /cuentas-correo).
                 * @example 3b1f0c9e-6a2d-4f5b-9c8e-1a2b3c4d5e6f
                 */
                cuentaId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cuenta desconectada y token borrado. */
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
    completarConexionOAuth: {
        parameters: {
            query: {
                /**
                 * @description El mismo `state` firmado que se mandó en la URL de autorización.
                 * @example eyJ1IjoiNmIxZTdjMmEiLCJyIjoicmVnaW9uLTEifQ.firma
                 */
                state: string;
                /**
                 * @description Código de autorización. Viene si el usuario dio el permiso.
                 * @example 4/P7q7W91a-oMsCeLvIaQm6bTrgtp7
                 */
                code?: string;
                /**
                 * @description Scopes concedidos (solo Gmail lo manda en la redirección). Se vuelve a comprobar con la respuesta del canje.
                 * @example https://www.googleapis.com/auth/gmail.readonly
                 */
                scope?: string;
                /**
                 * @description Viene en lugar de `code` si el usuario rechazó el permiso (`access_denied`) u otro error OAuth.
                 * @example access_denied
                 */
                error?: string;
                /**
                 * @description Texto libre del proveedor (Outlook). Solo para los logs.
                 * @example the user canceled the authentication
                 */
                error_description?: string;
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
            /** @description Redirección a la pantalla Correo de la web con el resultado de la conexión. */
            302: {
                headers: {
                    /** @description URL de la web (configurada por entorno) con `resultado` y `cuentaId` o `motivo`. */
                    Location: string;
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description El `state` falta, tiene la firma mal, venció o ya se usó. No se conecta ninguna cuenta. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "type": "https://trotamundos.example/errores/state-invalido",
                     *       "title": "State inválido",
                     *       "status": 400,
                     *       "detail": "El state venció o ya se usó. Volvé a conectar la cuenta.",
                     *       "requestId": "7f3c1e2a-9b4d-4c6e-8a1f-2d3e4f5a6b7c"
                     *     }
                     */
                    "application/problem+json": components["schemas"]["Problema"];
                };
            };
            503: components["responses"]["NoDisponible"];
        };
    };
    recibirAvisoGmail: {
        parameters: {
            query: {
                /**
                 * @description Secreto compartido de la suscripción push, configurado por entorno. Nunca se loguea.
                 * @example c2VjcmV0by1kZS1lamVtcGxvLXB1c2g
                 */
                token: string;
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
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "message": {
                 *         "data": "eyJlbWFpbEFkZHJlc3MiOiJhbmEuZ2FyY2lhQGdtYWlsLmNvbSIsImhpc3RvcnlJZCI6Ijk4NzY1NDMyMTAifQ==",
                 *         "messageId": "2070443601311540",
                 *         "message_id": "2070443601311540",
                 *         "publishTime": "2026-11-28T12:12:31.749Z",
                 *         "publish_time": "2026-11-28T12:12:31.749Z"
                 *       },
                 *       "subscription": "projects/trotamundos/subscriptions/gmail-avisos-push"
                 *     }
                 */
                "application/json": components["schemas"]["AvisoPushGmail"];
            };
        };
        responses: {
            /** @description Aviso aceptado (Pub/Sub lo toma como confirmado). El buzón quedó encolado o el aviso se ignoró por repetido. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["AvisoNoVerificado"];
            503: components["responses"]["NoDisponible"];
        };
    };
    recibirAvisoOutlook: {
        parameters: {
            query?: {
                /**
                 * @description Solo en la validación de la URL. Token opaco; se devuelve decodificado en el cuerpo.
                 * @example token opaco: f2b1d6a0
                 */
                validationToken?: string;
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
        requestBody?: {
            content: {
                /**
                 * @example {
                 *       "value": [
                 *         {
                 *           "id": "lsgTZMr9KwAAA",
                 *           "subscriptionId": "7f105c7d-2dc5-4530-97cd-4e7ae6534c07",
                 *           "subscriptionExpirationDateTime": "2026-12-05T12:00:00Z",
                 *           "clientState": "secreto-aleatorio-de-la-cuenta",
                 *           "changeType": "created",
                 *           "resource": "Users/6b1e7c2a-4f3d-4e8b-9c0a-1d2e3f4a5b6c/Messages/AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZiLTU1OGY5OTZhYmY4OABGAAAAAAAiQ8W967B7TKBjgx9rVEURBwAiIsqMbYjsT5e-T7KzowPTAAAAAAEMAAAiIsqMbYjsT5e-T7KzowPTAAAYbvZDAAA=",
                 *           "tenantId": "84bd8158-6d4d-4958-8b9f-9d6445542f95",
                 *           "resourceData": {
                 *             "@odata.type": "#Microsoft.Graph.Message",
                 *             "@odata.id": "Users/6b1e7c2a-4f3d-4e8b-9c0a-1d2e3f4a5b6c/Messages/AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZiLTU1OGY5OTZhYmY4OABGAAAAAAAiQ8W967B7TKBjgx9rVEURBwAiIsqMbYjsT5e-T7KzowPTAAAAAAEMAAAiIsqMbYjsT5e-T7KzowPTAAAYbvZDAAA=",
                 *             "@odata.etag": "W/\"CQAAABYAAADkrWGo7bouTKlsgTZMr9KwAAAUWRHf\"",
                 *             "id": "AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZiLTU1OGY5OTZhYmY4OABGAAAAAAAiQ8W967B7TKBjgx9rVEURBwAiIsqMbYjsT5e-T7KzowPTAAAAAAEMAAAiIsqMbYjsT5e-T7KzowPTAAAYbvZDAAA="
                 *           }
                 *         }
                 *       ]
                 *     }
                 */
                "application/json": components["schemas"]["AvisosGraph"];
                /** @example  */
                "text/plain": string;
            };
        };
        responses: {
            /** @description Respuesta a la validación de la URL. El cuerpo es el `validationToken` decodificado, en texto plano. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /** @example token opaco: f2b1d6a0 */
                    "text/plain": string;
                };
            };
            /** @description Avisos aceptados. Los válidos quedaron encolados; los que no pasaron la verificación de `clientState` se descartaron. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["SolicitudInvalida"];
            503: components["responses"]["NoDisponible"];
        };
    };
    listarNoProcesados: {
        parameters: {
            query?: {
                /**
                 * @description Solo los registrados desde esta fecha (inclusive).
                 * @example 2026-11-28T00:00:00Z
                 */
                desde?: string;
                /**
                 * @description Solo los de esta cuenta de correo.
                 * @example 3b1f0c9e-6a2d-4f5b-9c8e-1a2b3c4d5e6f
                 */
                cuentaId?: string;
                /**
                 * @description Cantidad máxima de elementos en `noProcesados`. `total` cuenta todos igual.
                 * @example 100
                 */
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
            /** @description Correos no procesados del usuario. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "total": 1,
                     *       "noProcesados": [
                     *         {
                     *           "id": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
                     *           "cuentaId": "3b1f0c9e-6a2d-4f5b-9c8e-1a2b3c4d5e6f",
                     *           "proveedorCorreo": "gmail",
                     *           "correoId": "18c4f1b2a0c4d002",
                     *           "remitente": "reservas@hotel-cordillera.example",
                     *           "asunto": "Hotel Cordillera - Cambio de fechas",
                     *           "recibidoEn": "2026-11-28T12:20:00Z",
                     *           "registradoEn": "2026-11-28T12:20:04Z",
                     *           "motivo": "sin-regla",
                     *           "detalle": "No hay marcado JSON-LD y el texto no coincide con ninguna plantilla."
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["ListaNoProcesados"];
                };
            };
            400: components["responses"]["SolicitudInvalida"];
            401: components["responses"]["NoAutenticado"];
            403: components["responses"]["Prohibido"];
            503: components["responses"]["NoDisponible"];
        };
    };
}
