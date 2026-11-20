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

## 2. Mediciones de carga y latencia de extremo a extremo (`QA-1` a `QA-12`, P4.1)

*(Se completará en P4.1 con `tests/carga/` y las ejecuciones completas contra el sistema levantado.)*
