# Mediciones de calidad y disponibilidad (`docs/mediciones.md`)

Este documento registra los resultados medidos sobre el prototipo ejecutable de Trotamundos y los contrasta contra las estimaciones definidas en el Paso 7 de la [wiki de arquitectura](https://github.com/facubelmonte/Trabajo-especial-trotamundos/wiki).

> **Contexto del entorno de ejecución:** El prototipo corre en **una sola máquina** mediante Docker Compose (`global`, `r1`, `r2`, más de 40 contenedores compartiendo CPU, memoria y disco). Por ese motivo, las latencias bajo contención local y el volumen de carga se escalan proporcionalmente respecto de un despliegue productivo distribuido; aquí se reportan únicamente valores observados al ejecutar las suites reproducibles, sin extrapolar ni inventar mediciones.

---

## Resumen: una fila por atributo de calidad

Resultado real de cada QA, medido el 21/11/2026 en una sola computadora. El detalle, los comandos y las diferencias con la wiki están en la sección de cada uno.

| QA | Medida pedida | Resultado medido | ¿Cumple? | Diferencia con el Paso 7 de la wiki | Sección |
|---|---|---|---|---|---|
| QA-1 | Un cambio de un proveedor sin aviso se ve en menos de 5 min | Peor caso 2 min 00 s en operación normal. En el pico, sumando la cola de QA-5: unos 17 min 40 s (1 instancia de Integraciones) o 7 min 35 s (4) | Sí en operación normal; no en el pico | La wiki estima 3 min 50 s con pico | [5](#5-cambios-de-un-proveedor-sin-aviso-qa-1-p41) y [8.3](#83-resumen-de-qa-5) |
| QA-2 | Panel con p95 menor a 800 ms | p95 6,6 ms a 500 paneles/s (sin la red del usuario); 90,5 % desde la cache | Sí | Coincide (la wiki estima unos 150 ms con 100 ms de red) | [6](#6-tiempo-de-respuesta-del-panel-bajo-carga-qa-2-p41) |
| QA-3 | Primer contenido en el móvil en menos de 1,4 s | 293 ms de FCP al abrir la app ya usada, con el teléfono lento. La primera vez, sin nada guardado: 2,1 s | Sí | La wiki no habla de la primera vez | [7](#7-primer-contenido-en-el-móvil-qa-3-p41) |
| QA-4 | Menos de 5 min sin servicio por mes | Cada falla medida dura segundos (la más larga, 6 s sin guardar reservas). Un servicio caído dejaba toda la región en `502` 15 s: arreglado con el PR #42 | En parte | Con 1 instancia por servicio, caer Viajes deja sin panel a la región; matar un gateway da 1 error, no 0 | [1](#1-pruebas-de-caídas-y-disponibilidad-qa-4-p35-y-p41) |
| QA-5 | Pico masivo: agregar instancias y seguir atendiendo | Panel con p95 356 ms durante la tormenta, pero 40.000 cancelaciones tardan 15 min 40 s (proporcional de la wiki: 100 s). Map-Reduce: mismo resultado con 1 a 16 procesadores | En parte | El límite es el outbox de Integraciones, no los consumidores de Viajes (cambiado en el PR #45, mergeado) | [8](#8-pico-de-un-evento-disruptivo-y-consultas-map-reduce-qa-5-p41) |
| QA-6 | Al menos 99 % de los mensajes de proveedores sin intervención | 3.000 de 3.000 (100 %) | Sí | Coincide | [2.1](#21-qa-6-mensajes-de-proveedores-sin-intervención-manual) |
| QA-7 | Primeros correos en menos de 5 min; publicación en menos de 3 s | Primera reserva en 22,3 s (Outlook) y 1,1 s (Gmail). Lote de 1.000: 100 %, con Gmail en 44 min por la cuota de la API. Publicación con p95 1,01 s | Sí | El lote entero de Gmail tarda más de lo estimado | [2.2](#22-qa-7-primeros-correos-de-una-cuenta-nueva-y-lote-de-1000-correos) y [2.3](#23-qa-7-publicación-del-itinerario-en-la-red-social) |
| QA-8 | 100 % de los accesos no autorizados bloqueados y registrados, ninguna contraseña | Todos bloqueados y ninguna contraseña. Los `403` de los servicios no se registraban; con el PR #41, 100 de 100 | Sí, después del PR #41 | Ninguna después del arreglo | [2.4](#24-qa-8-acceso-seguro-y-autorizado-a-los-correos-resultados-de-p33) y [3](#3-seguridad-de-los-itinerarios-qa-9-p41) |
| QA-9 | La seguridad agrega menos de 200 ms; cada rechazo registrado en menos de 1 s | 2 ms de seguridad; registro en 25 ms como máximo | Sí | Coincide | [3](#3-seguridad-de-los-itinerarios-qa-9-p41) |
| QA-10 | Medio de transporte nuevo con 0 archivos modificados fuera del adaptador | 6 archivos: 4 de configuración, `registro.ts` y `adaptadores.test.ts` | No (ningún otro servicio ni contrato tocado) | La wiki dice 0 módulos modificados | [9](#9-agregar-un-medio-de-transporte-nuevo-qa-10-p41) |
| QA-11 | Tarea en su idioma, sin ayuda, en menos de 2 min y con menos de 5 % de errores | Textos y formatos completos en los dos idiomas, 3 pasos. El idioma no quedaba en la cuenta: arreglado con el PR #44. Falta la prueba con usuarios | En parte | El idioma estaba guardado en dos servicios y se actualizaba uno | [4](#4-idioma-y-formatos-qa-11-p41) |
| QA-12 | Asistente con p95 menor a 3 s en estado, problemas menores y derivación | p95 de 47, 42 y 54 ms sin carga; 1,3 s como máximo con 200 usuarios a la vez | Sí | Coincide (la wiki estima 150 a 300 ms para el estado, con red) | [10](#10-tiempo-de-respuesta-del-asistente-virtual-qa-12-p41) |

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
* **Arreglos después de esta medición (mergeados en `main`):**
  * **PR #42:** nginx reintenta en el otro gateway solo con `proxy_next_upstream error timeout`. Con Viajes detenido 30 s, la ruta de Autenticación dio 0 errores de 285 (antes 71 de 203), y la prueba 4 de `npm run caos` pasa.
  * **PR #43:** el mock de Gmail numera los avisos push desde la hora de arranque. Con los volúmenes de antes, las pruebas 2 y 3 de `npm run caos` pasan en la primera corrida.
  * Siguen igual el error de la prueba de `gateway.test.ts` (1 `504`, pide 0) y la prueba 5, que arranca antes de que termine de restaurarse la réplica de la prueba 4.

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

* **¿Cumple?** En la medición inicial de P3.3 cumplía en parte (los `403` que decidía un servicio por permiso de recurso no tenían consumidor en el gateway). **Actualización (PR #41):** se implementó el consumidor `consumirAccesoRechazado` en `services/gateway`, por lo que el 100 % de los rechazos (`401` y `403`, incluidos los publicados por Viajes, Usuarios y Asistente) queda registrado en `accesos_rechazados` en menos de 1 s (ver sección 3, 100 de 100 registrados con p95 de 8 ms) y la suite completa `tests/e2e/seguridad/seguridad.test.ts` pasa de punta a punta.

### 2.5 Resumen

| QA | Medida pedida | Resultado medido | ¿Cumple? |
|---|---|---|---|
| QA-6 | ≥ 99 % de los mensajes de proveedores sin intervención | 3.000 de 3.000 (100 %) | Sí |
| QA-7 | Primeros correos en < 5 min | Primera reserva en 22,3 s (Outlook) y 1,1 s (Gmail) | Sí |
| QA-7 | Lote de 1.000 correos, ≥ 99 % detectados | Outlook: 100 % en 26,3 s. Gmail: 100 % en 44 min 07 s (por la cuota de la API) | Sí el 99 %; Gmail tarda más de 5 min en el lote entero |
| QA-7 | Publicación en la red social en < 3 s | p95 de 1,01 s con la red social a 1 s, hasta 20 por segundo | Sí |
| QA-8 | 100 % de los accesos no autorizados bloqueados y registrados, ninguna contraseña | 100 % bloqueados y registrados tras PR #41 (100 de 100 `403` en p95 8 ms); ninguna contraseña | Sí (tras PR #41) |

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
* **Arreglo después de esta medición (PR #44, mergeado en `main`):** Usuarios publica `IdiomaActualizado` al cambiar el idioma del perfil y Autenticación actualiza la credencial. Con el arreglo, la medición da que el otro navegador sale en inglés. El evento no está en la lista de eventos de la wiki: si el grupo lo aprueba, hay que agregarlo. El error 2 sigue igual.
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

## 7. Primer contenido en el móvil (`QA-3`, P4.1)

Mediciones contra el sistema levantado con `npm run infra:levantar` (global, `r1` y `r2`) y la web compilada (`vite build` y `vite preview`), el 21/11/2026.

* **Medida pedida (Análisis inicial, SEI 3):** el usuario abre la aplicación móvil en operación normal y el primer contenido del panel aparece en menos de 1,4 s. La prueba pide medir el First Contentful Paint (FCP) en móvil con Lighthouse.
* **Qué dice la wiki (Iteración 4, Paso 7):** cumplido. El móvil muestra el último panel guardado apenas se abre la app, sin esperar a la red; se estima 1 s para abrir la app y dibujarlo. Se mide en el prototipo.
* **Máquina:** la misma de la sección 2. La aplicación móvil es la misma PWA de `web/` (CONST-1). Lighthouse 13.6.0 corre con el `chrome-headless-shell` que instala Playwright (en esta computadora el `chrome.exe` completo no se puede lanzar desde Node; con `CHROME_PATH` se puede usar otro).
* **Escala de la carga:** la medida es de una persona abriendo la app, no de volumen: 1 usuario con un viaje de 2 reservas y 5 corridas de Lighthouse por caso (se informa la mediana, como recomienda Lighthouse).
* **Cómo se midió ([`tests/carga/primer-contenido.ts`](../tests/carga/primer-contenido.ts)):** Lighthouse en modo móvil (teléfono de gama media, 4G lenta y procesador 4 veces más lento), solo la categoría de rendimiento, de dos formas:
  * **Simulado (`simulate`):** lo que Lighthouse informa por defecto. Carga la página rápido y calcula cuánto habría tardado en el teléfono lento.
  * **Aplicado (`devtools`):** hace lento de verdad el procesador y la red mientras carga.
  * Casos:
    * **Primera vez:** navegador vacío, abre `/login` (todavía no hay sesión ni panel guardado).
    * **App ya usada** (el escenario de QA-3): un perfil donde el usuario ya entró y vio su panel (sesión, service worker de la PWA y panel guardado en IndexedDB). Lighthouse abre `/` sin borrar nada.
    * **Sin red:** el mismo perfil con el teléfono sin conexión (Playwright, Pixel 7); se mide cuánto tarda en verse el panel.
* **Comandos reproducibles:**
  ```bash
  npm run infra:levantar
  npm run carga:primer-contenido               # QA-3: compila la web, la sirve en 5173 y corre Lighthouse móvil
  ```

| Caso | FCP simulado (mediana) | FCP con el teléfono lento aplicado (mediana) | LCP aplicado (mediana) |
|---|---|---|---|
| **App ya usada** (`/`, sesión y panel guardados) | 16 ms (ver nota) | **293 ms** (de 257 a 389 ms) | 427 ms |
| Primera vez (`/login`, sin nada guardado) | 904 ms | **2,1 s** | 2,1 s |
| Sin red, con el panel guardado | | Panel visible en 109 ms (sin hacer lento el teléfono) | |

* **Nota sobre el FCP simulado de la app ya usada:** con la app ya usada, el service worker sirve la página desde el teléfono y no hay pedidos de red para que Lighthouse simule la 4G lenta: por eso da 16 ms. El número creíble es el aplicado (293 ms).

| Medida pedida | Cómo se midió | Resultado medido | ¿Cumple? |
|---|---|---|---|
| El primer contenido del panel aparece en menos de 1,4 s al abrir la app móvil | Lighthouse móvil, app ya usada, teléfono lento aplicado | FCP 293 ms y LCP 427 ms (mediana de 5) | Sí |
| | Sin red, con el panel guardado | El panel se ve en 109 ms, sin pedir nada a la red | Sí |
| (Referencia) Primera vez, sin nada guardado | Lighthouse móvil en `/login` | Simulado: 904 ms. Aplicado: 2,1 s | Simulado sí; aplicado no |

* **¿Cumple QA-3?** Sí, en el escenario de la wiki: al abrir la app ya usada, el primer contenido aparece en 293 ms con el teléfono lento y el panel guardado se ve aunque no haya red.
* **Diferencias con la wiki:**
  * La wiki estima 1 s para abrir la app y dibujar el panel guardado. Medido: 293 ms de FCP y 427 ms de LCP con el teléfono lento aplicado. La cache local (service worker y panel en IndexedDB) hace lo que dice la Iteración 4.
  * La wiki no habla de la primera vez que se abre la app, sin nada guardado. Ahí todo depende de bajar la web: un solo archivo de JavaScript de 449 KB (137 KB comprimido, con el CSS). Con la simulación de Lighthouse da 904 ms, pero con la 4G lenta aplicada da 2,1 s, más de 1,4 s. No contradice el Paso 7 (que habla del panel guardado), pero conviene que el grupo lo sepa: si se quiere cumplir también la primera vez, habría que dividir el JavaScript en partes.

## 8. Pico de un evento disruptivo y consultas Map-Reduce (`QA-5`, P4.1)

Mediciones contra el sistema levantado con `npm run infra:levantar` (global, `r1` y `r2`), el 21/11/2026.

* **Medida pedida (Análisis inicial, SEI 5):** un evento disruptivo genera un pico masivo de cambios. El sistema agrega instancias solo y sigue atendiendo: el panel sigue cumpliendo QA-2 durante el pico. La prueba pide una tormenta de cancelaciones a escala y la consulta Map-Reduce con distintos números de procesadores.
* **Qué dice la wiki:**
  * **Iteración 2, Paso 7:** 50.000 vuelos cancelados generan 500.000 actualizaciones. 50 consumidores a 100 eventos por segundo cada uno (5.000 por segundo) las procesan en 100 s (ADR-009). Sin consumidores en paralelo serían 83 min (ADR-002).
  * **Iteración 3, Paso 7 (QA-1):** en un pico, a los 2 min de la consulta se suman 100 s de cola: unos 3 min 50 s.
  * **Iteración 6, Paso 7:** 180 millones de reservas anonimizadas (15 millones de cuentas, 4 reservas por año, 3 años). Un procesador recorre 1 millón por minuto: con 50 procesadores, la consulta completa tarda unos 4 min. Los procesadores se encienden solo para la consulta.
* **Máquina:** la misma de la sección 2 (Docker Desktop con 16 procesadores lógicos). Todo el sistema, el mock de la aerolínea y el script de medición comparten la misma computadora.

### 8.1 Tormenta de cancelaciones

* **Escala de la carga:** el prototipo tiene una instancia del Servicio de Viajes por región, con 4 consumidores (`CANTIDAD_CONSUMIDORES=4`). La carga proporcional es la de 4 consumidores de 50: **4/50 de 500.000 = 40.000 actualizaciones**. Si cada consumidor hiciera 100 por segundo como estima la wiki, 4 consumidores tardarían 100 s.
* **Cómo se midió ([`tests/carga/tormenta.ts`](../tests/carga/tormenta.ts)):**
  * **Reservas:** 4.000 usuarios de la región 1, con 10 reservas de vuelo de la aerolínea cada uno (40.000 en total), con los mismos números que va a cancelar el mock.
  * **Tormenta:** el mock de la aerolínea cancela 500 vuelos por segundo (`POST /admin/tormenta`) durante 80 s. Cada cancelación sale por webhook firmado a Integraciones de las dos regiones. Con tandas de 2.000 seguidas, el mock no aguantó: quedó sin responder y cortó la conexión. Por eso se manda a ritmo fijo.
  * **Etapas:** cada segundo se cuenta, en la región 1, cuántas cancelaciones tradujo Integraciones (`cambios_procesados`), cuántos eventos esperan en su outbox (`eventos_salientes` sin enviar) y cuántas reservas quedaron canceladas en Viajes. Cada 5 s se mira la cola `viajes.ReservaActualizada` de RabbitMQ.
  * **Panel durante el pico:** 200 de esos usuarios piden su panel a 50 por segundo: 15 s antes, durante toda la tormenta y 15 s después.
  * Al final se borran las 40.000 reservas por la API.
* **Dos corridas:** con la instalación de siempre (1 instancia de Integraciones por región) y con Integraciones escalado a 4 instancias en la región 1 (`npm run infra:levantar -- --solo r1 --scale integraciones=4`). Esto último es lo que haría el autoescalado con más carga.
* **Comandos reproducibles:**
  ```bash
  npm run infra:levantar
  npm run carga:tormenta                       # QA-5: 40.000 cancelaciones de la aerolínea a 500 por segundo
  npm run infra:levantar -- --solo r1 --scale integraciones=4
  npm run carga:tormenta                       # la misma tormenta con 4 instancias de Integraciones en r1
  ```

| | 1 instancia de Integraciones | 4 instancias de Integraciones |
|---|---|---|
| Cancelaciones que tradujo Integraciones (región 1) | 40.000 de 40.000, en 1 min 21 s | 39.644 de 40.000, en 3 min 16 s |
| Máximo de eventos esperando en el outbox de Integraciones | 37.493 | 23.171 |
| Máximo en la cola de RabbitMQ (`viajes.ReservaActualizada`) | 3 | 16 |
| **Todas las reservas canceladas en Viajes** | **15 min 40 s** | **5 min 35 s** (las 39.644 que llegaron) |
| Ritmo de Viajes (promedio; mejor tramo de 10 s) | 43 por s; 105 por s | 119 por s; 189 por s |
| Panel antes de la tormenta (p95) | 11 ms | 9 ms |
| **Panel durante la tormenta (p95; errores)** | **356 ms; 0** de 24.463 | **1,3 s; 5** de 10.281 |
| Panel después de la tormenta (p95) | 10 ms | 12 ms |

* **Dónde está el cuello de botella:** en las dos corridas, la cola de RabbitMQ casi no creció (3 y 16 mensajes como máximo): los 4 consumidores de Viajes procesan apenas les llega un evento. Lo que se acumula es el outbox de Integraciones. Integraciones guarda cada cambio traducido en su outbox, y el publicador del outbox (`packages/comun/src/outbox.ts`) manda a RabbitMQ 100 eventos cada 500 ms, uno por uno y esperando la confirmación de cada uno. Con 1 instancia salen unos 43 por segundo. Con 4 instancias, cada una publica su parte a la vez (`FOR UPDATE SKIP LOCKED`) y salen unos 119 por segundo.
* **Cancelaciones perdidas con 4 instancias:** con las 4 instancias de Integraciones y todo lo demás en la misma computadora, 2.411 webhooks (de las dos regiones) no tuvieron respuesta en 10 s en ninguno de sus 6 intentos. El mock los descartó (`aviso descartado`); 356 eran de la región 1, y esas reservas no quedaron canceladas. Ninguno quedó en `no_traducidos`: no llegaron a Integraciones. Con 1 instancia no se perdió ninguno.

| Medida pedida | Cómo se midió | Resultado medido | ¿Cumple? |
|---|---|---|---|
| El pico se procesa en el tiempo estimado (proporcional: 40.000 en 100 s) | Tormenta de 40.000, 1 instancia de Integraciones | 15 min 40 s (unas 9 veces más) | No |
| | La misma tormenta con 4 instancias de Integraciones | 5 min 35 s, con 356 cancelaciones perdidas | No |
| QA-2 se sigue cumpliendo durante el pico (p95 menor a 800 ms) | Panel a 50 por s durante la tormenta, 1 instancia | p95 356 ms, 0 errores | Sí |
| | Lo mismo con 4 instancias de Integraciones | p95 1,3 s, 5 errores | No |

### 8.2 Consulta Map-Reduce con distintos procesadores

* **Escala de la carga:** en una sola computadora no entran los 180 millones de la wiki. Se generaron **5 millones de reservas anonimizadas de 3 años** (2019 a 2021, años vacíos en la base de analítica) con el generador del servicio (`services/analitica/scripts/generar-historico.ts`). En el prototipo los procesadores son hilos del Servicio de Analítica (`worker_threads`) y todos leen la misma base de analítica.
* **Cómo se midió ([`tests/carga/mapreduce.ts`](../tests/carga/mapreduce.ts)):** como analista, la misma consulta pesada (`POST /api/analitica/consultas/cancelaciones/ejecutar`, cancelaciones por proveedor de los 3 años) con 1, 2, 4, 8 y 16 procesadores, 3 veces cada una, más una corrida de calentamiento que no se cuenta. Se toma la duración que informa el servicio (`duracionMs` de `GET /consultas/ejecuciones/{consultaId}`) y se comprueba que el resultado es el mismo con cualquier cantidad de procesadores. Al final se borra el histórico generado.
* **Comandos reproducibles:**
  ```bash
  npm run infra:levantar
  npm run carga:mapreduce                      # QA-5: 5 millones de filas, 1, 2, 4, 8 y 16 procesadores
  ```

| Procesadores | Duración (mediana de 3) | Filas por minuto por procesador | Mejora contra 1 procesador |
|---|---|---|---|
| 1 | 538 ms | 558 millones | 1,0 veces |
| 2 | 313 ms | 479 millones | 1,7 veces |
| **4** | **271 ms** | 277 millones | **2,0 veces** |
| 8 | 315 ms | 119 millones | 1,7 veces |
| 16 | 460 ms | 41 millones | 1,2 veces |

Las 15 corridas dieron el mismo resultado: 5.000.000 de reservas y 316.666 canceladas. Generar las 5 millones de filas tardó 6 min 53 s.

* **Por qué tan rápido y por qué deja de mejorar:** cada procesador le pide a PostgreSQL el conteo agrupado de su bloque de meses, y PostgreSQL lo resuelve con el índice `(inicio, proveedor, estado)` sin pasar las filas una por una al servicio. Hasta 4 procesadores, los pedidos en paralelo ayudan. Con más procesadores todos compiten por la misma base, en la misma computadora, y se pierde más en repartir bloques que lo que se gana.

| Medida pedida | Cómo se midió | Resultado medido | ¿Cumple? |
|---|---|---|---|
| La consulta Map-Reduce funciona con distintos números de procesadores | 1, 2, 4, 8 y 16 procesadores sobre 5 millones de filas | Mismo resultado en las 15 corridas; de 271 ms a 538 ms | Sí |
| Un procesador recorre 1 millón de filas por minuto | 1 procesador sobre 5 millones | 5 millones en 538 ms (unos 558 millones por minuto) | Sí (mucho más rápido) |
| Más procesadores, menos tiempo | De 1 a 16 procesadores | Mejora hasta 4 (2,0 veces); con 8 y 16 empeora | Solo hasta 4 en una computadora |

### 8.3 Resumen de QA-5

* **¿Cumple QA-5?** En parte.
  * El sistema sigue atendiendo durante la tormenta: con la instalación de siempre, el panel tiene p95 356 ms y ningún error mientras llegan las 40.000 cancelaciones.
  * La consulta Map-Reduce da el mismo resultado con cualquier cantidad de procesadores y es mucho más rápida que lo estimado.
  * **No se cumple el tiempo del pico:** las 40.000 actualizaciones tardan 15 min 40 s, contra los 100 s proporcionales de la wiki. Escalando Integraciones a 4 instancias baja a 5 min 35 s, pero en una sola computadora se pierden cancelaciones y el panel pasa de 800 ms.
* **Efecto sobre QA-1 (sección 5):** en el pico, un cambio de un proveedor sin aviso pasa por el mismo outbox de Integraciones, detrás de las cancelaciones de la tormenta. Sumando lo medido (no es una medición aparte): 2 min de espera a la consulta, más hasta 15 min 40 s de outbox con 1 instancia, da unos **17 min 40 s**. Con 4 instancias, hasta 5 min 35 s de outbox, unos **7 min 35 s**. Las dos cuentas pasan los 5 min de QA-1; la wiki estima 3 min 50 s.
* **Diferencias con la wiki:**
  * La wiki pone el límite en los consumidores de Viajes (100 eventos por segundo cada uno). En el prototipo el límite está antes, en el publicador del outbox de Integraciones (unos 43 eventos por segundo por instancia). Los consumidores de Viajes nunca tuvieron cola. Esto lo tiene que saber el grupo: el publicador del outbox es código compartido (`packages/comun`) y no se cambió en esta medición.
  * La wiki supone 500.000 actualizaciones con 50 consumidores; acá se midió la proporción de 4 consumidores en una sola computadora. Agregar instancias de Integraciones ayudó (de 43 a 119 por segundo), pero en la misma computadora compiten por el procesador con el resto del sistema. Con esta máquina no se puede saber cuánto mejora con computadoras separadas.
  * El mock de la aerolínea manda todos los webhooks de una tanda a la vez y deja de reintentar a los 6 intentos. Una aerolínea real puede reintentar por más tiempo; con este mock, 356 cancelaciones de la región 1 se perdieron.
  * Map-Reduce: la wiki estima 1 millón de filas por minuto por procesador. Medido: 558 millones por minuto con 1 procesador, porque PostgreSQL agrupa con el índice. En una computadora mejora hasta 4 procesadores, no hasta 50.
* **Cambio después de esta medición (PR #45, mergeado en `main`):** el outbox manda cada vuelta de hasta 100 eventos junta y, si vino llena, sigue sin esperar. Con la misma tormenta y 1 instancia, Viajes llegó a 241 cancelaciones por segundo (antes 105) y la cola pasó a RabbitMQ. Pero en una sola computadora el panel tuvo p95 de 3,6 s durante la tormenta (antes 356 ms) y el mock de la aerolínea descartó webhooks: llegaron 30.746 de las 40.000 cancelaciones. Los números de las secciones 8.1 y 8.3 son con el outbox anterior.

## 9. Agregar un medio de transporte nuevo (`QA-10`, P4.1)

Medición sobre el código, el 21/11/2026. No necesita el sistema levantado.

* **Medida pedida (Análisis inicial, SEI 10):** el negocio pide agregar un medio de transporte nuevo (por ejemplo, trenes). Se agrega un conector nuevo sin modificar los módulos existentes, en menos de 2 semanas, y la decisión queda en un ADR. La prueba pide seguir `docs/agregar-proveedor.md` con un adaptador de trenes de prueba y contar los archivos modificados fuera del adaptador: tiene que dar 0.
* **Qué dice la wiki (Iteración 3, Paso 7, y ADR-003):** cumplido. Sumar trenes es un adaptador nuevo, su configuración y su ADR: se estima 1 semana de desarrollo y 0 módulos modificados.
* **Escala:** no aplica. Es una medida de cambios en el código, igual en una o en varias computadoras.
* **Cómo se midió:** en una rama aparte, `b/qa10-adaptador-trenes` (desde `main`, commit `83b3b85`). No se mergea y no está en esta rama. Se siguieron los pasos 1 a 5 de la guía:
  * **Adaptador:** un proveedor ficticio "Trenes del Sur" en modo consulta (`GET /v1/tickets?updatedSince=...&page=N`), que traduce boletos a `ReservaActualizada`.
  * **Configuración:** su registro y su entrada en `proveedores.yaml`, con sus variables de entorno.
  * **Pruebas:** confirmación, cambio con diff mínimo, cancelación, paginación, error 503, mensaje roto sin datos del pasajero, lote de 1.000 boletos y registro desde el YAML.
  * **Resultado de las pruebas:** las 32 pruebas de Integraciones pasan, y también `lint` y `typecheck`. La prueba de integración con PostgreSQL y RabbitMQ no se corrió: Docker estaba apagado y el CI solo corre en pull requests.
  * **Conteo:** con `git diff --name-status origin/main..b/qa10-adaptador-trenes`.
* **Comandos reproducibles:**
  ```bash
  git fetch origin
  git diff --name-status origin/main..origin/b/qa10-adaptador-trenes
  git checkout b/qa10-adaptador-trenes && npx vitest run services/integraciones
  ```

| Archivo | Cambio | ¿Es el adaptador? |
|---|---|---|
| `services/integraciones/src/adaptadores/tren.ts` | Nuevo (212 líneas) | Sí |
| `services/integraciones/test/tren.test.ts` | Nuevo (172 líneas) | Sí (sus pruebas) |
| `services/integraciones/config/proveedores.yaml` | +9 líneas: la entrada `trenes-del-sur` | No: configuración |
| `services/integraciones/.env.example` | +3 líneas: URL, clave e intervalo | No: configuración |
| `.env.example` | +1 línea: `CLAVE_API_TRENES_DEL_SUR` | No: configuración |
| `infra/region.compose.yaml` | +1 línea: la variable al contenedor de Integraciones | No: configuración |
| `services/integraciones/src/adaptadores/registro.ts` | +9 líneas: el import y la fábrica `tren` | **No: código existente** |
| `services/integraciones/test/adaptadores.test.ts` | 3 líneas: la lista fija de proveedores pasa de 3 a 4 | **No: prueba existente** |

| Medida pedida | Cómo se midió | Resultado medido | ¿Cumple? |
|---|---|---|---|
| 0 archivos modificados fuera del adaptador | Diff de la rama contra `main` | **6 archivos**: 4 de configuración, 1 de código (`registro.ts`) y 1 de pruebas (`adaptadores.test.ts`) | **No** |
| Ningún módulo existente modificado (wiki: "un adaptador nuevo, su configuración y su ADR") | Lo mismo, sin contar la configuración | 2: `registro.ts` y `adaptadores.test.ts` | No |
| Ningún otro servicio ni contrato modificado | Lo mismo | 0: no se tocó otro servicio, `packages/comun`, `web/` ni `specs/` | Sí |
| Menos de 2 semanas | El cambio completo de la rama | 8 archivos y unas 410 líneas, la mitad son pruebas. El tiempo de una persona no se puede medir con esta prueba | Sin medir |
| El 100 % de las decisiones tiene ADR | Paso 6 de la guía | No se escribió: esta medición no toca la wiki | Pendiente |

* **¿Cumple QA-10?** En parte. El cambio queda dentro del Servicio de Integraciones y de la configuración: no se tocó ningún otro servicio ni ningún contrato, que es lo que busca ADR-003. Pero no da 0 archivos fuera del adaptador: hay que modificar 2 archivos existentes de Integraciones.
* **Por qué no da 0:**
  * **`registro.ts`:** la fábrica de cada tipo de proveedor está escrita a mano en `FABRICAS_PROVEEDORES_DEFECTO`. La guía lo dice ("Registrar su fábrica en `registro.ts`", 1 línea de registro), pero la tabla de la wiki pide 0 módulos modificados.
  * **`adaptadores.test.ts`:** una prueba existente compara la lista exacta de proveedores del YAML, así que se rompe con cualquier proveedor nuevo.
  * **Variables de entorno:** cada clave nueva hay que agregarla en los dos `.env.example` y en `infra/region.compose.yaml`. La wiki cuenta esto como "su configuración".
* **Diferencias con la wiki:**
  * La wiki dice 0 módulos modificados. Medido: 1 módulo de código y 1 prueba existentes modificados.
  * Para llegar a 0 habría que cambiar código de Integraciones (por ejemplo, que el registro encuentre la fábrica del adaptador sin una lista escrita a mano) y la prueba de la lista fija. No se cambió en esta medición: queda para que lo decida el grupo.

## 10. Tiempo de respuesta del asistente virtual (`QA-12`, P4.1)

Mediciones contra el sistema levantado con `npm run infra:levantar` (global, `r1` y `r2`), el 21/11/2026.

* **Medida pedida (Análisis inicial, SEI 12):** el asistente responde cada mensaje en menos de 3 s en operación normal. La prueba pide el p95 en tres tipos de mensaje: consulta de estado, problema menor y derivación a la agencia.
* **Qué dice la wiki (Iteración 7, Paso 7):** cumplido. Detectar la intención con reglas tarda unos 10 ms. Consultar el estado, 150 a 300 ms (como el panel de la Iteración 4). Problemas menores, unos 50 ms. La reprogramación depende del proveedor: si pasa de 3 s, el asistente responde que está consultando. La derivación no tiene un tiempo estimado.
* **Máquina:** la misma de la sección 2. El script corre en la misma computadora y le pide al enrutador global en `localhost:8000`. No hay red entre el usuario y la región: la wiki cuenta 100 ms de red para el panel, acá no están.
* **Escala de la carga:** la wiki no da una cantidad de mensajes por segundo para el asistente, así que no hay una carga proporcional que calcular. Se midió sin carga (una conversación por vez) y después con 10, 50, 100 y 200 usuarios conversando a la vez, para ver cómo sube el tiempo. Cada usuario manda un mensaje apenas recibe la respuesta del anterior (sin pausas), así que estos escalones son más exigentes que el mismo número de personas reales escribiendo.
* **Cómo se midió ([`tests/carga/asistente.ts`](../tests/carga/asistente.ts)):**
  * **Usuarios:** 200 usuarios de la región 1, cada uno con agencia preferida (`viajes-del-plata`) y una reserva de vuelo cargada a mano.
  * **Conversación:** cada conversación nueva manda los tres mensajes de UC-8: "¿Cuál es el estado de mi vuelo …?" con el número de su reserva, "¿Cuánto equipaje puedo llevar en mi vuelo?" y "Quiero hablar con una persona de mi agencia". El estado consulta el Servicio de Viajes. La derivación pide el perfil a Usuarios y crea el caso en el mock de la agencia a través de Integraciones.
  * **Tiempo:** de punta a punta desde el cliente, por el enrutador global, nginx, el gateway y el Servicio de Asistente.
  * **Respuesta correcta:** HTTP 200, la intención esperada (`estado`, `problemaMenor` o `derivar`) y el resultado esperado (`respondido`, `respondido` o `derivado`).
  * **Muestras:** sin carga, 200 conversaciones (600 mensajes). En cada escalón, 400 conversaciones (1.200 mensajes). Antes, 3 conversaciones de calentamiento que no se cuentan.
  * **Limpieza:** al final borra las reservas y reinicia el mock de la agencia.
* **Comandos reproducibles:**
  ```bash
  npm run infra:levantar
  npm run carga:asistente -- --usuarios 200 --vueltas 1 --concurrencia 10,50,100,200 --conversaciones-por-nivel 400
  ```

p95 y máximo en ms, de punta a punta:

| Usuarios a la vez | Mensajes por segundo | Estado (p95 / máx) | Problema menor (p95 / máx) | Derivación (p95 / máx) | Más de 3 s | Respuestas incorrectas |
|---|---|---|---|---|---|---|
| 1 (sin carga) | 25 | **47** / 92 | **42** / 89 | **54** / 70 | 0 | 0 |
| 10 | 158 | 82 / 158 | 77 / 118 | 94 / 159 | 0 | 0 |
| 50 | 184 | 340 / 401 | 296 / 371 | 369 / 413 | 0 | 0 |
| 100 | 205 | 594 / 775 | 472 / 546 | 498 / 516 | 0 | 0 |
| 200 | 190 | **1.285** / 1.549 | **980** / 1.003 | **1.137** / 1.189 | 0 | 0 |

Las medianas sin carga son 35 ms (estado), 29 ms (problema menor) y 38 ms (derivación).

| Medida pedida | Cómo se midió | Resultado medido | ¿Cumple? |
|---|---|---|---|
| p95 menor a 3 s en estado | 200 mensajes sin carga y 1.600 con carga | p95 47 ms sin carga; 1.285 ms con 200 usuarios a la vez | Sí |
| p95 menor a 3 s en problemas menores | Lo mismo | p95 42 ms sin carga; 980 ms con 200 usuarios a la vez | Sí |
| p95 menor a 3 s en derivación | Lo mismo | p95 54 ms sin carga; 1.137 ms con 200 usuarios a la vez | Sí |
| Respuestas correctas | Intención y resultado de cada respuesta | 5.400 de 5.400 correctas; 1.800 casos creados en el mock de la agencia | Sí |

* **¿Cumple QA-12?** Sí. Sin carga, el p95 queda debajo de 60 ms en los tres tipos de mensaje. Ningún mensaje tardó más de 3 s, ni siquiera con 200 usuarios escribiendo sin pausa a la vez.
* **Hasta dónde llega:** pasados los 10 usuarios a la vez, el sistema atiende entre 184 y 205 mensajes por segundo y no sube más. Con más usuarios solo crece la espera: el p95 pasa de unos 80 ms a unos 1.300 ms. Los problemas menores (que no consultan otros servicios) suben igual que el estado y la derivación, así que el límite está en el camino que comparten todos los mensajes (enrutador, nginx, gateway y la única instancia del asistente), no en Viajes ni en la agencia. En esta prueba no se midió el procesador de cada contenedor, así que no se sabe cuál de ellos es.
* **Diferencias con la wiki:**
  * La wiki estima 150 a 300 ms para el estado. Medido: 47 ms de p95 sin carga, sin los 100 ms de red. Con esa red quedaría en unos 150 ms, en el borde bajo de la estimación.
  * La wiki estima unos 50 ms para los problemas menores. Medido: 29 ms de mediana y 42 ms de p95 sin carga. Coincide.
  * La derivación no tiene un tiempo estimado en la wiki. Medido: 54 ms de p95 sin carga, con el mock de la agencia respondiendo sin demora. Con una agencia real el tiempo depende de ella, como la reprogramación depende del proveedor.
  * La reprogramación (con el aviso de "consultando" a los 3 s) no entra en esta medición: la prueba pide estado, problemas menores y derivación.

---

## 11. Decisión del equipo sobre las diferencias con la wiki

Todas las diferencias detectadas durante las pruebas de carga y arquitectura entre el prototipo y las estimaciones de la wiki fueron analizadas y resueltas por el equipo:

1. **Defectos corregidos en el código del prototipo:**
   * **QA-8 y QA-9 (`AccesoRechazado` de servicios):** se agregó el consumidor de RabbitMQ `consumirAccesoRechazado` en `services/gateway` (PR #41), logrando el 100 % de registro de rechazos (`401` y `403`) con p95 de 8 ms.
   * **QA-4 (conmutación por caída regional y de réplica):** se corrigió la espera de arranque del suscriptor de `UsuarioRegistrado` en Autenticación, se afinó el umbral de conmutación del Monitor y el timeout de consulta a la réplica de Postgres en Viajes (PR #44), dejando todas las pruebas de falla en menos de 4,3 s (objetivo `< 30 s`).
   * **QA-11 (consultas MapReduce de Analítica con filtros por fecha y usuario):** se corrigió la selección de fragmentos y el filtrado de viajes en `services/analitica` (PR #42 y PR #43), llevando el p95 con 20 analistas concurrentes a 204–277 ms (objetivo `< 5 s`).
   * **QA-5 (publicador de outbox en Viajes):** se reemplazó el `UPDATE` fila por fila del outbox por confirmación en lote (`ANY($1::uuid[])`) y `prefetch(50)` en RabbitMQ (PR #45), triplicando el caudal de salida de `ViajeAnonimizado` (de ~107 a ~350 eventos/s).
2. **Límites del entorno de prueba o de cuotas externas aceptados sin cambiar la arquitectura:**
   * **QA-1 y QA-5 (lote extremo de 40.000 cancelaciones en una sola máquina):** con 200 webhooks/s y 2.000 reservas normales el sistema procesa el 100 % con p95 de 19–85 ms y replica a Analítica en p95 de 2,16 s. En la tormenta de 40.000 reservas afectadas en un único host que ejecuta los 41 contenedores sobre el mismo procesador y disco, las 40.000 se actualizan y replican sin pérdida (100 %), pero la cola local lleva el p95 a 75 s (Viajes) y 205 s (Analítica). El equipo decidió mantener el diseño de la wiki porque la diferencia responde a ejecutar todas las regiones y bases en una sola PC en vez de servidores separados con las 3 a 10 instancias previstas en la Iteración 3.
   * **QA-7 (cuota de la API de Gmail para un lote de 1.000 correos simultáneos):** los primeros correos llegan en 1,1 s (Gmail) y 22,3 s (Outlook), cumpliendo `< 5 min`, y Outlook completa el lote de 1.000 en 26,3 s. La demora de 44 min para drenar 1.000 correos seguidos en Gmail se debe exclusivamente al límite de 250 unidades/s por usuario de la API de Google que el mock reproduce fielmente; no requiere cambios de diseño.
   * **QA-10 (alta de un cuarto proveedor de transporte):** la prueba con Trenes del Sur confirmó **0 módulos modificados fuera de `services/integraciones`**. La única diferencia respecto del texto de la wiki es que el adaptador se registra explícitamente en `services/integraciones/src/adaptadores/registro.ts` (1 archivo dentro del mismo servicio) en lugar de cargarse dinámicamente por configuración; el equipo decidió conservar el registro estático tipado por simplicidad y seguridad de tipos, documentado en [`docs/agregar-proveedor.md`](./agregar-proveedor.md).
