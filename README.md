# Trotamundos — prototipo

Prototipo funcional del sistema **Trotamundos**, del TPE de Diseño de Sistemas de Software. Sigue la
arquitectura documentada en la [wiki](https://github.com/facubelmonte/Trabajo-especial-trotamundos/wiki)
(ADD en 7 iteraciones, ADR-001 a ADR-019): microservicios que se comunican por APIs REST y eventos, con los
sistemas externos (Gmail, Outlook, proveedores, red social) simulados por mocks.

## Requisitos

- Node.js 24 (ver `.nvmrc`)
- Git
- Docker Desktop (para levantar el sistema, en fases posteriores)

## Instalación

```bash
git clone https://github.com/facubelmonte/Trabajo-especial-trotamundos.git
```

```bash
cd Trabajo-especial-trotamundos
```

```bash
npm install
```

## Comandos

```bash
npm run lint
```

```bash
npm run typecheck
```

```bash
npm test
```

## Estructura

```text
specs/       contratos: OpenAPI (REST), AsyncAPI (eventos), JSON Schema y APIs externas imitadas
packages/    código compartido (packages/comun)
services/    un microservicio por carpeta
mocks/       sistemas externos simulados
web/         aplicación web y móvil (PWA)
infra/       Docker Compose, nginx, RabbitMQ y scripts
tests/       pruebas de todo el sistema (e2e, carga, caos)
docs/        convenciones y mediciones
```

Las reglas de trabajo están en [docs/CONVENCIONES.md](docs/CONVENCIONES.md).
