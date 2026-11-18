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
| `npm run infra:levantar` | Levanta lo global y las regiones r1 y r2 con Docker Compose y espera que todo esté sano (`-- --solo r1`, `-- --ha`, `-- --scale gateway=3`). nginx: r1 en 8081, r2 en 8082 |
| `npm run infra:bajar` / `infra:reset` | Baja los contenedores; `reset` borra también los volúmenes (`-- --solo r1`) |
| `npm run infra:logs` | Logs de las regiones (`-- --solo r1 gateway viajes`) |

## Infraestructura

- `infra/region.compose.yaml` (una región, se levanta como proyectos r1 y r2) e
  `infra/global.compose.yaml` (red global y base de analítica). Las bases de cada región están solo
  en la red de su región (CONST-6); en la red global están nginx, analitica, correo e integraciones.
- `GET /salud/<servicio>` en el nginx de cada región muestra el `/health` de cada servicio.
- Puerta entre regiones: el nginx de cada región escucha también en 8090 (no publicado). Autenticación
  llega por ahí a `/interna/cuentas/existe` y al JWKS de la otra región (`http://nginx:8090/otra-region/autenticacion`).
- `npm run infra:levantar` corre las semillas de Autenticación: analista de prueba
  `analista@trotamundos.example` con la contraseña `CONTRASENA_ANALISTA` del `.env`.
- El gateway (`services/gateway/src/enrutamiento.ts`) enruta `/api/<servicio>/*` solo a las
  operaciones del contrato de cada servicio, con el Validador de Intercepción antes; las rutas
  `/interna/...` responden 404 y quedan en el registro de accesos.
- Las pruebas con todo levantado están en `tests/e2e/` (`npm run e2e`).

## Configuración compartida

- `tsconfig.base.json`: opciones estrictas (`strict`, `noUncheckedIndexedAccess`). Cada paquete o servicio
  que tenga su propio `tsconfig.json` lo extiende. El código se corre sin compilar (Node 24 o `tsx`): los
  imports relativos llevan la extensión `.ts` y solo se usa sintaxis que Node puede borrar
  (`erasableSyntaxOnly`: nada de `enum` ni propiedades en el constructor).
- `packages/comun`: kit común de los servicios (servidor, Validador de Intercepción, broker, outbox, db,
  http, logger, config). Ejemplos de uso en `packages/comun/README.md`.
- `vitest.config.ts`: busca pruebas en `{src,test}/**/*.test.ts` de cada paquete, servicio y mock.
- Requiere Node 24 (`.nvmrc`).
