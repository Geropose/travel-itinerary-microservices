# Demo de extremo a extremo — Trotamundos (P3.1)

Esta guía recorre el sistema completo levantado con Docker Compose (enrutador global, dos regiones `r1` y `r2` con bases aisladas, Redis, RabbitMQ, los 8 microservicios, el monitor de salud y los 7 mocks externos) usando únicamente las APIs públicas del enrutador (`http://localhost:8000`) y las rutas `/admin` de los mocks.

---

## 0. Levantar todo y cargar semillas

```bash
# 1) Genera .env (si no existe), construye imágenes, levanta global + r1 + r2
#    y verifica que los 28 endpoints de salud respondan 200 OK.
npm run infra:levantar

# 2) Crea 10 usuarios en region-1 y 10 en region-2 (verifica al analista),
#    conecta sus correos en mock-gmail / mock-outlook, carga whitelists,
#    designados y asegura reservas coherentes con los proveedores.
npm run semillas
```

**Requisitos para seguir los pasos de abajo.** Todos los comandos usan `curl`, `jq` y variables de shell (`export`), así que hay que correrlos en Bash (Git Bash, WSL, macOS o Linux), no en PowerShell. Git Bash trae `curl` pero no `jq`. En Windows, instalalo una vez con `winget install jqlang.jq` y abrí una terminal nueva. Comprobá que funciona con `jq --version`.

Si preferís no instalar nada, la misma recorrida está automatizada en `npm run e2e` (casos UC-1 a UC-8).

Definí las URLs base:

```bash
export API="http://localhost:8000"
export GMAIL="http://localhost:4001"
export AEROLINEA="http://localhost:4003"
```

---

## 1. Registro e inicio de sesión de un usuario nuevo (region-1)

```bash
# Registro del usuario demo en region-1
curl -sS -X POST "$API/api/autenticacion/registro" \
  -H "Content-Type: application/json" \
  -H "X-Region: region-1" \
  -d '{
    "nombre": "Demo Viajero",
    "email": "demo.viajero@correo.example",
    "contrasena": "Viajar-Demo-2026!",
    "region": "region-1",
    "idioma": "es"
  }' | jq .

# Login y captura del JWT (RS256, 15 min)
export JWT=$(curl -sS -X POST "$API/api/autenticacion/login" \
  -H "Content-Type: application/json" \
  -H "X-Region: region-1" \
  -d '{
    "email": "demo.viajero@correo.example",
    "contrasena": "Viajar-Demo-2026!"
  }' | jq -r '.jwt')

# Configurar agencia preferida en el perfil
curl -sS -X PATCH "$API/api/usuarios/perfil" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"agenciaPreferida": "viajes-del-plata"}' | jq .
```

---

## 2. Conectar Gmail por OAuth (solo lectura, ADR-015)

Primero creamos el buzón `demo.viajero@gmail.example` en `mock-gmail` inyectando un correo inicial de bienvenida (no-viaje), iniciamos el flujo OAuth en `services/correo` y aprobamos el permiso en `mock-gmail`:

```bash
# Crear buzón en mock-gmail
curl -sS -X POST "$GMAIL/admin/buzones/demo.viajero@gmail.example/correos" \
  -H "Content-Type: application/json" \
  -d '{
    "de": "noticias@ejemplo.example",
    "asunto": "Bienvenido a tu correo",
    "texto": "Correo general sin reservas."
  }' | jq .

# 1) Pedir URL de autorización al Servicio de Correo
export URL_AUTH=$(curl -sS -X POST "$API/api/correo/cuentas-correo/gmail/conectar" \
  -H "Authorization: Bearer $JWT" | jq -r '.urlAutorizacion')
echo "URL_AUTH=$URL_AUTH"

# 2) Extraer parámetros OAuth y aprobar permiso en mock-gmail (simula clic en "Permitir")
export QUERY="${URL_AUTH#*\?}"
export URL_CALLBACK=$(curl -sS -D - -o /dev/null -X POST "$GMAIL/o/oauth2/v2/auth/decision" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "${QUERY}&email=demo.viajero@gmail.example&decision=permitir" \
  | awk -F': ' 'tolower($1)=="location"{gsub("\r","",$2); print $2}')

# 3) Completar el callback en services/correo (canjea código, cifra tokens AES-256-GCM y activa push)
curl -sS -i "$URL_CALLBACK" | head -n 5

# Verificar cuenta conectada
curl -sS "$API/api/correo/cuentas-correo" \
  -H "Authorization: Bearer $JWT" | jq .
```

---

## 3. Llega un correo de reserva → aparece automáticamente en el panel (UC-1)

Creamos una orden en `mock-aerolinea` con código `DM9001` e inyectamos su correo de confirmación con marcado JSON-LD en `demo.viajero@gmail.example`. `mock-gmail` dispara el aviso Pub/Sub push hacia `services/correo`, que publica `ReservaDetectada` y `services/viajes` arma el viaje:

```bash
# 1) Crear orden coherente en mock-aerolinea
curl -sS -X POST "$AEROLINEA/admin/ordenes" \
  -H "Content-Type: application/json" \
  -d '{
    "booking_reference": "DM9001",
    "status": "confirmed",
    "passenger": { "given_name": "Demo", "family_name": "Viajero" },
    "flight_number": "1234",
    "origin_iata": "EZE",
    "origin_city": "Buenos Aires",
    "destination_iata": "SCL",
    "destination_city": "Santiago",
    "departing_at": "2026-12-20T08:30:00-03:00",
    "arriving_at": "2026-12-20T10:40:00-03:00",
    "seat": "12A"
  }' | jq .

# 2) Inyectar el correo de confirmación en mock-gmail (dispara Pub/Sub push)
curl -sS -X POST "$GMAIL/admin/buzones/demo.viajero@gmail.example/correos" \
  -H "Content-Type: application/json" \
  -d '{
    "de": "Aerolínea Andina <reservas@aerolinea-andina.example>",
    "asunto": "Confirmación de vuelo AN 1234 — Reserva DM9001",
    "texto": "Tu vuelo AN 1234 EZE -> SCL (DM9001) está confirmado.",
    "html": "<!doctype html><html><head><script type=\"application/ld+json\">{\"@context\":\"https://schema.org\",\"@type\":\"FlightReservation\",\"reservationNumber\":\"DM9001\",\"reservationStatus\":\"https://schema.org/ReservationConfirmed\",\"underName\":{\"@type\":\"Person\",\"name\":\"Demo Viajero\"},\"reservationFor\":{\"@type\":\"Flight\",\"flightNumber\":\"AN 1234\",\"airline\":{\"@type\":\"Airline\",\"name\":\"Aerolínea Andina\",\"iataCode\":\"AN\"},\"departureAirport\":{\"@type\":\"Airport\",\"name\":\"Buenos Aires\",\"iataCode\":\"EZE\"},\"arrivalAirport\":{\"@type\":\"Airport\",\"name\":\"Santiago\",\"iataCode\":\"SCL\"},\"departureTime\":\"2026-12-20T08:30:00-03:00\",\"arrivalTime\":\"2026-12-20T10:40:00-03:00\"},\"airplaneSeat\":\"12A\"}</script></head><body>Confirmado</body></html>"
  }' | jq .

# 3) Esperar unos segundos al procesamiento asíncrono y consultar el panel
sleep 5
curl -sS "$API/api/viajes/panel" \
  -H "Authorization: Bearer $JWT" | jq .

# Guardar el viajeId para el paso 5
export VIAJE_ID=$(curl -sS "$API/api/viajes/panel" \
  -H "Authorization: Bearer $JWT" | jq -r '.viajes[0].viajeId')
echo "VIAJE_ID=$VIAJE_ID"
```

---

## 4. La aerolínea cambia el vuelo → el panel se actualiza (UC-3, QA-1)

`mock-aerolinea` desplaza el vuelo 90 minutos y envía el webhook `order.airline_initiated_change_detected` firmado con HMAC-SHA256 hacia ambas regiones vía `enrutador`. `services/integraciones` valida la firma y publica `ReservaActualizada`; `services/viajes` actualiza la reserva e invalida la caché Redis:

```bash
curl -sS -X POST "$AEROLINEA/admin/ordenes/DM9001/cambiar" \
  -H "Content-Type: application/json" \
  -d '{"desplazarMinutos": 90}' | jq '{orden: .orden.booking_reference, webhooksDisparados}'

sleep 3
curl -sS "$API/api/viajes/panel" \
  -H "Authorization: Bearer $JWT" | jq '.viajes[0].reservas[] | {numeroReserva, estado, inicio, origenCambio}'
```

Esperado: `estado: "modificada"`, `origenCambio: "proveedor"` y el nuevo horario desplazado +90 min.

---

## 5. Compartir el itinerario con un designado (ADR-005, QA-9)

Designamos a `bruno.diaz@correo.example` (creado por `npm run semillas` en `region-1`) para ver el viaje `VIAJE_ID`, y verificamos que Bruno accede en modo lectura:

```bash
# Designar a Bruno
curl -sS -X POST "$API/api/usuarios/itinerarios/$VIAJE_ID/designados" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"email": "bruno.diaz@correo.example"}' | jq .

# Iniciar sesión como Bruno y consultar el itinerario compartido
export JWT_BRUNO=$(curl -sS -X POST "$API/api/autenticacion/login" \
  -H "Content-Type: application/json" \
  -H "X-Region: region-1" \
  -d '{"email": "bruno.diaz@correo.example", "contrasena": "Viajar-2026!"}' | jq -r '.jwt')

curl -sS "$API/api/viajes/viajes/$VIAJE_ID" \
  -H "Authorization: Bearer $JWT_BRUNO" | jq '{viajeId, destino, reservas: [.reservas[].numeroReserva]}'
```

---

## 6. El analista consulta tendencias (UC-7, ADR-016, Map-Reduce)

Leemos `CONTRASENA_ANALISTA` desde `.env`, iniciamos sesión con rol `analista`, lanzamos una consulta Map-Reduce de tendencias del año `2026` y consultamos su resultado anonimizado (sin ningún dato personal):

```bash
export CLAVE_ANALISTA=$(grep '^CONTRASENA_ANALISTA=' .env | cut -d= -f2-)

export JWT_ANALISTA=$(curl -sS -X POST "$API/api/autenticacion/login" \
  -H "Content-Type: application/json" \
  -H "X-Region: region-1" \
  -d "{\"email\": \"analista@trotamundos.example\", \"contrasena\": \"$CLAVE_ANALISTA\"}" | jq -r '.jwt')

# Consulta síncrona rápida de tendencias 2026
curl -sS "$API/api/analitica/consultas/tendencias?anio=2026" \
  -H "Authorization: Bearer $JWT_ANALISTA" | jq .

# Consulta pesada asíncrona con Map-Reduce (worker_threads)
export CONSULTA_ID=$(curl -sS -X POST "$API/api/analitica/consultas/tendencias/ejecutar" \
  -H "Authorization: Bearer $JWT_ANALISTA" \
  -H "Content-Type: application/json" \
  -d '{"anio": 2026, "procesadores": 4}' | jq -r '.consultaId')

sleep 2
curl -sS "$API/api/analitica/consultas/ejecuciones/$CONSULTA_ID" \
  -H "Authorization: Bearer $JWT_ANALISTA" | jq '{estado, procesadores, duracionMs, totalDiciembre: .resultado.periodos[11]}'
```

---

## 7. El usuario pregunta y reprograma por el chat del asistente (UC-8, ADR-018, ADR-019)

```bash
# 1) Abrir conversación
export CONV_ID=$(curl -sS -X POST "$API/api/asistente/conversaciones" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"idioma": "es"}' | jq -r '.conversacionId')

# 2) Consultar el estado del vuelo DM9001
curl -sS -X POST "$API/api/asistente/conversaciones/$CONV_ID/mensajes" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"texto": "¿Cuál es el estado de mi vuelo DM9001?"}' | jq '{estado, texto: .respuesta.texto, reservas: .respuesta.reservas}'

# 3) Pedir opciones de reprogramación
export OPCION_ID=$(curl -sS -X POST "$API/api/asistente/conversaciones/$CONV_ID/mensajes" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"texto": "Quiero reprogramar mi vuelo DM9001"}' | jq -r '.respuesta.opciones[0].opcionId')
echo "OPCION_ID=$OPCION_ID"

# 4) Confirmar la primera opción ofrecida
curl -sS -X POST "$API/api/asistente/conversaciones/$CONV_ID/confirmaciones" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d "{\"opcionId\": \"$OPCION_ID\"}" | jq '{estado, resultado: .respuesta.resultado, texto: .respuesta.texto}'
```

---

## 8. Reporte de encaje entre servicios (P3.1)

Durante la integración de los 8 servicios, los 7 mocks y las dos regiones se relevaron los siguientes puntos de acople:

| Punto detectado | Dueño responsable | Estado |
| :--- | :--- | :--- |
| `infra/region.compose.yaml`: al servicio `correo` le faltaban `SECRETO_CLIENTE_GMAIL`, `SECRETO_AVISOS_GMAIL`, `SECRETO_CLIENTE_OUTLOOK`, `SECRETO_SERVICIO_CORREO` y `URL_WEB` (usaba defaults `cambiar-...` incompatibles con los secretos generados en `.env`). | **A** (infra) / **B** (`correo`) | Resuelto en `infra/region.compose.yaml` en P3.1. |
| `infra/region.compose.yaml` y `infra/global.compose.yaml`: `viajes` no esperaba a `postgres-viajes-replica` (`service_healthy`), `monitor` arrancaba antes de que los servicios terminaran de inicializarse, y el `fsync` inicial de PostgreSQL 17 con 7 bases en WSL2/Docker Desktop superaba el `start_period` de 30 s. | **A** (infra) / **C** (`viajes`) | Resuelto en P3.1 (`depends_on`, `POSTGRES_INITDB_ARGS=--no-sync`, `recovery_init_sync_method=syncfs` y margen de healthcheck). |
| `services/viajes/src/consumidores.ts` (líneas 35–38 y 47–50): `alCambiarUsuario` (invalidación `DEL panel:{usuarioId}` en Redis) se invoca **antes** del `COMMIT` de la transacción de `broker.consumir`. Si llega un `GET /panel` en esa ventana (o durante el lag hacia la read replica), puede cachear el estado anterior (`viajes: []`) durante `TTL_CACHE_PANEL_S` (600 s). | **C** (`viajes`) | Reportado (sin modificar el servicio de C en P3.1): mover la invalidación después del `COMMIT` de la transacción. |
| `services/integraciones/src/usuarios.ts` (línea 37): en el bloque `catch` de `crearClienteHttp` compara `error instanceof ErrorHttp` en lugar de `ErrorRespuestaHttp`, convirtiendo eventuales respuestas `401`/`403`/`404` del Servicio de Usuarios en `503`. | **D** (`integraciones`) | Reportado (sin modificar el servicio de D en P3.1). |
| `services/gateway/src/config.ts`: el timeout por defecto `TIEMPO_MAXIMO_MS=2000` puede cortarse bajo picos locales con los 41 contenedores en una sola PC durante operaciones con `argon2id` o llamadas encadenadas (`usuarios → viajes`). | **A** (`gateway`) | Documentado: configurable por entorno (`TIEMPO_MAXIMO_MS`); `scripts/semillas.ts` contempla reintento ante `503` transitorio. |
