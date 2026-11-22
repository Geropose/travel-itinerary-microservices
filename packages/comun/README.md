# @trotamundos/comun — kit común de los servicios

Librería que usan todos los servicios de Trotamundos. Implementa las reglas de
`docs/CONVENCIONES.md` (secciones 4.3 a 4.6) para que cada servicio no las vuelva a programar:
configuración, logs, errores, servidor, Validador de Intercepción (ADR-005, ADR-014), registro de
accesos, eventos con RabbitMQ (ADR-002), llamadas HTTP, base de datos y helpers de prueba.

El paquete exporta el código TypeScript directamente (sin compilar): los servicios lo corren con
Node 24 o `tsx`. Por eso los imports relativos llevan la extensión `.ts`.

```ts
import { crearServidor, crearValidador, conectarBroker /* ... */ } from '@trotamundos/comun';
import { firmarJwt, levantarPostgres /* ... */ } from '@trotamundos/comun/pruebas'; // solo pruebas
```

## Ejemplo completo: arranque de un servicio

```ts
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  cargarConfig, conectarBroker, crearLogger, crearPool, crearServidor, crearValidador,
  esquemaBase, iniciarPublicadorOutbox, migrar, MIGRACIONES_EVENTOS, registroPorEvento,
} from '@trotamundos/comun';

const config = cargarConfig(
  esquemaBase.extend({
    URL_BASE: z.url(),
    URL_BROKER: z.url(),
    URL_JWKS: z.url(),
  }),
);
const logger = crearLogger({ servicio: 'viajes', region: config.REGION, nivel: config.NIVEL_LOG });
const pool = crearPool({ url: config.URL_BASE });
await migrar(pool, [MIGRACIONES_EVENTOS, fileURLToPath(new URL('../migrations/', import.meta.url))], logger);
const broker = await conectarBroker({ url: config.URL_BROKER, servicio: 'viajes', region: config.REGION, logger });

const validador = crearValidador({
  servicio: 'viajes',
  region: config.REGION,
  logger,
  claves: { [config.REGION]: { url: config.URL_JWKS } },
  registrar: registroPorEvento(broker, logger),
  reglas: { 'POST /interna/archivado/ejecutar': { servicios: ['pruebas'] } },
});

const servidor = crearServidor({
  servicio: 'viajes',
  rutaSpec: fileURLToPath(new URL('../../../specs/openapi/viajes.yaml', import.meta.url)),
  region: config.REGION,
  puerto: config.PUERTO,
  logger,
  validador,
});
servidor.registrarChequeo('base', () => pool.query('SELECT 1'));
servidor.registrarChequeo('broker', () => broker.verificar());

const outbox = iniciarPublicadorOutbox({ pool, broker, logger });
servidor.alApagar(() => pool.end());
servidor.alApagar(() => broker.cerrar());
servidor.alApagar(() => outbox.detener());

servidor.app.get('/viajes', async (req, res) => { /* ... */ });
await servidor.iniciar();
```

## Módulos

### config

`cargarConfig(esquema)` lee `process.env` y lo valida con zod. Si falta una variable o tiene un
valor inválido, escribe todas las variables mal configuradas y el proceso termina con código 1.
`esquemaBase` trae las de todos los servicios: `REGION` (`region-1` o `region-2`), `PUERTO` y
`NIVEL_LOG` (por defecto `info`).

```ts
const config = cargarConfig(esquemaBase.extend({ SECRETO_ANALITICA: z.string().min(32) }));
config.PUERTO; // number
```

### logger

`crearLogger({ servicio, region, nivel })` devuelve un logger pino que escribe JSON. Cada línea
lleva `servicio`, `region` y, dentro de una solicitud, su `requestId`. El encabezado
`Authorization` y el campo `token` nunca se escriben.

```ts
logger.info({ viajeId }, 'Viaje creado');
// {"nivel":"info","time":"...","servicio":"viajes","region":"region-1","requestId":"...","viajeId":"...","mensaje":"Viaje creado"}
```

### errores

`ErrorHttp` es un error que se responde tal cual como `application/problem+json` (RFC 7807).
`errores.*` arma los de `specs/openapi/comun.yaml` con el mismo `type` y `title`. El servidor
agrega `manejadorErrores` al final. Un error no esperado responde 500 sin detalles; el detalle
queda solo en el log, con el `requestId`.

```ts
if (!viaje) throw errores.noEncontrado('El viaje no existe.');
throw new ErrorHttp({ status: 409, tipo: 'opcion-vencida', titulo: 'Opción vencida' });
```

### servidor

`crearServidor({ servicio, rutaSpec, region, puerto, logger, validador })` arma Express con, en
este orden:

1. `X-Request-Id`: usa el que llega si es un UUID; si no, crea uno.
2. Log de cada solicitud.
3. `GET /health` con los chequeos registrados. Responde 200 `{"estado":"ok"}`; si un chequeo
   falla o tarda más de 1 s, responde 503.
4. Las rutas de `antesDelContrato(app)`, si se pasa. Solo lo usa el gateway, que enruta
   `/api/<servicio>/*` con el contrato de cada servicio.
5. Validador de Intercepción.
6. Validación de solicitudes y respuestas contra el contrato (express-openapi-validator). Una
   respuesta que no cumple el contrato se convierte en 500.

El contrato se carga con `cargarSpec`: resuelve los `$ref` a `comun.yaml` y deja el servidor en
`/`, porque el servicio atiende sus rutas sin el prefijo `/api/<servicio>` que pone el gateway.

`iniciar()` agrega el manejo de errores, descarga las claves del JWKS y escucha. Con `SIGTERM`
(o `detener()`) deja de aceptar solicitudes, espera las que están en curso y corre las tareas de
`alApagar` en orden inverso.

### validador (Validador de Intercepción)

`crearValidador({ servicio, region, logger, claves, registrar, reglas })` sigue ADR-005 y
ADR-014:

- **Claves:** descarga el JWKS de Autenticación una vez al arrancar y lo renueva cada 10 min.
  Cada JWT se verifica sin usar la red: RS256, `exp`, `sub`, `roles` y `region`. Una prueba mide
  que tarda menos de 5 ms.
- **Seguridad del contrato:** cada operación usa la de su spec. Con `security: []` la ruta es
  pública. Con `bearerJWT` necesita un usuario con los `rolesPorDefecto` (`usuario`), o los
  `roles` que diga su regla; el rol `servicio` responde 403. Con `tokenServicio` solo entra un
  token de servicio cuyo `sub` esté en `servicios` de la regla.
- **Región:** el claim `region` tiene que ser la del servicio. Si no, responde 403 `otra-region`,
  salvo que la regla acepte otras `regiones`. Es el caso de `GET /interna/cuentas/existe`, que se
  verifica con las claves de la otra región.
- **Rechazos:** responde 401 (`sin-token`, `token-invalido`) o 403 (`otra-region`,
  `sin-permiso`) y llama a `registrar` sin esperar, con la ruta completa (`req.baseUrl` +
  `req.path`).
- **Contrato de otro servicio:** `middleware(spec, { reglas, rolesPorDefecto })` intercepta con
  las reglas y los roles por defecto de ese contrato en lugar de los del validador. Lo usa el
  gateway, con un solo validador para las rutas de todos los servicios.

```ts
const validador = crearValidador({
  servicio: 'autenticacion',
  region: 'region-1',
  logger,
  claves: { 'region-1': { claves: jwksPropio }, 'region-2': { url: 'http://.../jwks.json' } },
  registrar: registroPorEvento(broker, logger),
  reglas: {
    'GET /interna/cuentas/existe': { servicios: ['autenticacion'], regiones: ['region-1', 'region-2'] },
  },
});
```

En las rutas, `autenticacion(req)` dice quién llama: `sub`, `region`, `roles`, `idioma` y
`esServicio`. Los permisos que dependen de los datos se declaran por ruta:

```ts
// Solo el dueño: el sub del token tiene que ser el usuarioId del recurso.
app.delete('/viajes/:viajeId', validador.soloDueno((req) => buscarDueno(req.params.viajeId)), borrar);

// Dueño o persona designada. El dueño lo resuelve el servicio con sus datos; si no lo es,
// consulta GET /interna/permisos/itinerarios/{viajeId} de Usuarios con el JWT del usuario y un
// tiempo máximo de 2 s. Si Usuarios no contesta, responde 503 y no muestra el itinerario.
app.get(
  '/viajes/:viajeId',
  validador.duenoODesignado({
    obtenerDueno: (req) => buscarDueno(req.params.viajeId), // undefined → 404
    viajeId: (req) => req.params.viajeId,
    urlUsuarios: config.URL_USUARIOS,
  }),
  verViaje,
);
```

### registroAccesos

Registra cada rechazo sin hacer esperar la respuesta (QA-9). Si el registro falla, queda en el log
y la solicitud sigue.

- `registroPorEvento(broker, logger)`: para los microservicios. Publica el evento
  `AccesoRechazado` (CONVENCIONES 4.5).
- `registroEnBase(pool, logger)`: para el gateway. Guarda directo en `accesos_rechazados` de la
  base `registro_accesos` (migración `MIGRACIONES_REGISTRO_ACCESOS`). Además de los 401 y 403,
  guarda los 404 de las rutas `/interna/...` pedidas desde afuera (motivo `ruta-interna`).
- `guardarAccesoRechazado(cliente, rechazo)`: para el consumidor de `AccesoRechazado` del
  gateway.

```ts
await broker.consumir<AccesoRechazado>({
  tipo: 'AccesoRechazado',
  pool: poolRegistro,
  manejar: (evento, cliente) => guardarAccesoRechazado(cliente, evento.datos, new Date(evento.ocurridoEn)),
});
```

### broker

`conectarBroker({ url, servicio, region, logger })` conecta con RabbitMQ (amqplib) al exchange
topic `trotamundos.eventos`. Si se cae el broker, se reconecta solo con espera creciente y, al
volver, recrea el exchange, las colas y los consumidores.

- **Publicar:** `publicar(sobre)` o `publicarEvento(tipo, datos)`. Valida con ajv contra
  `specs/schemas` antes de enviar y espera la confirmación del broker.
- **Consumir:** `consumir({ tipo, pool, manejar })` usa una cola quorum propia
  (`<servicio>.<tipo>`), con `prefetch` configurable (10 por defecto) y validación ajv.
  - **Idempotencia:** guarda el `eventId` en `eventos_procesados` en la misma transacción que
    `manejar`. Un evento repetido se ignora.
  - **Reintentos:** si `manejar` falla, reintenta 3 veces (500, 1000 y 2000 ms) y después lo
    manda a `<cola>.dlq`. Un evento inválido va directo a la DLQ, sin reintentos.

```ts
await broker.consumir<DatosReservaDetectada>({
  tipo: 'ReservaDetectada',
  pool,
  manejar: async (evento, cliente) => {
    await cliente.query('INSERT INTO reservas ...', [evento.datos.numeroReserva]);
  },
});
```

### outbox

Así un cambio guardado nunca se queda sin su evento (CONVENCIONES 4.5).

- `guardarEnOutbox(cliente, sobre)`: guarda el evento en `eventos_salientes` dentro de la
  transacción del servicio.
- `iniciarPublicadorOutbox({ pool, broker, logger })`: cada 500 ms envía los pendientes (hasta 100
  por vuelta, todos juntos, en el orden de la tabla) y marca como enviados los que el broker
  confirmó. Si la vuelta vino llena, sigue enseguida. Con varias instancias, `FOR UPDATE SKIP
  LOCKED` reparte el trabajo.

```ts
await enTransaccion(pool, async (cliente) => {
  await cliente.query('UPDATE reservas SET estado = $1 WHERE id = $2', [estado, id]);
  await guardarEnOutbox(cliente, crearEvento('ViajeActualizado', datos, config.REGION));
});
```

### http

`crearClienteHttp({ urlBase })` crea un cliente para llamar a otro servicio:

- Corta a los 2 s por defecto y lanza `ErrorTiempoAgotado`.
- Propaga el `X-Request-Id` y el JWT de la solicitud en curso (ADR-019).
- Una respuesta 4xx o 5xx lanza `ErrorRespuestaHttp`, con `status` y `cuerpo`.

```ts
const usuarios = crearClienteHttp({ urlBase: config.URL_USUARIOS });
const { datos } = await usuarios.get<Perfil>(`/usuarios/${usuarioId}/perfil`);
// Ruta interna sin usuario: el token de servicio se pasa explícito.
await viajes.get('/interna/viajes/usuarios-con-viaje-proximo', { token: tokenServicio });
```

### db

- `crearPool({ url })`: pool de pg.
- `enTransaccion(pool, fn)`: COMMIT si `fn` termina bien y ROLLBACK si lanza.
- `migrar(pool, carpetas)`: aplica al arrancar los archivos SQL numerados (`001_crear_viajes.sql`,
  ...) que falten. Cada uno corre una sola vez y en su propia transacción. Si arrancan dos
  instancias juntas, la segunda espera. Las migraciones del kit empiezan con `000_comun_`:
  - `MIGRACIONES_EVENTOS`: `eventos_salientes` y `eventos_procesados`.
  - `MIGRACIONES_REGISTRO_ACCESOS`: `accesos_rechazados`.

### pruebas (`@trotamundos/comun/pruebas`)

- `generarClaves()`, `firmarJwt(claves, { sub, region, roles, venceEnSegundos })` y
  `firmarTokenServicio(claves, servicio)`: JWT de prueba como los de Autenticación.
- `levantarPostgres()` y `levantarRabbit()`: PostgreSQL 17 y RabbitMQ 4 con testcontainers.
  `rabbit.cortarConexiones()` simula una caída del broker.
- `dockerDisponible()`: para saltear las pruebas con contenedores en una máquina sin Docker. En
  CI siempre corren.
- `loggerDePrueba()`: logger que guarda las líneas para revisarlas.

```ts
const claves = await generarClaves();
const token = await firmarJwt(claves, { roles: ['analista'] });
describe.skipIf(!(await dockerDisponible()))('con base real', () => { /* levantarPostgres() ... */ });
```

## Pruebas del kit

`npm test` corre las pruebas unitarias (`packages/comun/test/*.test.ts`) y las de
`integracion.test.ts`, que levantan PostgreSQL y RabbitMQ con Docker. Entre otras cosas cubren:

- JWT vencido, firma inválida y región equivocada.
- Validación de un JWT en menos de 5 ms.
- Evento duplicado ignorado y evento inválido a la DLQ.
- Reintentos y después la DLQ.
- Reconexión con el broker.
- Publicación desde el outbox después de reiniciar.
