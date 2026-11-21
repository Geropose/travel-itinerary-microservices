# Mediciones de calidad y disponibilidad (`docs/mediciones.md`)

Este documento registra los resultados medidos sobre el prototipo ejecutable de Trotamundos y los contrasta contra las estimaciones definidas en el Paso 7 de la [wiki de arquitectura](https://github.com/facubelmonte/Trabajo-especial-trotamundos/wiki).

> **Contexto del entorno de ejecución:** El prototipo corre en **una sola máquina** mediante Docker Compose (`global`, `r1`, `r2`, más de 40 contenedores compartiendo CPU, memoria y disco). Por ese motivo, las latencias bajo contención local y el volumen de carga se escalan proporcionalmente respecto de un despliegue productivo distribuido; aquí se reportan únicamente valores observados al ejecutar las suites reproducibles, sin extrapolar ni inventar mediciones.

---

## 1. Pruebas de caídas y disponibilidad (`QA-4`, P3.5)

* **Objetivo de la wiki (Iteraciones 1, 4 y 6 — Paso 7):**
  * Indisponibilidad total tolerada: **máximo 5 min por mes**.
  * Caída de una instancia de aplicación: detección por ping-echo cada 5 s en **<= 15 s** (3 pings fallidos, `ADR-006`, `ADR-007`, `ADR-008`), reinicio automático y ~0 errores percibidos.
  * Caída de un nodo del cluster RabbitMQ (`--ha`, colas *quorum*): **0 eventos perdidos** (`ADR-002`).
  * Caída prolongada de un consumidor (`Viajes` detenido 2 min): los eventos esperan en el broker y se procesan al volver (`ADR-002`).
  * Caída de la base principal de `Viajes`: promoción de la *read replica* en la misma región en **alrededor de 1 min** (`ADR-012`, `ADR-017`).
  * Caída de Redis (`cache` del panel): degradación transparente hacia la *read replica* sin errores y cumpliendo `QA-2` (`< 800 ms`, `ADR-004`, `ADR-011`).

* **Comandos reproducibles:**
  ```bash
  npm run infra:levantar -- --ha
  npm run caos
  npm run infra:failover-viajes -- --solo r1
  ```

* **Suites involucradas:**
  * [`tests/caos/gateway.test.ts`](../tests/caos/gateway.test.ts)
  * [`tests/caos/disponibilidad.test.ts`](../tests/caos/disponibilidad.test.ts)
  * [`infra/scripts/failover-viajes.ts`](../infra/scripts/failover-viajes.ts)

| Escenario (`QA-4`) | Criterio de la wiki (Paso 7) | Cómo se mide en el prototipo | Resultado medido (errores / tiempos) | Estado |
|---|---|---|---|---|
| **1. Matar instancia de servicio (`r1-gateway-1`)** | Detección `<= 15 s`, reinicio automático, ~0 errores (`nginx` reintenta en réplica sana) | Generador continuo a `GET /api/viajes/panel` cada `100 ms` + `docker kill r1-gateway-1` + lectura de `r1-monitor-1 /estado` | *Pendiente corrida en vivo con stack Docker completo (`npm run caos`)* | Implementado |
| **2. Matar nodo de RabbitMQ (`--ha`, `r1-rabbitmq-2-1`)** | `0` eventos perdidos con colas *quorum* 2/3 (`ADR-002`) | Generador continuo al panel (`150 ms`) + `docker kill r1-rabbitmq-2-1` + inyección de 4 correos en `mock-gmail` verificados en panel | *Pendiente corrida en vivo con `--ha` (`npm run caos`)* | Implementado |
| **3. Detener `Viajes` 2 minutos (`r1-viajes-1`)** | Eventos pendientes en RabbitMQ se drenan al volver (`ADR-002`) | Pausar monitor + `docker stop r1-viajes-1` durante `120 s` mientras ingresan 1 reserva nueva por correo y 1 cambio por webhook HMAC de aerolínea; medir tiempo de drenado al volver | *Pendiente corrida en vivo con stack Docker completo (`npm run caos`)* | Implementado |
| **4. Detener principal `r1-postgres-viajes-1` + failover** | Promoción de la *read replica* en `<= 1 min` (`ADR-012`) y escritura/lectura operativa | Generador continuo al panel + `docker stop r1-postgres-viajes-1` + `npm run infra:failover-viajes -- --solo r1` + `POST /api/viajes/reservas` + `GET /api/viajes/panel` | *Pendiente corrida en vivo con stack Docker completo (`npm run caos`)* | Implementado |
| **5. Detener Redis (`r1-redis-1`)** | Degradación transparente a *read replica* (`X-Origen-Dato: replica`, `0` errores, `< 800 ms`) y recuperación de caché al volver | Generador continuo al panel (`100 ms`) tras calentar caché + `docker stop r1-redis-1` + verificación de retorno a `X-Origen-Dato: cache` tras `docker start` | *Pendiente corrida en vivo con stack Docker completo (`npm run caos`)* | Implementado |

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
