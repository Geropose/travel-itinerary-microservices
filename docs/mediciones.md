# Mediciones de calidad y disponibilidad (`docs/mediciones.md`)

Este documento registra los resultados medidos sobre el prototipo ejecutable de Trotamundos y los contrasta contra las estimaciones definidas en el Paso 7 de la [wiki de arquitectura](https://github.com/facubelmonte/Trabajo-especial-trotamundos/wiki).

> **Contexto del entorno de ejecución:** El prototipo corre en **una sola máquina** mediante Docker Compose (`global`, `r1`, `r2`, más de 40 contenedores compartiendo CPU, memoria y disco). Por ese motivo, las latencias bajo contención local y el volumen de carga se escalan proporcionalmente respecto de un despliegue productivo distribuido; aquí se reportan únicamente valores observados al ejecutar las suites reproducibles, sin extrapolar ni inventar mediciones.

---

## 1. Pruebas de caídas y disponibilidad (`QA-4`, P3.5 y P4.1)

Mediciones contra el sistema levantado con `npm run infra:levantar -- --ha` (global, `r1` y `r2`, con 3 nodos de RabbitMQ por región), el 21/11/2026.

* **Medida pedida (Análisis inicial):** el sistema no puede estar sin servicio más de 5 min por mes.
* **Qué dice la wiki (Paso 7 de las Iteraciones 1, 4 y 6):**
  * Caída de una instancia: el monitor hace ping cada 5 s y la saca después de 3 pings sin respuesta (15 s). Como hay al menos 3 instancias, el usuario no lo nota (`ADR-006`, `ADR-007`, `ADR-008`).
  * Caída de la base principal (o de un centro de datos): la read replica del otro centro de datos de la misma región pasa a principal en 1 min (`ADR-012`, `ADR-017`).
  * Los eventos esperan en el broker si un consumidor está caído (`ADR-002`), y el panel se lee de la read replica si falla la cache (`ADR-004`, `ADR-011`).
  * Caída de una región entera: sus usuarios quedan sin servicio hasta que se recupere (riesgo aceptado por `CONST-6`). No se mide.
* **Máquina:** la misma de la sección 2 (16 CPU y 32 GB para Docker), con 45 contenedores por el perfil `ha`. Hay una instancia de cada servicio por región (el gateway tiene 2), y la wiki supone al menos 3. Por eso, en el prototipo, detener `r1-viajes-1` deja sin Servicio de Viajes a la región 1: en producción equivale a perder las 3 instancias a la vez.
* **Comandos reproducibles:**
  ```bash
  npm run infra:levantar -- --ha
  npm run caos                                  # escenarios 1 a 5 (tests/caos)
  npm run carga:failover-viajes                 # escenario 4, sin cortar en el primer error
  npm run carga:caida-servicio                  # escenario 6
  ```
* **Pruebas:** [`tests/caos/gateway.test.ts`](../tests/caos/gateway.test.ts) y [`tests/caos/disponibilidad.test.ts`](../tests/caos/disponibilidad.test.ts) (P3.5), y [`tests/carga/failover-viajes.ts`](../tests/carga/failover-viajes.ts) y [`tests/carga/caida-servicio.ts`](../tests/carga/caida-servicio.ts) (P4.1). Los dos scripts piden cada 200 ms el panel (depende de Viajes) y una ruta de Autenticación (`/api/autenticacion/.well-known/jwks.json`, no depende de Viajes), para ver si la falla queda en un solo servicio.

| Escenario (`QA-4`) | Qué pide la wiki | Cómo se midió | Resultado medido | ¿Cumple? |
|---|---|---|---|---|
| **1. Matar una instancia del gateway (`r1-gateway-1`)** | Detección en 15 s o menos, reinicio automático y el usuario no lo nota | `docker kill` mientras se pide el panel cada 100 ms; el estado del monitor se lee de `r1-monitor-1 /estado` | Detectada en 10,7 s (en otra corrida, 11,0 s) y reiniciada sola. 138 solicitudes al panel, 1 error (0,7 %), p95 7 ms. En `gateway.test.ts` (Autenticación cada 100 ms) hubo 1 error `504` en cada una de las 2 corridas | Sí |
| **2. Matar un nodo de RabbitMQ (`r1-rabbitmq-2-1`)** | 0 eventos perdidos (colas quorum con 2 de 3 nodos) | `docker kill` e inyección de 4 correos de reserva en el mock de Gmail mientras falta el nodo | 4 de 4 reservas llegaron al panel. 12 solicitudes al panel, 0 errores, p95 13 ms | Sí |
| **3. Detener Viajes 2 min (`r1-viajes-1`)** | Los eventos esperan en el broker y se procesan al volver | Monitor en pausa y `docker stop` 120 s, mientras llegan 1 reserva nueva por correo y 1 cambio por webhook de la aerolínea | Los 2 eventos se aplicaron 2,5 s después de que Viajes volvió. Mientras estuvo detenido, el panel falló en 126 de 128 solicitudes (hay una sola instancia) | Sí (ningún evento perdido) |
| **4. Detener la base principal de Viajes (`r1-postgres-viajes-1`)** | La read replica pasa a principal en 1 min | `docker stop` y `npm run infra:failover-viajes`; después, una reserva nueva cada 500 ms hasta que se acepta | Réplica promovida en 5,6 s. Primera escritura aceptada a los 6,0 s de la caída. Panel: 4 errores `503` de 117 (en 0,6 s). Autenticación: 0 errores de 118 | Sí |
| **5. Detener Redis (`r1-redis-1`)** | El panel se lee de la read replica, sin errores y en menos de 800 ms (QA-2) | `docker stop` con la cache llena, pidiendo el panel cada 100 ms; después `docker start` | 42 solicitudes, 0 errores, 41 desde la read replica, p50 6 ms, p95 8 ms. Al volver Redis, el panel se volvió a leer de la cache | Sí |
| **6. Detener un servicio entero 30 s (`r1-viajes-1`)** | La falla queda en ese servicio: los demás siguen atendiendo (microservicios, `ADR-001`) | `npm run carga:caida-servicio`: monitor en pausa y `docker stop` 30 s | Panel: 80 errores de 169. Autenticación: **71 errores `502` de 203, durante 15 s**, que siguieron 10 s después de que Viajes volvió | **No** (ver hallazgo) |

* **Corridas completas de `npm run caos`:** la primera, con el sistema recién levantado, pasó 1 de 6 pruebas. La segunda pasó la 1, la 2 y la 3, y fallaron la 4, la 5 y la de `gateway.test.ts`, las tres con `502`. Esas tres pasan (o dan los números de la tabla) cuando se corren solas: fallan por el hallazgo de abajo, porque empiezan antes de que pasen los 15 s que deja la prueba 3. Los resultados de la tabla son de las pruebas que pasaron y de los dos scripts de `tests/carga`.
* **¿Cumple QA-4?** En parte. Las tácticas de la wiki funcionan (ping-echo, reinicio, colas quorum, promoción de la réplica y lectura de la réplica sin cache), y cada falla medida dura segundos: la más larga son 6 s sin poder guardar reservas (escenario 4), lejos de los 5 min por mes. Pero cuando un servicio deja de responder, toda la región responde `502` durante 15 s.
* **Hallazgo (no se tocó, es configuración de `infra/`):** en [`infra/nginx/region.conf.template`](../infra/nginx/region.conf.template), nginx reintenta en el otro gateway con `proxy_next_upstream error timeout http_502 http_503` y saca un gateway después de 3 fallas (`max_fails=3 fail_timeout=15s`). Cuando Viajes no responde, el gateway contesta `502` (que es lo correcto), pero nginx lo cuenta como falla del gateway. Así saca a los dos gateways sanos y durante 15 s contesta `502` a todas las rutas de la región (en su log: `no live upstreams`). La wiki pide que nginx saque solo al gateway caído. Para eso alcanzaría con que nginx no cuente los `502` y `503` que manda el gateway (dejar `proxy_next_upstream error timeout`), pero eso queda para el grupo.
* **Diferencias con la wiki:**
  * La promoción tarda 6 s y no 1 min, pero en el prototipo la decide una persona con `npm run infra:failover-viajes`: el tiempo hasta darse cuenta de la caída no está incluido.
  * Con una sola instancia por servicio, la caída de Viajes deja sin panel a la región (escenario 3). Con las 3 instancias de `ADR-006` (`npm run infra:escalador` con el perfil `ha`), la caída de una instancia sería como el escenario 1.
  * El escenario 1 da 1 error y no 0: la solicitud que estaba yendo al gateway justo cuando se mató termina con `504`. La wiki dice que el usuario no lo nota; `gateway.test.ts` pide 0 errores y por eso falla.
  * En la primera corrida, con el sistema recién levantado, las pruebas 2 y 3 no vieron los correos en el panel (esperan 35 s y 25 s): el mock de Gmail mandó los avisos y el Servicio de Correo respondió `202`, pero no leyó los correos. No se repitió en las 3 corridas siguientes, y no encontramos la causa.

---


## 2. Interoperabilidad y seguridad (`QA-6`, `QA-7` y `QA-8`, P4.1)

Mediciones contra el sistema levantado con `npm run infra:levantar` (global, `r1` y `r2`), el 21/11/2026.

* **Máquina:** una sola computadora (16 CPU y 32 GB de memoria para Docker) con los 41 contenedores del prototipo. Hay una instancia de cada servicio por región (el gateway tiene 2). En producción cada servicio tendría varias instancias (Análisis inicial, sección 7: 500 solicitudes por segundo por instancia), así que los tiempos de acá son de una sola instancia y no se pueden multiplicar para estimar un despliegue grande.
* **Escala de la carga:** usamos el tamaño de lote que pide la wiki para QA-6 (un lote de mensajes de prueba de cada proveedor simulado) con 1.000 mensajes por proveedor, y un buzón con 1.000 correos para QA-7. La wiki no estima cuántas publicaciones en redes sociales hay por segundo en un pico, así que la publicación se midió en escalones (1, 5, 10 y 20 por segundo) en lugar de inventar un número.
* **Pruebas:** [`tests/carga/`](../tests/carga/). Los cálculos (percentiles, porcentajes y qué reservas tienen que aparecer) tienen pruebas en [`tests/carga/calculos.test.ts`](../tests/carga/calculos.test.ts), que corre con `npm test`.

* **Comandos reproducibles:**
  ```bash
  npm run infra:levantar
  npm run carga:proveedores                                    # QA-6
  npm run carga:correos -- --proveedor outlook                 # QA-7, primeros correos y lote
  npm run carga:correos -- --proveedor gmail --espera-min 75   # QA-7 (Gmail tarda más por la cuota)
  npm run carga:publicacion                                    # QA-7, publicación (k6 en Docker)
  npm run carga:publicacion:demora                             # QA-7, publicación con la red social a 1 s
  npm run e2e -- seguridad                                     # QA-8 (pruebas de P3.3)
  ```

### 2.1 QA-6: mensajes de proveedores sin intervención manual

* **Medida pedida (Análisis inicial, SEI 6):** al menos el 99 % de los mensajes de aerolíneas, hoteles y rentadoras se procesa sin intervención manual.
* **Qué dice la wiki (Iteración 3, Paso 7):** cada adaptador traduce el formato estándar de su proveedor y registra en `no_traducidos` lo que no puede traducir; el porcentaje se mide con un lote de mensajes de prueba de cada proveedor simulado.
* **Cómo se midió ([`tests/carga/proveedores.ts`](../tests/carga/proveedores.ts)):** a cada mock se le pide una tormenta de 1.000 cancelaciones (`POST /admin/tormenta`). La aerolínea las avisa por webhook firmado con HMAC (a las dos regiones, a través del enrutador). El hotel y la rentadora no avisan: el Servicio de Integraciones las encuentra en su consulta periódica cada 2 min. Se cuentan las filas nuevas de `cambios_procesados` (traducidos) y de `no_traducidos` (para revisar a mano) en la base de Integraciones de la región 1.

| Proveedor | Cómo llegan los cambios | Mensajes | Traducidos | Para revisar a mano | Tiempo hasta procesar los 1.000 |
|---|---|---|---|---|---|
| Aerolínea Andina | Webhook (aviso) | 1.000 | 1.000 (100 %) | 0 | 5,3 s |
| Hotel Cordillera | Consulta cada 2 min | 1.000 | 1.000 (100 %) | 0 | 1 min 30 s |
| Rentadora Sur | Consulta cada 2 min | 1.000 | 1.000 (100 %) | 0 | 2 min 00 s |
| **Total** | | **3.000** | **3.000 (100 %)** | **0** | |

* **¿Cumple?** Sí: 100 % contra el 99 % pedido.
* **Diferencias con la wiki:** coincide con lo estimado. Los mensajes de la tormenta usan el formato estándar de cada mock, así que todos se pueden traducir. Que el adaptador separa bien los mensajes que no puede traducir (sin `booking_reference`, estado desconocido) está probado aparte, en [`services/integraciones/test/adaptadores.test.ts`](../services/integraciones/test/adaptadores.test.ts) (lote de 1.000 con 6 mal formados: 99,4 %). Los tiempos de hotel y rentadora dependen de en qué momento del ciclo de 2 min cae la tormenta: el peor caso es 2 min más la traducción, como dice la Iteración 3 para QA-1.

### 2.2 QA-7: primeros correos de una cuenta nueva y lote de 1.000 correos

* **Medida pedida (Análisis inicial, SEI 7):** los primeros correos de viaje se procesan en menos de 5 min desde que el usuario conecta la cuenta.
* **Qué dice la wiki (Iteración 3, Paso 7):** al conectar una cuenta, el Examinador la revisa con prioridad máxima en el primer minuto: los primeros correos se procesan en menos de 2 min.
* **Cómo se midió ([`tests/carga/primeros-correos.ts`](../tests/carga/primeros-correos.ts)):** un usuario nuevo activa su whitelist con los tres proveedores de prueba (UC-2). En un buzón nuevo del mock se cargan 1.000 correos generados (`POST /admin/buzones/{email}/correos` con `cantidad: 1000`): reservas de vuelo, hotel y auto con y sin JSON-LD, correos que no son de viaje y correos de un remitente fuera de la whitelist. Después se conecta la cuenta por OAuth y, desde el "Permitir", se consulta el panel cada segundo hasta que aparecen todas las reservas que el generador marcó como de viaje. Cada corrida usa otra semilla, porque Viajes no acepta dos veces el mismo número de reserva de un proveedor.

| Proveedor | Correos | Reservas esperadas | Primera reserva en el panel | Todas las reservas | Detectadas |
|---|---|---|---|---|---|
| Outlook | 1.000 | 613 | 22,3 s | 26,3 s | 613 (100 %) |
| Gmail | 1.000 | 592 | 1,1 s | 44 min 07 s | 592 (100 %) |

* **¿Cumple?** Sí para los primeros correos: en los dos proveedores la primera reserva aparece mucho antes de los 5 min (y de los 2 min que estima la wiki). Con Outlook también el lote entero, con el 100 % detectado. Con Gmail el lote de 1.000 correos se detecta entero (100 %), pero tarda 44 min 07 s: a los 5 min había 91 de 592 reservas en el panel, a los 15 min 218 y a los 30 min 416. Una segunda corrida con otra semilla dio lo mismo: 437 de 581 a los 30 min.
* **Diferencias con la wiki:** la wiki no tuvo en cuenta la cuota de Gmail. `specs/externos/gmail.md` (sección 7) fija 6.000 unidades por minuto por usuario y 60 unidades por cada `messages.get` con `format=full`: como máximo unos 100 correos por minuto. Además, cuando llega el `429`, el bloque de 50 correos que se estaba leyendo se descarta y se vuelve a leer después del retroceso exponencial (30 s y 60 s), así que en la práctica avanza unos 50 correos por ciclo, alrededor de 13 reservas por minuto. La revisión inicial lee el buzón completo, del correo más viejo al más nuevo, así que en un buzón grande las reservas más recientes son las últimas en aparecer. Con Outlook no pasa porque su límite (10.000 solicitudes cada 10 min) alcanza para el lote entero.

### 2.3 QA-7: publicación del itinerario en la red social

* **Medida pedida (Análisis inicial, SEI 7):** la publicación en la red social tarda menos de 3 s.
* **Qué dice la wiki (Iteración 3, Paso 7):** publicar es una llamada al adaptador de alrededor de 1 s.
* **Cómo se midió ([`tests/carga/publicacion.k6.js`](../tests/carga/publicacion.k6.js), k6 1.0.0 en Docker):** 5 usuarios con un viaje cada uno publican con `POST /api/viajes/viajes/{viajeId}/compartir-red` a través del enrutador (enrutador, nginx, gateway con el Validador de Intercepción, Viajes, Integraciones con el adaptador de la red social y el mock). La carga sube en escalones de 30 s: 1, 5, 10 y 20 publicaciones por segundo. Se corrió dos veces: con el mock respondiendo enseguida y con el mock tardando 1 s por publicación (`/admin/comportamiento`), que es lo que estima la wiki para la red social real.

| Escalón | Publicaciones (aprox.) | p50 (mock sin demora) | p95 (mock sin demora) | p50 (mock a 1 s) | p95 (mock a 1 s) | Errores |
|---|---|---|---|---|---|---|
| 1 por segundo | 30 | 10,0 ms | 12,8 ms | 1,00 s | 1,01 s | 0 |
| 5 por segundo | 150 | 9,4 ms | 11,8 ms | 1,00 s | 1,01 s | 0 |
| 10 por segundo | 300 | 9,0 ms | 10,8 ms | 1,00 s | 1,01 s | 0 |
| 20 por segundo | 600 | 7,7 ms | 9,8 ms | 1,00 s | 1,01 s | 0 |

* **¿Cumple?** Sí: el p95 más alto es 1,01 s, contra los 3 s pedidos, sin errores en ningún escalón. El mock de la red social recibió todas las publicaciones (1.083 en la corrida sin demora).
* **Diferencias con la wiki:** coincide. Nuestro sistema suma alrededor de 10 ms; el resto es el tiempo de la red social. Hasta 20 publicaciones por segundo con una sola instancia de Viajes y de Integraciones no aparece cola: como la llamada a la red social espera sin usar el procesador, la demora de 1 s no se acumula.

### 2.4 QA-8: acceso seguro y autorizado a los correos (resultados de P3.3)

* **Medida pedida (Análisis inicial, SEI 8):** el 100 % de los accesos no autorizados se bloquea y se registra, y no se guarda ninguna contraseña.
* **Qué dice la wiki (Iteración 5, Paso 7):** toda solicitud pasa por un validador y no existe ningún campo para guardar contraseñas de correo; el 100 % se comprueba con pruebas de acceso sin token y con el token de otro usuario.
* **Cómo se midió:** con las pruebas de seguridad de P3.3, [`tests/e2e/seguridad/seguridad.test.ts`](../tests/e2e/seguridad/seguridad.test.ts) (`npm run e2e -- seguridad`), y mirando la tabla `accesos_rechazados` de `registro_accesos`.

| Prueba (P3.3) | Resultado |
|---|---|
| Las 30 rutas protegidas de los 7 contratos, cada una sin token, con JWT vencido, con firma desconocida y con firma adulterada (120 intentos) | Pasa: 120 de 120 responden `401` y quedan registradas (`sin-token`, `token-invalido`) |
| Usuario A contra los recursos de usuario B (viajes, reservas, perfil, conversaciones del asistente) | **Falla:** Viajes bloquea con `403`, pero el rechazo no aparece en `accesos_rechazados`. La prueba se corta ahí, así que los pasos de Usuarios y Asistente no llegan a correr |
| Itinerario compartido: un tercero no designado intenta verlo (QA-9) | **Falla** por lo mismo: `403` sin registro |
| Rol analista en rutas de datos personales | Pasa: bloqueado (`403`) y registrado por el gateway |
| Rutas `/interna/*` pedidas desde afuera | Pasa: `404` y registradas (`ruta-interna`) |
| Ninguna contraseña en texto plano ni token OAuth sin cifrar en las bases | Pasa |
| Ninguna contraseña, token OAuth ni JWT completo en los logs de los contenedores | Pasa |

* **¿Cumple?** En parte. Ningún acceso no autorizado llegó a los datos y no se guarda ninguna contraseña. Pero no se registra el 100 %: los rechazos que decide el gateway sí quedan en `accesos_rechazados`, y los que decide un servicio porque el recurso es de otro usuario (`403 sin-permiso`, medido en Viajes) no quedan. Usuarios y Asistente publican el mismo evento, así que tampoco quedarían.
* **Diferencias con la wiki:** el diseño está bien y el contrato también. `specs/asyncapi/eventos.yaml` define que los servicios publican `AccesoRechazado` y que el registro de accesos del gateway lo consume (`consumirAccesoRechazado`). Los servicios lo publican, pero el gateway todavía no tiene ese consumidor: en RabbitMQ de la región 1 no existe la cola. Falta programar ese consumidor en `services/gateway` para cumplir QA-8 (y QA-9); queda pendiente, fuera de P4.1.

### 2.5 Resumen

| QA | Medida pedida | Resultado medido | ¿Cumple? |
|---|---|---|---|
| QA-6 | ≥ 99 % de los mensajes de proveedores sin intervención | 3.000 de 3.000 (100 %) | Sí |
| QA-7 | Primeros correos en < 5 min | Primera reserva en 22,3 s (Outlook) y 1,1 s (Gmail) | Sí |
| QA-7 | Lote de 1.000 correos, ≥ 99 % detectados | Outlook: 100 % en 26,3 s. Gmail: 100 % en 44 min 07 s (por la cuota de la API) | Sí el 99 %; Gmail tarda más de 5 min en el lote entero |
| QA-7 | Publicación en la red social en < 3 s | p95 de 1,01 s con la red social a 1 s, hasta 20 por segundo | Sí |
| QA-8 | 100 % de los accesos no autorizados bloqueados y registrados, ninguna contraseña | Todos bloqueados y ninguna contraseña; los `403` de los servicios no se registran | En parte |

---

## 3. Seguridad de los itinerarios (`QA-9`, P4.1)

Mediciones contra el sistema levantado con `npm run infra:levantar` (global, `r1` y `r2`), el 21/11/2026, con el registro de accesos del gateway ya consumiendo `AccesoRechazado` (PR #41).

* **Medida pedida (Análisis inicial):** solo el dueño y las personas designadas ven un itinerario; cada intento rechazado queda registrado en menos de 1 s, y la seguridad agrega menos de 200 ms a cada solicitud.
* **Qué dice la wiki (Iteración 5, Paso 7):** validar el JWT no usa la red (1 ms por validador) y consultar el permiso tarda 20 ms: suma unos 25 ms. El registro del intento es asíncrono y tarda milisegundos. La Iteración 7 agrega que el asistente usa el JWT del usuario y no ve viajes de otros.
* **Máquina:** la misma de la sección 2. Todo corre en una sola computadora, así que entre contenedores no hay la demora de red que habría entre servidores de un centro de datos. Por eso los tiempos de acá son los del trabajo de cada componente, sin la red.
* **Escala de la carga:** la medida es por solicitud, no por volumen: se tomaron 5.000 verificaciones del JWT, 300 pedidos del itinerario por el dueño y 300 por la persona designada, y 100 rechazos de cada tipo, de a uno.
* **Cómo se midió ([`tests/carga/seguridad.ts`](../tests/carga/seguridad.ts)):** el script corre dentro de un contenedor de la red de la región 1 (con la imagen del gateway), para pedir directo al nginx de la región y leer `accesos_rechazados` cada 2 ms con el mismo reloj que la base. Crea una dueña con un viaje, una persona designada y un tercer usuario.
  * **Verificar el JWT:** el Validador de Intercepción de `packages/comun`, con las claves reales de Autenticación, verifica 5.000 veces el JWT de la dueña (es lo que hace cada validador en cada solicitud).
  * **Consultar el permiso:** `GET /api/viajes/viajes/{viajeId}` de la dueña (Viajes no consulta a nadie) contra el mismo pedido de la persona designada (Viajes le pregunta a Usuarios si está designada). La diferencia es lo que cuesta consultar el permiso.
  * **Registro:** se manda una solicitud con un `X-Request-Id` conocido y se mide cuánto tarda en aparecer esa fila en `accesos_rechazados` después de recibir la respuesta. Se probaron los dos caminos: `401` del gateway sin token (lo guarda directo) y `403` de Viajes cuando el tercer usuario pide el viaje de la dueña (llega por el evento `AccesoRechazado`).
* **Comandos reproducibles:**
  ```bash
  npm run infra:levantar
  npm run carga:seguridad                      # QA-9: costo del validador, del permiso y del registro
  npm run e2e -- seguridad                     # QA-8 y QA-9: aislamiento e itinerario compartido (P3.3)
  ```

| Medida pedida | Cómo se midió | Resultado medido | ¿Cumple? |
|---|---|---|---|
| La seguridad agrega menos de 200 ms | Verificar el JWT (5.000 veces) | p50 0,16 ms, p95 0,25 ms por validador. Cada solicitud pasa por 2 (gateway y servicio): 0,3 a 0,5 ms | Sí |
| | Consultar el permiso (designada − dueña, 300 de cada una) | Dueña: p50 2,9 ms, p95 3,8 ms. Designada: p50 4,3 ms, p95 5,5 ms. Diferencia: p50 1,4 ms, p95 1,7 ms | Sí |
| | Total por solicitud | Unos 2 ms (2 validadores y la consulta del permiso) | Sí |
| Registro en menos de 1 s | `401` del gateway, sin token (100) | p50 5,0 ms, p95 5,4 ms, máximo 10 ms después de la respuesta | Sí |
| | `403` de Viajes, viaje de otro usuario (100) | p50 9,9 ms, p95 15 ms, máximo 25 ms después de la respuesta. 0 rechazos sin registrar | Sí |
| Solo el dueño y las personas designadas ven el itinerario (también por el asistente) | `npm run e2e -- seguridad` (P3.3) y la prueba de QA-9 de [`services/asistente/test/asistente.integration.test.ts`](../services/asistente/test/asistente.integration.test.ts) | 7 de 7 pruebas e2e pasan: la persona designada ve el itinerario, los demás reciben `403` y cada rechazo queda en `accesos_rechazados`. El asistente no puede consultar reservas de otro usuario | Sí |

* **¿Cumple QA-9?** Sí: la seguridad agrega unos 2 ms (lo pedido: menos de 200 ms) y el registro tarda como máximo 25 ms (lo pedido: menos de 1 s).
* **Diferencias con la wiki:**
  * Verificar el JWT tarda 0,16 ms y no 1 ms, y consultar el permiso tarda 1,4 ms y no 20 ms. La wiki estima tiempos con la red entre servidores; acá todo está en una máquina. Aun sumando la red de producción, queda muy lejos de los 200 ms.
  * El registro de los rechazos de los servicios tarda más que el del gateway (p95 15 ms contra 5 ms) porque pasa por el broker. Coincide con la wiki: es asíncrono y tarda milisegundos.
  * En la primera medición de QA-8 (sección 2.4) los `403` de los servicios no se registraban. Con el consumidor de `AccesoRechazado` del gateway (PR #41) ahora sí: 100 de 100.

## 4. Idioma y formatos (`QA-11`, P4.1)

Mediciones contra el sistema levantado con `npm run infra:levantar` (global, `r1` y `r2`) y la web de `npm run web`, el 21/11/2026.

* **Medida pedida (Análisis inicial, escenario de QA-11):** un usuario quiere hacer una tarea habitual con la interfaz en su idioma y con sus formatos; la interfaz se presenta así y el usuario completa la tarea sin ayuda, en menos de 2 minutos y con menos de 5 % de errores.
* **Qué dice la wiki (Iteración 4, Paso 7):** cumplido en diseño. Los textos y formatos están en archivos de idioma separados del código y el sistema corre en dos regiones. La medida se toma en el prototipo con pruebas de usuarios. La Iteración 7 agrega las reglas del asistente por idioma (`reglas.<idioma>.yaml`).
* **Máquina:** la misma de la sección 2. La web corre con Vite en la misma computadora y el navegador es Chromium (Playwright), sin demora de red.
* **Escala de la carga:** la medida es de una persona haciendo una tarea, no de volumen: un usuario, dos idiomas (español `es-AR` e inglés `en-US`, los de `web/src/idiomas/`), 7 pantallas por idioma y 3 corridas.
* **Qué no se pudo medir:** el tiempo y los errores de personas reales. Eso lo tiene que hacer el grupo con usuarios (protocolo al final de la sección). Lo de acá mide lo que no depende de las personas: cuántos pasos lleva la tarea, si la interfaz cambia entera y si los formatos son los del idioma.
* **Cómo se midió ([`tests/carga/idioma.ts`](../tests/carga/idioma.ts)):** el script registra un usuario en español con un viaje de dos reservas (un vuelo en pesos y un hotel en dólares) y entra por la web con un navegador en español.
  * **Textos:** recorre las 7 pantallas (panel, detalle del viaje, archivados, correo, whitelist, preferencias y asistente) en cada idioma y busca líneas con textos del otro idioma (sacados de `es.json` y `en.json`) o con letras del español (á, é, í, ó, ú, ñ, ¿, ¡) en la interfaz en inglés. No cuentan el selector de idioma (cada idioma aparece con su propio nombre) ni el email del usuario.
  * **La tarea:** desde el panel, cambiar el idioma a inglés y guardarlo: Preferencias, elegir English y Guardar preferencias. Mide cuánto tarda la interfaz en cambiar y la tarea entera hecha por el navegador automático.
  * **Formatos:** fechas cortas, fechas con hora y montos del panel y del detalle del viaje, comparados con lo que da `Intl` para `es-AR` y `en-US`.
  * **Otro dispositivo:** después de guardar el idioma, entra con un navegador nuevo en español (sin nada guardado) y mira en qué idioma sale la web.
* **Comandos reproducibles:**
  ```bash
  npm run infra:levantar
  npm run carga:idioma                         # QA-11: textos, formatos y cambio de idioma (levanta la web si no está)
  ```

| Medida pedida | Cómo se midió | Resultado medido | ¿Cumple? |
|---|---|---|---|
| La interfaz en el idioma del usuario | Líneas con textos del otro idioma, 7 pantallas en cada idioma (378 líneas) | Español: 0 de 189. Inglés: 1 de 189, el saludo del asistente ("Hola, soy el asistente…"), porque la conversación se había empezado en español | En parte |
| Los formatos del usuario | Fechas, horas y montos del panel y del detalle, contra `Intl` | `es-AR`: 5 de 5 (`20/12/26`, `20/12/26, 5:30 a. m.`, `$ 125.000,50`, `US$ 480,00`). `en-US`: 5 de 5 (`12/20/26`, `12/20/26, 5:30 AM`, `ARS 125,000.50`, `$480.00`) | Sí |
| Completar la tarea en menos de 2 minutos | Cambiar el idioma a inglés y guardarlo, con el navegador automático (3 corridas) | 3 pasos. La interfaz cambia en 16 a 42 ms sin recargar; la tarea entera tarda 229 a 391 ms. No es el tiempo de una persona | Pendiente (pruebas con usuarios) |
| Menos de 5 % de errores | Errores de personas haciendo la tarea | No se midió: necesita personas | Pendiente (pruebas con usuarios) |
| El idioma elegido queda en la cuenta | Entrar desde otro navegador después de guardar el idioma | Sale en **español**. Usuarios guarda `idioma = en` en el perfil, pero Autenticación sigue con `es` (el del registro) y la web toma el idioma del claim `idioma` del JWT al iniciar sesión | No |

* **¿Cumple QA-11?** En parte. Los textos y los formatos cambian enteros con el idioma, y la tarea lleva 3 pasos, sin recargar. Falta la prueba con usuarios para el tiempo y los errores. Además hay un error: el idioma guardado en Preferencias no llega a Autenticación, así que al volver a iniciar sesión (en otro dispositivo, o en el mismo después de cerrar sesión) la interfaz vuelve al idioma del registro.
* **Diferencias con la wiki:**
  * La wiki da QA-11 por cumplido en diseño con los archivos de idioma. En el prototipo eso se confirma para los textos y los formatos (0 textos sin traducir en las pantallas de la web, 10 de 10 formatos), pero el idioma de la cuenta queda guardado en dos lugares (el perfil de Usuarios y las credenciales de Autenticación) y solo se actualiza uno.
  * Una conversación del asistente sigue en el idioma en que empezó: la web la retoma y Asistente responde con las reglas de ese idioma. Una conversación nueva sale en el idioma nuevo.
* **Errores encontrados (no se cambió código, ver el aviso al grupo):**
  1. **El idioma del perfil no llega al JWT.** `PATCH /perfil` de Usuarios cambia `cuentas.idioma`, pero `credenciales.idioma` de Autenticación (de donde sale el claim `idioma`) queda con el valor del registro, y la web (`web/src/acciones.ts`, `iniciarSesion`) pasa la interfaz a ese idioma al entrar.
  2. **La conversación del asistente no cambia de idioma** al cambiar el de la interfaz (menor).
* **Protocolo para la prueba con usuarios (pendiente del grupo):** al menos 5 personas que no conozcan la aplicación, con una cuenta de prueba en español y un viaje cargado. Tarea: "Poné la aplicación en inglés y decime la fecha y el precio de tu vuelo". Se mide con cronómetro desde que ven el panel hasta que responden, y se anota como error cada paso equivocado (entrar a una pantalla que no era, elegir otra opción) y cada dato mal leído. Cumple si todas terminan en menos de 2 minutos y los errores son menos del 5 % de los pasos.

## 5. Cambios de un proveedor sin aviso (`QA-1`, P4.1)

Mediciones contra el sistema levantado con `npm run infra:levantar` (global, `r1` y `r2`), el 21/11/2026.

* **Medida pedida (Análisis inicial, SEI 1):** un proveedor (aerolínea, hotel o rentadora) cambia una reserva en operación normal y el cambio se ve en la aplicación dentro de los 5 minutos posteriores.
* **Qué dice la wiki (Iteración 3, Paso 7):** cumplido. Peor caso: proveedor sin aviso, consultado cada 2 min, más segundos de traducción y broker, más 100 s de cola en un pico (Iteración 2): alrededor de 3 min 50 s.
* **Máquina:** la misma de la sección 2. La consulta de Integraciones y el camino por el broker no dependen de la cantidad de usuarios, así que un cambio por usuario alcanza para medir el tiempo.
* **Escala de la carga:** 6 cambios, uno por usuario, en un ciclo de consulta. La cola de 100 s del pico es la tormenta de QA-5 (500.000 actualizaciones): se mide en esa sección con la escala del prototipo, y acá no se suma un número estimado.
* **Cómo se midió ([`tests/carga/proveedor-sin-aviso.ts`](../tests/carga/proveedor-sin-aviso.ts)):** el proveedor sin aviso es el mock del hotel, que Integraciones consulta cada 2 min (`INTERVALO_CONSULTA_PROVEEDORES_SEG=120`).
  * **Hora de cada consulta:** una reserva "faro" del mock cambia cada segundo. Así cada consulta de la región 1 encuentra un cambio y actualiza `cursores_consulta.actualizado_en`, que el script lee cada 250 ms (corrigiendo la diferencia entre el reloj de la base y el de la computadora).
  * **Cambios:** 6 usuarios con una reserva del hotel cada uno (en el mock y en Viajes, con el mismo número). Justo después de una consulta, cada reserva cambia su salida en el mock, una a los 0 s (el peor caso: espera la consulta siguiente entera) y las otras a los 20, 40, 60, 80 y 100 s.
  * **Se ve en la aplicación:** se pide `GET /api/viajes/panel` de cada usuario cada 250 ms hasta que muestra la salida nueva. La resolución es de unos 0,4 s.
* **Comandos reproducibles:**
  ```bash
  npm run infra:levantar
  npm run carga:proveedor-sin-aviso            # QA-1: hotel sin aviso, cambio a los 0, 20, 40, 60, 80 y 100 s de una consulta
  ```

| Cambio después de una consulta | Espera hasta la consulta siguiente | De la consulta al panel | Total hasta verse en el panel |
|---|---|---|---|
| 0 s (peor caso) | 2 min 00 s | 0,29 s | **2 min 00 s** |
| 20 s | 1 min 40 s | 0,29 s | 1 min 40 s |
| 40 s | 1 min 20 s | 0,29 s | 1 min 20 s |
| 60 s | 1 min 00 s | 0,29 s | 1 min 00 s |
| 80 s | 40,0 s | 0,29 s | 40,3 s |
| 100 s | 19,9 s | 0,29 s | 20,2 s |

Las consultas se vieron cada 2 min 00 s (120,0 s las dos veces).

| Medida pedida | Cómo se midió | Resultado medido | ¿Cumple? |
|---|---|---|---|
| El cambio se ve en la aplicación en menos de 5 min | Peor caso sin pico: proveedor sin aviso, cambio justo después de una consulta | 2 min 00 s (2 min de espera a la consulta y 0,3 s de traducción, broker, Viajes y panel) | Sí |
| | Cambios en otros momentos del ciclo | De 20 s a 1 min 40 s: la espera es lo que falta para la próxima consulta | Sí |

* **¿Cumple QA-1?** Sí en operación normal, que es el ambiente del escenario: el peor caso tarda 2 min 00 s contra los 5 min pedidos. Con pico, el peor caso es este más la cola de la tormenta medida en QA-5.
* **Diferencias con la wiki:**
  * La wiki estima "segundos" para traducir y pasar por el broker. Medido: 0,3 s de la consulta al panel (Integraciones, outbox, broker, Viajes y el panel).
  * La espera a la consulta es justo el intervalo configurado (120 s). El peor caso sin pico es 2 min 00 s, contra los 2 min y segundos que estima la wiki. Los 100 s de cola del pico se comparan en QA-5.
  * La aerolínea avisa por webhook y no espera ninguna consulta: en QA-6 (sección 2.1) Integraciones procesó 1.000 cambios por webhook en 5,3 s. Por eso el peor caso es el del proveedor sin aviso.

## 6. Tiempo de respuesta del panel bajo carga (`QA-2`, P4.1)

Mediciones contra el sistema levantado con `npm run infra:levantar` (global, `r1` y `r2`), el 21/11/2026.

* **Medida pedida (Análisis inicial, SEI 2):** un usuario pide su panel de viajes desde la web en operación normal y el sistema responde en menos de 800 ms. La prueba pide el p95 bajo carga.
* **Qué dice la wiki (Iteración 4, Paso 7):** cumplido. El panel se responde desde la cache: red 100 ms + gateway 20 ms + cache 10 ms, alrededor de 150 ms. Desde la read replica, alrededor de 300 ms. En el pico, el 90 % sale de la cache (ADR-004, ADR-011).
* **Máquina:** la misma de la sección 2, con 45 contenedores (3 nodos de RabbitMQ por región). k6 corre en Docker en la misma computadora y le pide al enrutador global por `host.docker.internal:8000`. No hay red entre el usuario y la región: la wiki suma 100 ms de red, acá no están.
* **Escala de la carga (Análisis inicial, sección 7):** en el pico llegan 20.000 solicitudes por segundo y una instancia de un microservicio atiende 500 por segundo. El prototipo tiene una instancia del Servicio de Viajes por región, así que la carga proporcional es **500 paneles por segundo a la región 1**. Se subió en escalones de 60 s (100, 250, 500 y 1.000 por segundo) para ver también el límite. 500 usuarios de prueba, cada uno con un viaje.
* **Cómo se midió ([`tests/carga/panel.k6.js`](../tests/carga/panel.k6.js)):** k6 pide `GET /api/viajes/panel` de un usuario al azar a la tasa de cada escalón. Camino: enrutador global, nginx de la región 1, gateway (2 instancias, con el Validador de Intercepción) y Servicio de Viajes (cache Redis o read replica).
  * **El 10 % sin cache:** a la vez corren cambios manuales de reservas (`PATCH /reservas/{reservaId}`) al 10 % de la tasa del panel. Cada cambio invalida la cache de ese usuario y su próximo panel se lee de la read replica.
  * **Aciertos de la cache:** contadores `keyspace_hits` y `keyspace_misses` de Redis de la región 1 (`redis-cli INFO stats`), antes y después.
  * **Uso de procesador:** `docker stats` durante toda la prueba.
* **Comandos reproducibles:**
  ```bash
  npm run infra:levantar
  npm run carga:panel                          # QA-2: escalones de 100, 250, 500 y 1.000 paneles/s, con cambios al 10 %
  docker exec r1-redis-1 redis-cli INFO stats  # aciertos (keyspace_hits) y fallos (keyspace_misses) de la cache
  ```

| Paneles por segundo | Paneles pedidos | Mediana | p95 | p99 | Máximo | Errores | Procesador de Viajes |
|---|---|---|---|---|---|---|---|
| 100 | 6.001 | 3,7 ms | 5,6 ms | 7,8 ms | 71 ms | 0 | ~14 % |
| 250 | 15.001 | 3,4 ms | 5,0 ms | 7,9 ms | 44 ms | 0 | ~28 % |
| **500 (proporcional)** | 30.001 | 3,7 ms | **6,6 ms** | 12 ms | 48 ms | 2 (0,007 %) | ~54 % |
| 1.000 (el doble) | 60.000 | 12 ms | 89 ms | 128 ms | 264 ms | 2 (0,003 %) | ~97 % (saturado) |

El procesador es el de un núcleo: Viajes es un proceso de Node, así que 100 % es un núcleo lleno. Las 2 instancias del gateway usan unos 36 % cada una a 500/s y 71 % a 1.000/s.

| Medida pedida | Cómo se midió | Resultado medido | ¿Cumple? |
|---|---|---|---|
| p95 del panel menor a 800 ms bajo carga | 500 paneles/s (la carga de una instancia), con el 10 % de cambios | p95 6,6 ms y p99 12 ms (sin la red del usuario: con 100 ms de red, unos 107 ms) | Sí |
| | 1.000 paneles/s (el doble de una instancia) | p95 89 ms; Viajes al 97 % de un núcleo | Sí |
| El 90 % sale de la cache | Contadores de Redis durante toda la prueba | 100.416 aciertos y 10.583 fallos: **90,5 %** desde la cache | Sí |

* **¿Cumple QA-2?** Sí. Con la carga proporcional, el p95 es 6,6 ms. Sumando los 100 ms de red que supone la wiki, queda en unos 107 ms, lejos de los 800 ms.
* **Errores:** los 4 paneles y 20 cambios fallidos de toda la prueba (24 de 123.607 solicitudes) son `dial: i/o timeout`: la conexión de k6 al puerto 8000 de la computadora no llegó a abrirse. Es el reenvío de puertos de Docker Desktop con muchas conexiones nuevas, antes de llegar al enrutador. Ninguna solicitud recibió un error del sistema (ningún 5xx).
* **Diferencias con la wiki:**
  * La wiki estima unos 150 ms desde la cache y unos 300 ms desde la read replica, con 100 ms de red. Sin la red, el prototipo responde en milisegundos, también cuando el panel sale de la read replica: a 500/s ninguna solicitud tardó más de 48 ms.
  * La proporción de la cache coincide: 90,5 % medido contra el 90 % estimado.
  * La wiki supone 500 solicitudes por segundo por instancia. Viajes las atiende usando un poco más de medio núcleo, y se satura cerca de 1.000 por segundo: ahí el p95 sube a 89 ms, todavía muy debajo de 800 ms. Pasado ese punto hay que agregar instancias, que es lo que mide QA-5.
