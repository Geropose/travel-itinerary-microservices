# Auditoría de Integraciones y Asistente

## 1. Alta — El asistente se queda en «consultando»

- **Archivo y línea.** [services/asistente/src/nucleo.ts:194](../services/asistente/src/nucleo.ts#L194) y [services/asistente/src/nucleo.ts:244](../services/asistente/src/nucleo.ts#L244).
- **Problema.** Si el proveedor responde justo mientras el asistente está guardando el aviso de «consultando», la respuesta final se pierde. El usuario sigue viendo el aviso aunque el proveedor ya haya contestado.
- **Cómo se reproduce.** Pedir una reprogramación, demorar la respuesta del proveedor hasta que el asistente empiece a guardar el aviso y hacer que el proveedor responda antes de que termine ese guardado.
- **Arreglo propuesto.** Una vez que se decide mostrar el aviso, asegurarse de guardar también la respuesta del proveedor, aunque llegue mientras se está guardando el aviso.
- **Prueba.** Consultar el historial una vez que el proveedor haya respondido y el asistente haya terminado de guardar el aviso. La prueba espera encontrar la respuesta final y que la consulta esté marcada como terminada. Antes del arreglo fallaba porque el último mensaje seguía siendo «consultando».
- **Estado.** Resuelto (PR #56): [services/asistente/src/nucleo.ts](../services/asistente/src/nucleo.ts) adjunta la continuación en segundo plano siempre que responde «consultando», y la prueba de [services/asistente/test/auditoria.test.ts](../services/asistente/test/auditoria.test.ts) corre en cada ejecución de CI.

## 2. Alta — Una reprogramación puede enviarse dos veces al proveedor

- **Archivo y línea.** [services/integraciones/src/rutas.ts:197](../services/integraciones/src/rutas.ts#L197) y [services/integraciones/src/rutas.ts:229](../services/integraciones/src/rutas.ts#L229).
- **Problema.** Cada instancia comprueba si la opción ya se aplicó y actualiza la base recién después de llamar al proveedor. Si dos instancias reciben la misma confirmación casi al mismo tiempo, ambas pueden ver la opción como pendiente y enviar la orden.
- **Cómo se reproduce.** Enviar la misma confirmación a dos instancias y mantener pendiente la primera llamada al proveedor hasta que la segunda instancia lea la opción.
- **Arreglo propuesto.** Usar la base compartida para reservar la operación antes de llamar al proveedor. Así, una sola instancia envía la orden y las solicitudes repetidas pueden recuperar el resultado guardado.
- **Prueba.** Enviar las dos confirmaciones y contar cuántas órdenes recibe el proveedor simulado. La prueba espera una sola orden. Antes del arreglo fallaba porque recibía dos.
- **Estado.** Resuelto (PR #56): la migración `003_reprogramacion_en_curso.sql`, [services/integraciones/src/repositorio.ts](../services/integraciones/src/repositorio.ts) y [services/integraciones/src/rutas.ts](../services/integraciones/src/rutas.ts) reservan atómicamente la opción con `en_curso_desde` antes de llamar al proveedor, y la prueba de [services/integraciones/test/auditoria.test.ts](../services/integraciones/test/auditoria.test.ts) corre en cada ejecución de CI.

## 3. Media — Una conexión puede volver al pool con un bloqueo activo

- **Archivo y línea.** [services/integraciones/src/repositorio.ts:234](../services/integraciones/src/repositorio.ts#L234) y [services/integraciones/src/consultador.ts:134](../services/integraciones/src/consultador.ts#L134).
- **Problema.** Si falla la liberación del bloqueo de una consulta periódica, el error se ignora y la conexión vuelve al pool. Si el bloqueo sigue activo, otras instancias pueden saltarse la consulta de ese proveedor.
- **Cómo se reproduce.** Simular una consulta periódica que adquiere el bloqueo y termina correctamente, pero falla al intentar liberarlo.
- **Arreglo propuesto.** Registrar el error y descartar esa conexión del pool cuando falle el desbloqueo.
- **Prueba.** Provocar el fallo con una conexión simulada y comprobar que se la descarte. Antes del arreglo fallaba porque la conexión se devolvía al pool como si el desbloqueo hubiera salido bien.
- **Estado.** Resuelto (PR #56): `liberarLockConsulta` propaga el error y [services/integraciones/src/consultador.ts](../services/integraciones/src/consultador.ts) registra la advertencia y descarta la conexión del pool (`release(error)`), verificado de forma continua en [services/integraciones/test/auditoria.test.ts](../services/integraciones/test/auditoria.test.ts).

## 4. Media — Una respuesta del chat anterior puede aparecer en el nuevo

- **Archivo y línea.** [web/src/pantallas/ChatAsistente.tsx:388](../web/src/pantallas/ChatAsistente.tsx#L388) y [web/src/pantallas/ChatAsistente.tsx:426](../web/src/pantallas/ChatAsistente.tsx#L426).
- **Problema.** Al abrir una conversación nueva se detienen las consultas periódicas del chat anterior. Si una ya estaba en curso, su respuesta todavía puede agregarse al chat que quedó abierto.
- **Cómo se reproduce.** Pedir una reprogramación, esperar a que el chat empiece a consultar por el resultado y abrir una conversación nueva antes de que llegue la respuesta.
- **Arreglo propuesto.** Antes de mostrar una respuesta, comprobar que corresponde a la conversación que sigue abierta. Si el usuario cambió de chat, ignorar el resultado anterior.
- **Prueba.** Demorar la respuesta de la primera conversación y enviarla cuando ya esté abierta la segunda. La prueba espera que el texto anterior no aparezca en el chat nuevo. Antes del arreglo fallaba porque el texto aparecía.
- **Estado.** Resuelto (PR #56): [web/src/pantallas/ChatAsistente.tsx](../web/src/pantallas/ChatAsistente.tsx) valida `conversacionActivaRef` y limpia la secuencia al abrir otra conversación, y la regresión de [web/e2e/pantallas-d.spec.ts](../web/e2e/pantallas-d.spec.ts) corre en cada ejecución de CI.
