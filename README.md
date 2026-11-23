# Trotamundos

Trotamundos reúne en un mismo panel las reservas y los itinerarios de un viajero. Detecta reservas en correos autorizados, incorpora cambios de aerolíneas, hoteles y rentadoras, y permite gestionar y compartir viajes. El asistente consulta estados, ayuda a reprogramar y deriva casos complejos a la agencia elegida. El equipo de datos puede consultar tendencias sobre un histórico anonimizado.

Es el prototipo del Trabajo Especial de Diseño de Sistemas de Software. Usa microservicios que se comunican mediante REST y eventos de RabbitMQ. La [wiki de arquitectura](https://github.com/facubelmonte/Trabajo-especial-trotamundos/wiki) reúne los requerimientos, las siete iteraciones de ADD, las vistas y los 19 ADR.

## Requisitos y arranque

- Docker Desktop abierto, con Docker Compose v2.
- Node.js 24 con npm. La versión está en [`.nvmrc`](.nvmrc).
- 16 GB de RAM como mínimo para el entorno local. Las mediciones de carga del proyecto se hicieron en un equipo con más memoria.
- Git para clonar el repositorio. También podés descargarlo desde **Code → Download ZIP**.

Desde la carpeta del repositorio, ejecutá estos tres comandos:

```bash
npm ci
npm run infra:levantar
npm run web
```

`infra:levantar` genera `.env` si hace falta, construye las imágenes y espera los chequeos de salud. Abrí [la web en localhost:5173](http://localhost:5173). El enrutador de la API escucha en [localhost:8000](http://localhost:8000/health). Para detener el entorno y conservar sus datos, ejecutá `npm run infra:bajar`.

También podés iniciar todo en un solo paso ejecutando [`iniciar.bat`](iniciar.bat) (Windows, con doble clic o desde la terminal) o `./iniciar.sh` ([`iniciar.sh`](iniciar.sh) en macOS/Linux/Git Bash): verifica Node.js 24 y Docker (abre Docker Desktop si está cerrado e intenta instalar los requisitos con `winget` en Windows si faltan), corre `npm ci` si faltan dependencias o cambió `package-lock.json`, levanta los contenedores, carga las semillas (`--sin-semillas` para omitirlas), inicia la web y abre `http://localhost:5173`.

## Usuarios de prueba

Con la infraestructura levantada, ejecutá `npm run semillas` en otra terminal si querés probar con cuentas ya configuradas. Carga 10 viajeros por región, conecta sus buzones de prueba y prepara reservas, filtros y permisos de itinerarios. También podés registrar un usuario desde la web.

| Cuenta | Región | Contraseña | Qué probar |
| --- | --- | --- | --- |
| `ana.garcia@correo.example` | `region-1` | `Viajar-2026!` | Panel, Gmail simulado, vuelo `XKQ7PL` y hotel `HC-48291`. |
| `bruno.diaz@correo.example` | `region-1` | `Viajar-2026!` | Itinerario de Ana compartido en modo lectura. |
| `karina.molina@correo.example` | `region-2` | `Viajar-2026!` | Panel de la segunda región y Gmail simulado. |
| `analista@trotamundos.example` | `region-1` y `region-2` | Valor de `CONTRASENA_ANALISTA` en el `.env` local | Consultas analíticas. La cuenta se crea al levantar la infraestructura. |

La contraseña de los viajeros es la que usa por defecto el [script de semillas](scripts/semillas.ts). La [demo de extremo a extremo](docs/demo.md) recorre el registro, la conexión OAuth, un cambio de vuelo, un itinerario compartido, Analítica y el chat.

## Mocks de sistemas externos

| Puerto local | Mock |
| --- | --- |
| `4001`, `4002` | Gmail y Outlook |
| `4003`, `4004`, `4005` | Aerolínea Andina, Hotel Cordillera y Rentadora Sur |
| `4006`, `4007` | Agencia Viajes del Plata y red social |

Usá las rutas de administración `/admin` para preparar el escenario. Los siguientes ejemplos se ejecutan desde Bash. En Windows también podés hacer las mismas solicitudes desde Postman con el método, la URL y el cuerpo JSON indicados.

**Inyectar un correo de reserva.** El buzón de Ana queda conectado al mock de Gmail después de ejecutar `npm run semillas`. La respuesta incluye el código de la reserva generada para buscarla en el panel. Usá otra semilla para generar un correo diferente.

```bash
curl -X POST 'http://localhost:4001/admin/buzones/ana.garcia@gmail.example/correos' \
  -H 'Content-Type: application/json' \
  -d '{"tipo":"vuelo","estado":"confirmada","semilla":8675}'
```

**Cambiar un vuelo.** Con el vuelo `XKQ7PL` visible en el panel de Ana, desplazá su horario 90 minutos. El mock envía el webhook firmado y el cambio llega al panel a través de Integraciones y Viajes.

```bash
curl -X POST 'http://localhost:4003/admin/ordenes/XKQ7PL/cambiar' \
  -H 'Content-Type: application/json' \
  -d '{"desplazarMinutos":90}'
```

**Simular demoras y fallas.** En el mock de Aerolínea, podés demorar 4 s la respuesta al pedir una reprogramación desde el chat, devolver un HTTP 503 o simular que el proveedor no responde. Restaurá el comportamiento normal al terminar.

```bash
curl -X PUT 'http://localhost:4003/admin/comportamiento' -H 'Content-Type: application/json' -d '{"demoraMs":4000,"modoFalla":"ninguna"}'
curl -X PUT 'http://localhost:4003/admin/comportamiento' -H 'Content-Type: application/json' -d '{"demoraMs":0,"modoFalla":"503"}'
curl -X PUT 'http://localhost:4003/admin/comportamiento' -H 'Content-Type: application/json' -d '{"demoraMs":0,"modoFalla":"no-responder"}'
curl -X DELETE 'http://localhost:4003/admin/comportamiento'
```

Más ejemplos y formatos en [los mocks de correo](mocks/comun/README.md), [el mock de Aerolínea](mocks/aerolinea/README.md) y [las especificaciones externas](specs/externos).

## Pruebas

| Tipo | Comando | Preparación |
| --- | --- | --- |
| Lint, formato y tipos | `npm run lint` y `npm run typecheck` | Dependencias instaladas. |
| Unitarias e integración de paquetes, servicios, mocks y web | `npm test` | Dependencias instaladas. Para correr un archivo, agregá `--` y su ruta. |
| Contratos estáticos | `npm run test:contratos` | Valida los contratos, los esquemas de eventos y el inventario de rutas. |
| Extremo a extremo del sistema | `npm run e2e` | Infraestructura levantada, con o sin las semillas. UC-3 espera el sondeo del hotel (120 s por defecto, ver abajo). Podés filtrar con `npm run e2e -- uc-8`, `npm run e2e -- seguridad` o `npm run e2e -- residencia`. |
| Contratos contra el sistema levantado | `npm run test:contratos -- --en-vivo` | Infraestructura levantada. Ejecuta E2E, verifica en vivo las 63 operaciones HTTP de los 9 contratos OpenAPI (A, B, C y D) y valida los 6 tipos de eventos de RabbitMQ capturados durante la suite. |
| Navegador y teléfono emulado (Playwright) | `npx playwright install chromium` y `npm run e2e:web` | La suite usa una API simulada y levanta la web compilada. |
| Caos y disponibilidad | `npm run caos` | Levantá con `npm run infra:levantar -- --ha` para el escenario con tres nodos de RabbitMQ por región. |
| Carga y mediciones | `npm run carga:panel`, `npm run carga:tormenta`, `npm run carga:mapreduce`, `npm run carga:asistente` | Infraestructura levantada. La guía de mediciones indica los demás comandos, perfiles, parámetros y requisitos de cada escenario. |

Para reproducir localmente el intervalo de consulta a proveedores que usa CI, levantá el entorno en Bash con `INTERVALO_CONSULTA_PROVEEDORES_SEG=5 npm run infra:levantar`. En PowerShell, fijá antes `$env:INTERVALO_CONSULTA_PROVEEDORES_SEG = '5'`. UC-3 espera la cancelación del hotel el intervalo de consulta más 30 s, así que con el intervalo normal de 120 s la prueba tarda hasta 2,5 minutos más. Si levantaste con otro intervalo, definí el mismo valor en la terminal donde corrés `npm run e2e`.

Los resultados de carga, caos, rendimiento y la decisión del equipo sobre las diferencias con la wiki están en [`docs/mediciones.md`](docs/mediciones.md). La cobertura HTTP en vivo (63 de 63 operaciones), las diferencias resueltas de contrato y sus dueños están en [`docs/contratos-prototipo.md`](docs/contratos-prototipo.md). Los informes de auditoría cruzada de la Fase 5 están en [`docs/auditoria-plataforma.md`](docs/auditoria-plataforma.md), [`docs/auditoria-usuarios-correo.md`](docs/auditoria-usuarios-correo.md), [`docs/auditoria-viajes-analitica.md`](docs/auditoria-viajes-analitica.md) y [`docs/auditoria-integraciones-asistente.md`](docs/auditoria-integraciones-asistente.md). La configuración de CI está en [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Qué simula el prototipo

| Decisión del diseño | Cómo se reproduce localmente | Para qué |
| --- | --- | --- |
| Dos regiones | Dos proyectos de Docker Compose, `r1` y `r2`, con servicios, redes y volúmenes regionales. El proyecto `global` pone en común el enrutador, los mocks y Postgres de Analítica. | Probar que cada usuario llega a su región de origen, incluso cuando inicia sesión desde la otra. |
| Dos centros de datos por región | Contenedores y volúmenes separados. Para Viajes, `postgres-viajes` representa el centro A y `postgres-viajes-replica` representa el B, dentro de la misma región. | Probar lecturas desde la réplica y promoverla al simular una caída de la base principal. Todo corre en una sola máquina. |
| Una base por servicio | El Postgres regional contiene una base lógica y un usuario propio por servicio, con accesos separados. Viajes tiene su Postgres principal y su réplica. La base global de Analítica recibe datos anonimizados. | Aislar los datos de cada servicio y mantener los datos personales en su región. |
| Sistemas externos | Los siete mocks imitan las APIs esperadas por los adaptadores: OAuth, avisos de correo, webhooks firmados, consultas periódicas y operaciones de agencia y red social. | Repetir escenarios con datos de prueba y controlar demoras y fallas. |
| Redundancia activa (ADR-006) | La wiki pide al menos 3 instancias de cada microservicio. Por defecto el entorno local levanta 2 gateways y 1 instancia de cada otro servicio, para que corra en una sola computadora. Con `npm run infra:levantar -- --ha` y `npm run infra:escalador` el mínimo pasa a 3, y `-- --scale gateway=3` fija las instancias de un servicio. | Cuidar la memoria en una PC. La diferencia está medida en [`docs/mediciones.md`](docs/mediciones.md#1-pruebas-de-caídas-y-disponibilidad-qa-4-p35-y-p41). |

Configuración en [Compose regional](infra/region.compose.yaml), [Compose global](infra/global.compose.yaml) y [creación de bases y usuarios](infra/postgres/crear-bases.sh). Diseño en la [Vista de despliegue](https://github.com/facubelmonte/Trabajo-especial-trotamundos/wiki/Vista-de-despliegue).

El código de los microservicios está en [`services/`](services), la app en [`web/`](web), los contratos en [`specs/`](specs) y el código compartido en [`packages/comun/`](packages/comun). Los puertos, responsables y convenciones de desarrollo están en [`docs/CONVENCIONES.md`](docs/CONVENCIONES.md).

## Trazabilidad

`UC` identifica casos de uso, `QA` atributos de calidad y `CONST` restricciones. La columna de resultados referencia mediciones publicadas o indica cuándo la evidencia es funcional o documental. Los resultados de carga corresponden a una sola máquina. Los componentes se cotejaron con la [Vista de módulos](https://github.com/facubelmonte/Trabajo-especial-trotamundos/wiki/Vista-de-modulos). Los números de iteración y ADR se pueden abrir desde el [índice de la wiki](https://github.com/facubelmonte/Trabajo-especial-trotamundos/wiki).

| Driver | Iteración | ADR | Componentes | Carpeta del código | Prueba o evidencia | Resultado en `docs/mediciones.md` |
| --- | --- | --- | --- | --- | --- | --- |
| UC-1 · Detectar reservas en el correo | 2, 3, 5 | 002, 003, 009, 010, 015 | Examinador, procesadores de correo, interfaz de adaptador de correo, Gmail y Outlook, consumidores de eventos de Viajes | [Correo](services/correo/src), [adaptadores](services/correo/src/adaptadores), [Viajes](services/viajes/src) | [UC-1](tests/e2e/uc-1.test.ts), [procesadores](services/correo/test/procesadores.integration.test.ts) | Sin medición propia. [§ 2.2](docs/mediciones.md#22-qa-7-primeros-correos-de-una-cuenta-nueva-y-lote-de-1000-correos) mide la primera reserva y el lote de correo. |
| UC-2 · Configurar filtros y whitelist | 5 | 002, 005, 015 | Filtros y whitelist de Usuarios, filtro de remitentes de Correo y pantalla de configuración | [Usuarios](services/usuarios/src), [Correo](services/correo/src), [pantallas](web/src/pantallas) | [UC-2](tests/e2e/uc-2.test.ts), [procesadores](services/correo/test/procesadores.integration.test.ts) | Sin medición propia. [§ 2.2](docs/mediciones.md#22-qa-7-primeros-correos-de-una-cuenta-nueva-y-lote-de-1000-correos) incluye remitentes fuera de la whitelist. |
| UC-3 · Recibir cambios y cancelaciones | 3 | 002, 003, 010 | Interfaz de adaptador de proveedor de viaje, adaptadores de Aerolínea, Hotel y Rentadora, configuración de proveedores, consumidores de Viajes | [Integraciones](services/integraciones/src), [configuración](services/integraciones/config), [Viajes](services/viajes/src) | [UC-3](tests/e2e/uc-3.test.ts), [adaptadores](services/integraciones/test/adaptadores.test.ts), [contratos HTTP](tests/e2e/openapi-d.test.ts) | Sin medición propia. [§ 2.1](docs/mediciones.md#21-qa-6-mensajes-de-proveedores-sin-intervención-manual) registra las cancelaciones y [§ 5](docs/mediciones.md#5-cambios-de-un-proveedor-sin-aviso-qa-1-p41) mide el sondeo. |
| UC-4 · Gestionar reservas desde el panel | 4 | 004, 011, 012 | Pantallas del panel y gestor de viajes | [pantallas](web/src/pantallas), [Viajes](services/viajes/src) | [UC-4](tests/e2e/uc-4.test.ts), [CQRS](services/viajes/test/cqrs.integration.test.ts), [pantallas](web/e2e/pantallas-c.spec.ts) | Sin medición propia. [§ 6](docs/mediciones.md#6-tiempo-de-respuesta-del-panel-bajo-carga-qa-2-p41) mide la lectura del panel. |
| UC-5 · Agrupar y archivar viajes | 2 | 002, 009 | Consumidores de eventos, gestor de viajes y tarea de archivado | [Viajes](services/viajes/src), [pantallas](web/src/pantallas) | [UC-5](tests/e2e/uc-5.test.ts), [archivado](services/viajes/test/archivado-itinerario.test.ts) | Sin medición propia. |
| UC-6 · Derivar a una agencia | 3, 7 | 003, 018, 019 | Adaptador de agencias, cuentas y preferencias de Usuarios, plug-in de derivación | [adaptadores](services/integraciones/src/adaptadores), [Usuarios](services/usuarios/src), [plug-ins](services/asistente/src/plugins) | [UC-6](tests/e2e/uc-6.test.ts), [UC-8](tests/e2e/uc-8.test.ts) | Sin medición propia. [§ 10](docs/mediciones.md#10-tiempo-de-respuesta-del-asistente-virtual-qa-12-p41) mide la derivación desde el chat. |
| UC-7 · Consultar el histórico de viajes | 6 | 002, 016, 017 | Contratos de eventos, anonimizador, procesadores Map-Reduce y consultas analíticas | [eventos](specs/asyncapi), [Analítica](services/analitica/src), [pantallas](web/src/pantallas) | [UC-7](tests/e2e/uc-7.test.ts), [consultas](services/analitica/test/consultas.integration.test.ts) | [§ 8.2](docs/mediciones.md#82-consulta-map-reduce-con-distintos-procesadores): mismo resultado con 1 a 16 procesadores. |
| UC-8 · Asistir por chat | 7 | 018, 019 | Ventana de chat, núcleo de conversación, reglas de intenciones, interfaz de plug-in y plug-ins de estado, problemas menores, reprogramación y derivación | [pantallas](web/src/pantallas), [Asistente](services/asistente/src), [reglas](services/asistente/config), [plug-ins](services/asistente/src/plugins) | [UC-8](tests/e2e/uc-8.test.ts), [reglas y plug-ins](services/asistente/test/reglas-plugins.test.ts), [pantallas](web/e2e/pantallas-d.spec.ts) | Sin medición funcional propia. [§ 10](docs/mediciones.md#10-tiempo-de-respuesta-del-asistente-virtual-qa-12-p41) mide estado, problemas menores y derivación. |
| QA-1 · Actualizar en menos de 5 min | 2, 3 | 002, 003, 009, 010 | Sondeo de Integraciones, RabbitMQ y gestor de viajes | [Integraciones](services/integraciones/src), [Viajes](services/viajes/src), [infra](infra) | [proveedor sin aviso](tests/carga/proveedor-sin-aviso.ts), [UC-3](tests/e2e/uc-3.test.ts) | [§ 5](docs/mediciones.md#5-cambios-de-un-proveedor-sin-aviso-qa-1-p41): peor caso normal de 2 min. Con la cola del pico, 17 min 40 s con una instancia o 7 min 35 s con cuatro. |
| QA-2 · Panel con p95 menor a 800 ms | 4, 6 | 004, 011, 012, 013, 016, 017 | Gestor de viajes, Redis, réplica de lectura y base analítica separada | [Viajes](services/viajes/src), [Analítica](services/analitica/src), [infra](infra) | [carga del panel](tests/carga/panel.k6.js), [CQRS](services/viajes/test/cqrs.integration.test.ts) | [§ 6](docs/mediciones.md#6-tiempo-de-respuesta-del-panel-bajo-carga-qa-2-p41): p95 de 6,6 ms a 500 paneles/s sin la red del usuario. El 90,5 % salió de la caché. |
| QA-3 · Primer contenido móvil en menos de 1,4 s | 4 | 004, 011 | Caché local del panel, PWA y service worker | [caché](web/src/cache), [web](web) | [primer contenido](tests/carga/primer-contenido.ts), [Playwright](web/e2e/web.spec.ts) | [§ 7](docs/mediciones.md#7-primer-contenido-en-el-móvil-qa-3-p41): 293 ms en una reapertura con datos guardados y 2,1 s en la primera visita. |
| QA-4 · Disponibilidad | 1, 4, 6, 7 | 001, 002, 006, 007, 008, 012, 013, 017, 019 | Monitor, balanceador nginx, enrutador global, Gateway, RabbitMQ, réplica de Viajes y degradación del asistente | [Monitor](services/monitor/src), [nginx](infra/nginx), [Enrutador](services/enrutador/src), [Gateway](services/gateway/src), [Asistente](services/asistente/src) | [caos](tests/caos), [failover](tests/carga/failover-viajes.ts), [degradación](services/asistente/test/degradacion.integration.test.ts) | [§ 1](docs/mediciones.md#1-pruebas-de-caídas-y-disponibilidad-qa-4-p35-y-p41): parcial. La primera escritura tras promover la réplica se aceptó a los 6 s. Las fallas medidas no validan el objetivo mensual completo. |
| QA-5 · Escalar durante picos | 1, 2, 4, 6 | 001, 002, 006, 008, 009, 011, 012, 016 | Escalador, balanceo, outbox de Integraciones, consumidores, caché y procesadores Map-Reduce | [infra](infra/scripts), [Integraciones](services/integraciones/src), [Viajes](services/viajes/src), [Analítica](services/analitica/src) | [tormenta](tests/carga/tormenta.ts), [Map-Reduce](tests/carga/mapreduce.ts) | [§ 8](docs/mediciones.md#8-pico-de-un-evento-disruptivo-y-consultas-map-reduce-qa-5-p41): parcial. p95 del panel de 356 ms durante la tormenta y 15 min 40 s para 40.000 cancelaciones. |
| QA-6 · Procesar al menos el 99 % de avisos | 3 | 002, 003 | Adaptadores de Aerolínea, Hotel y Rentadora, procesador y registro de avisos no traducidos | [Integraciones](services/integraciones/src), [mocks](mocks) | [carga de proveedores](tests/carga/proveedores.ts), [adaptadores](services/integraciones/test/adaptadores.test.ts) | [§ 2.1](docs/mediciones.md#21-qa-6-mensajes-de-proveedores-sin-intervención-manual): 3.000 de 3.000 mensajes de prueba traducidos. |
| QA-7 · Interoperar con correo y redes sociales | 3, 5 | 003, 010, 015 | Interfaz y adaptadores Gmail/Outlook, examinador y adaptador de redes sociales | [Correo](services/correo/src), [adaptadores](services/integraciones/src/adaptadores), [mocks](mocks) | [primeros correos](tests/carga/primeros-correos.ts), [publicación](tests/carga/publicacion.k6.js) | [§ 2.2](docs/mediciones.md#22-qa-7-primeros-correos-de-una-cuenta-nueva-y-lote-de-1000-correos) y [§ 2.3](docs/mediciones.md#23-qa-7-publicación-del-itinerario-en-la-red-social): primera reserva en 22,3 s (Outlook) y 1,1 s (Gmail). Publicación con p95 de 1,01 s. |
| QA-8 · Autorizar el acceso al correo | 5 | 005, 014, 015 | Inicio de sesión, credenciales, emisión de JWT, enrutamiento del API Gateway, Validador de Intercepción, tokens OAuth cifrados y registro de accesos | [Autenticación](services/autenticacion/src), [Gateway](services/gateway/src), [paquete común](packages/comun/src), [Correo](services/correo/src) | [seguridad](tests/e2e/seguridad/seguridad.test.ts), [cifrado](services/correo/test/cifrado.test.ts) | [§ 2.4](docs/mediciones.md#24-qa-8-acceso-seguro-y-autorizado-a-los-correos-resultados-de-p33) y [§ 3](docs/mediciones.md#3-seguridad-de-los-itinerarios-qa-9-p41): accesos bloqueados, ninguna contraseña de correo guardada y 100 de 100 rechazos registrados tras el PR #41. |
| QA-9 · Compartir solo con designados | 5, 7 | 005, 014, 018, 019 | Permisos de itinerarios de Usuarios, Validador de Intercepción, gestor de viajes y plug-in de estado | [Usuarios](services/usuarios/src), [Viajes](services/viajes/src), [paquete común](packages/comun/src), [plug-ins](services/asistente/src/plugins) | [seguridad](tests/e2e/seguridad/seguridad.test.ts), [carga de seguridad](tests/carga/seguridad.ts) | [§ 3](docs/mediciones.md#3-seguridad-de-los-itinerarios-qa-9-p41): 2 ms de sobrecosto y registro de rechazos en hasta 25 ms. |
| QA-10 · Incorporar otros medios de transporte | 3 | 003 | Interfaz de adaptador y configuración de proveedores. Adaptadores de trenes y autobuses previstos, sin código operativo. | [adaptadores](services/integraciones/src/adaptadores), [configuración](services/integraciones/config) | [adaptadores](services/integraciones/test/adaptadores.test.ts), [guía de extensión](docs/agregar-proveedor.md) | [§ 9](docs/mediciones.md#9-agregar-un-medio-de-transporte-nuevo-qa-10-p41): el ejercicio requirió seis archivos fuera del adaptador. El objetivo de cero cambios no se cumplió. |
| QA-11 · Usabilidad e internacionalización | 4, 7 | 004, 013, 018 | Archivos de idioma, preferencias de Usuarios, pantallas del panel y reglas del asistente por idioma | [idiomas](web/src/idiomas), [Usuarios](services/usuarios/src), [pantallas](web/src/pantallas), [reglas](services/asistente/config) | [idioma E2E](tests/e2e/idioma.test.ts), [medición](tests/carga/idioma.ts) | [§ 4](docs/mediciones.md#4-idioma-y-formatos-qa-11-p41): dos idiomas y tarea en tres pasos. Persistencia corregida en el PR #44. Falta medir tiempo y errores con usuarios. |
| QA-12 · Responder en menos de 3 s | 7 | 018, 019 | Núcleo de conversación, plug-ins y ventana de chat | [Asistente](services/asistente/src), [pantallas](web/src/pantallas) | [carga del asistente](tests/carga/asistente.ts), [degradación](services/asistente/test/degradacion.test.ts) | [§ 10](docs/mediciones.md#10-tiempo-de-respuesta-del-asistente-virtual-qa-12-p41): p95 de 47, 42 y 54 ms sin carga para estado, problemas menores y derivación. Máximo de 1,3 s con 200 usuarios simultáneos. |
| CONST-1 · Acceso web y móvil | 1, 4 | 001, 004 | Pantallas web y móvil, PWA y caché local | [web](web), [caché](web/src/cache) | [Playwright en computadora y teléfono](web/playwright.config.ts), [pruebas web](web/e2e) | Sin medición propia. [§ 7](docs/mediciones.md#7-primer-contenido-en-el-móvil-qa-3-p41) mide la PWA en el escenario móvil. |
| CONST-2 · Integrar mediante APIs de terceros | 3, 5 | 003, 015 | Adaptadores de proveedores de viaje, agencias, redes sociales y correo | [Integraciones](services/integraciones/src/adaptadores), [Correo](services/correo/src/adaptadores), [mocks](mocks), [specs externas](specs/externos) | [UC-3](tests/e2e/uc-3.test.ts), [UC-6](tests/e2e/uc-6.test.ts), [agencias y redes](services/integraciones/test/agencias-redes.test.ts) | Sin medición propia. [§ 2](docs/mediciones.md#2-interoperabilidad-y-seguridad-qa-6-qa-7-y-qa-8-p41) recoge las mediciones contra APIs simuladas. |
| CONST-3 · Documentar con ADR MADR y vistas | 1–7 | 001–019 | Wiki, decisiones y vistas de arquitectura | [wiki de GitHub](https://github.com/facubelmonte/Trabajo-especial-trotamundos/wiki) | Revisión documental del índice de ADR y de las vistas de contexto, módulos, componentes y conectores, despliegue y secuencia. | Sin medición. |
| CONST-4 · Completar al menos cuatro iteraciones ADD | 1–7 | 001–019 | Registro del proceso ADD | [wiki de GitHub](https://github.com/facubelmonte/Trabajo-especial-trotamundos/wiki) | Revisión documental: siete iteraciones publicadas, del diseño general al asistente. | Sin medición. |
| CONST-5 · Desarrollar a partir de contratos | Transversal (1–7) | 001, 002, 003, 005, 016, 018 | Contratos HTTP y de eventos, cliente generado de la web y validadores | [specs](specs), [paquete común](packages/comun/src), [API web](web/src/api) | [suite estática](tests/contratos), [contratos HTTP A](tests/e2e/openapi-a.test.ts), [B](tests/e2e/openapi-b.test.ts), [C](tests/e2e/openapi-c.test.ts) y [D](tests/e2e/openapi-d.test.ts), [captura RabbitMQ](tests/e2e/captura-contratos.ts) | Sin medición propia. El [informe de contratos](docs/contratos-prototipo.md) documenta la verificación en vivo de las 63 operaciones OpenAPI y los 6 eventos AsyncAPI (0 pendientes). |
| CONST-6 · Mantener los datos personales en la región de origen | 6, 7 | 012, 013, 016, 017 | Enrutador global, Postgres y réplica regional, anonimizador e historial de conversaciones | [Enrutador](services/enrutador/src), [Analítica](services/analitica/src), [Asistente](services/asistente/src), [infra](infra) | [residencia](tests/e2e/residencia/residencia.test.ts), [anonimización](services/analitica/test/anonimizador.integration.test.ts) | Sin medición propia. La suite verifica aislamiento, réplica en la misma región y reenvío del login. [§ 1](docs/mediciones.md#1-pruebas-de-caídas-y-disponibilidad-qa-4-p35-y-p41) mide el failover regional. |
