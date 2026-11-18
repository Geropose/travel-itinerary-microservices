# Reglas para el agente — Trotamundos

Prototipo funcional del sistema Trotamundos (TPE de Diseño de Sistemas de Software). La arquitectura está
documentada en la wiki, clonada al lado de este repositorio en `../Trabajo-especial-trotamundos.wiki/`
(iteraciones 1 a 7, vistas y ADR-001 a ADR-019). El prototipo tiene que ser trazable a la wiki: no inventar
componentes que no estén ahí.

## Antes de programar

- Leer `docs/CONVENCIONES.md` y las páginas de la wiki que nombre cada tarea.
- Actualizar la wiki con `git pull` dentro de `../Trabajo-especial-trotamundos.wiki/` antes de leerla.

## Reglas

- **Spec-driven:** primero el contrato en `specs/`, después el código. Nunca cambiar un contrato sin decirlo
  explícitamente.
- **Cada servicio solo toca su carpeta** (`services/<servicio>`, `mocks/<mock>`). Lo compartido va en
  `packages/comun`.
- **Todo cambio lleva pruebas.** No dar una tarea por terminada si `npm run lint`, `npm run typecheck` o
  `npm test` fallan.
- **Nada de secretos en el repositorio:** usar `.env.example` con valores de ejemplo.
- **Idioma:** comentarios y textos de la interfaz en español; nombres de dominio en español como en la wiki
  (viaje, reserva, examinador, anonimizador).
- Los mensajes de commit y las descripciones de pull request no llevan líneas Co-Authored-By ni menciones a
  Claude Code.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run lint` | ESLint y Prettier (`--check`) |
| `npm run format` | Formatea con Prettier |
| `npm run typecheck` | TypeScript estricto sobre todo el repositorio |
| `npm test` | Pruebas unitarias y de contrato (Vitest) |
| `npm run test:contratos` | Valida los contratos REST de `specs/openapi/` con Redocly y corre las pruebas de contrato (`tests/contratos/` y archivos `*.contrato.test.ts`) |
| `npm run e2e` | Pruebas de extremo a extremo de `tests/e2e`, contra el sistema levantado |
| `npm run nuevo-servicio -- <nombre> <puerto>` | Genera `services/<nombre>` desde `infra/plantilla-servicio` (necesita `specs/openapi/<nombre>.yaml`; con `--sin-dependencias`, sin base, broker ni JWT). Después, `npm install` |
| `npm run mock -- <servicio>` | Mock del servicio con Prism a partir de su contrato, en su mismo puerto |
| `npm run infra:secretos` | Genera `.env` desde `.env.example` con secretos de desarrollo (solo completa las variables que falten; `-- --regenerar` genera todo) |
| `npm run infra:levantar` | Levanta lo global y las regiones r1 y r2 con Docker Compose y espera que todo esté sano (`-- --solo r1`, `-- --ha`, `-- --scale gateway=3`). Enrutador global en 8000; nginx: r1 en 8081, r2 en 8082 |
| `npm run infra:bajar` / `infra:reset` | Baja los contenedores; `reset` borra también los volúmenes (`-- --solo r1`) |
| `npm run infra:logs` | Logs de las regiones (`-- --solo r1 gateway viajes`) |
| `npm run infra:escalador` | Escala cada servicio con `docker compose --scale` según `docker stats`: +1 instancia con más del 70 % de procesador, −1 con menos del 30 % durante 2 min; mínimo 3 con el perfil ha (`-- --solo r1`, `-- --una-vez`) |
| `npm run caos` | Pruebas de caos de `tests/caos` contra el sistema levantado (por ejemplo, matar una instancia del gateway) |
| `npm run web` | Aplicación web (PWA) en http://localhost:5173, contra el enrutador global (`VITE_URL_API`, por defecto http://localhost:8000) |
| `npm run web:api` | Regenera los tipos del cliente de API (`web/src/api/generado/`) desde `specs/openapi`; hay que correrlo después de cambiar un contrato |
| `npm run e2e:web` | Pruebas de la web con Playwright (compila la PWA y simula la API; computadora y teléfono). La primera vez: `npx playwright install chromium` |

## Infraestructura

- `infra/region.compose.yaml` (una región, se levanta como proyectos r1 y r2) e
  `infra/global.compose.yaml` (red global y base de analítica). Las bases de cada región están solo
  en la red de su región (CONST-6); en la red global están nginx, analitica, correo e integraciones.
- Enrutador global (`services/enrutador`, en `infra/global.compose.yaml`, puerto 8000): el único punto
  de entrada de la web. Elige la región por el claim `region` del JWT (sin verificar la firma), el
  prefijo `/region-N`, el header `X-Region` o `REGION_POR_DEFECTO`, en ese orden, y la manda al nginx
  de esa región por la red global. En login y registro sigue el 307 de Autenticación hacia la otra
  región. Nunca escribe cuerpos, headers, query ni emails en el log.
- `GET /salud/<servicio>` en el nginx de cada región muestra el `/health` de cada servicio.
- Puerta entre regiones: el nginx de cada región escucha también en 8090 (no publicado). Autenticación
  llega por ahí a `/interna/cuentas/existe` y al JWKS de la otra región (`http://nginx:8090/otra-region/autenticacion`).
- `npm run infra:levantar` corre las semillas de Autenticación: analista de prueba
  `analista@trotamundos.example` con la contraseña `CONTRASENA_ANALISTA` del `.env`.
- El gateway (`services/gateway/src/enrutamiento.ts`) enruta `/api/<servicio>/*` solo a las
  operaciones del contrato de cada servicio, con el Validador de Intercepción antes; las rutas
  `/interna/...` responden 404 y quedan en el registro de accesos.
- Monitor de salud (`services/monitor`): uno por región, con el socket de Docker. Cada 5 s hace ping a
  `/health` de cada contenedor con la etiqueta `trotamundos.servicio`; con 3 fallas seguidas lo
  reinicia. `GET /estado` (desde adentro de la región) muestra lo que ve. nginx deja de mandarle al
  gateway caído con `max_fails=3 fail_timeout=15s`.
- Las pruebas con todo levantado están en `tests/e2e/` (`npm run e2e`) y `tests/caos/` (`npm run caos`).

## Aplicación web (`web/`)

- React + Vite + TypeScript, instalable como PWA (`vite-plugin-pwa`). El mismo código sirve de
  aplicación móvil (CONST-1): diseño para teléfono primero, menú abajo.
- Cliente de API: `web/src/api/cliente.ts` (`openapi-fetch` con los tipos generados). Agrega el JWT,
  lo renueva con `/renovar` cuando vence y manda la región recordada en `X-Region`.
- Textos y formatos de cada idioma en `web/src/idiomas/{es,en}.json`; fechas y monedas con `Intl`
  (`web/src/idiomas/formatos.ts`).
- Cache local: `guardarPanel` y `leerPanel` (`web/src/cache/panel.ts`, IndexedDB). El panel guardado
  se muestra sin esperar a la red (QA-3).
- Las pantallas de cada dueño están como "en construcción" en `web/src/App.tsx`.

## Configuración compartida

- `tsconfig.base.json`: opciones estrictas (`strict`, `noUncheckedIndexedAccess`). Cada paquete o servicio
  que tenga su propio `tsconfig.json` lo extiende. El código se corre sin compilar (Node 24 o `tsx`): los
  imports relativos llevan la extensión `.ts` y solo se usa sintaxis que Node puede borrar
  (`erasableSyntaxOnly`: nada de `enum` ni propiedades en el constructor).
- `packages/comun`: kit común de los servicios (servidor, Validador de Intercepción, broker, outbox, db,
  http, logger, config). Ejemplos de uso en `packages/comun/README.md`.
- `vitest.config.ts`: busca pruebas en `{src,test}/**/*.test.ts` de cada paquete, servicio y mock.
- Requiere Node 24 (`.nvmrc`).
