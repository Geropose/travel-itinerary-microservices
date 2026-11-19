# Cómo agregar un nuevo proveedor de viajes (trenes, autobuses y otros)

Esta guía documenta el procedimiento exacto para incorporar un nuevo proveedor de transporte
(por ejemplo, **trenes** o **autobuses**) al Servicio de Integraciones, cumpliendo **QA-10**
(modificabilidad en menos de 2 días-persona sin tocar otros servicios) y **ADR-003** (Patrón
Adapter en `services/integraciones`).

> **Alcance de los cambios:** el patrón Adapter aísla por completo el formato y el protocolo del
> proveedor externo dentro de `services/integraciones`. **No se modifica** `services/viajes`,
> `services/correo`, `services/usuarios`, `services/gateway`, `services/analitica`,
> `services/asistente`, `packages/comun` ni los contratos públicos de eventos (`ReservaActualizada`).
>
> *(Nota sobre el prototipo: si se agregan reservas de trenes o autobuses con un `tipoReserva`
> distinto de `vuelo | hotel | auto`, revisar `specs/schemas/ReservaDetectada.json` y
> `specs/openapi/comun.yaml` solo si el dominio exige un nuevo valor de `TipoReserva`; para
> actualizaciones por proveedor, `ReservaActualizada.json` ya es completamente agnóstico al medio
> de transporte).*

---

## Resumen de pasos

1. Implementar un nuevo adaptador que cumpla `AdaptadorProveedorViaje`.
2. Registrar su fábrica por `tipo` en `services/integraciones/src/adaptadores/registro.ts`.
3. Agregar una entrada en `services/integraciones/config/proveedores.yaml`.
4. Declarar sus variables de entorno (URL y credenciales) sin guardar secretos en el YAML.
5. Agregar las pruebas unitarias e de integración del adaptador.
6. Documentar la decisión en un nuevo ADR en la wiki del proyecto.

---

## Paso 1: Implementar el adaptador

Crear un nuevo módulo en `services/integraciones/src/adaptadores/`, por ejemplo:
- `services/integraciones/src/adaptadores/tren.ts`, o
- `services/integraciones/src/adaptadores/autobus.ts`.

El módulo debe exportar una fábrica que devuelva un objeto conforme a la interfaz
`AdaptadorProveedorViaje` definida en `services/integraciones/src/adaptadores/tipos.ts`:

```ts
export interface AdaptadorProveedorViaje {
  readonly nombre: string;
  readonly tipo: string;
  readonly modo: 'aviso' | 'consulta';
  readonly intervaloConsultaMs: number;
  recibirAviso(cuerpo: Buffer | string, headers: EncabezadosAviso): ResultadoAvisoCrudo;
  consultarCambios(desde: string): Promise<ResultadoConsultaCruda>;
  traducir(mensaje: unknown, estadoPrevio?: EstadoReservaProveedor): ResultadoTraduccion;
  pedirOpcionesReprogramacion(numeroReserva: string): Promise<OpcionReprogramacion[]>;
  aplicarReprogramacion(
    numeroReserva: string,
    opcionId: string,
  ): Promise<ResultadoAplicarReprogramacion>;
}
```

### Reglas que debe cumplir el nuevo adaptador

- **Modo `aviso` (webhook):**
  - Implementar `recibirAviso(cuerpo, headers)` verificando la firma criptográfica del proveedor en
    tiempo constante sobre los bytes crudos (`ErrorFirmaInvalida` → responde `401`) y lanzando
    `ErrorCuerpoNoJson` si el cuerpo no es JSON válido (`400` + registro en `no_traducidos`).
  - `consultarCambios` devuelve `{ mensajes: [] }`.
  - La ruta pública `POST /webhooks/proveedores/:proveedor` **ya despacha automáticamente** al
    adaptador por su `nombre`, sin agregar rutas nuevas.
- **Modo `consulta` (polling):**
  - Implementar `consultarCambios(desde)` paginando la API del proveedor y devolviendo
    `{ mensajes, marcaMasAlta }` (la fecha ISO UTC más alta vista).
  - `recibirAviso` lanza `ErrorModoNoSoportado` (la ruta de webhooks responderá `404`).
  - El consultador periódico (`services/integraciones/src/consultador.ts`) **descubre y programa
    automáticamente** el adaptador con el intervalo configurado (por defecto 120 s).
- **Traducción a `ReservaActualizada` (`traducir`):**
  - Mapear el identificador del proveedor a `numeroReserva`, su estado a
    `'confirmada' | 'modificada' | 'cancelada'`, y sus cambios a `cambios` (`inicio`, `fin`,
    `origen`, `destino`, `detalle`).
  - Devolver `claveVersion` determinística para deduplicación (`proveedor + numeroReserva + claveVersion`).
  - Cuando `estado === 'cancelada'`, enviar `cambios: {}`.
  - Cuando `estado === 'modificada'`, asegurar al menos un campo en `cambios` (esquema
    `specs/schemas/ReservaActualizada.json`).
  - Si un mensaje no se puede traducir, devolver `{ ok: false, motivo, cuerpoSinDatosPersonales }`
    usando `serializarSinDatosPersonales(mensaje)` para quitar nombres, emails y teléfonos antes de
    persistirlo en `no_traducidos` (QA-6).
- **Reprogramación:**
  - Si el proveedor soporta cambios por API, implementar `pedirOpcionesReprogramacion` y
    `aplicarReprogramacion`. Si no, devolver `[]` en `pedirOpcionesReprogramacion` y lanzar
    `ErrorModoNoSoportado` en `aplicarReprogramacion`.

### Esqueleto mínimo de ejemplo (`tren.ts` en modo `consulta`)

```ts
import {
  ErrorModoNoSoportado,
  serializarSinDatosPersonales,
  type AdaptadorProveedorViaje,
} from './tipos.ts';

export interface OpcionesAdaptadorTren {
  nombre: string;
  url: string;
  claveApi: string;
  intervaloConsultaMs: number;
  fetch?: typeof fetch;
}

export function crearAdaptadorTren(opciones: OpcionesAdaptadorTren): AdaptadorProveedorViaje {
  return {
    nombre: opciones.nombre,
    tipo: 'tren',
    modo: 'consulta',
    intervaloConsultaMs: opciones.intervaloConsultaMs,
    recibirAviso() {
      throw new ErrorModoNoSoportado(`El proveedor ${opciones.nombre} trabaja por consulta.`);
    },
    async consultarCambios(desde) {
      // Llamar al endpoint del proveedor de trenes con `desde`, paginar y retornar { mensajes, marcaMasAlta }.
      return { mensajes: [] };
    },
    traducir(mensaje, estadoPrevio) {
      // Validar campos propios del formato del proveedor y traducir a ReservaActualizada.
      return {
        ok: false,
        motivo: 'Ejemplo sin implementar.',
        cuerpoSinDatosPersonales: serializarSinDatosPersonales(mensaje),
      };
    },
    async pedirOpcionesReprogramacion() {
      return [];
    },
    async aplicarReprogramacion() {
      throw new ErrorModoNoSoportado(`El proveedor ${opciones.nombre} no soporta reprogramación.`);
    },
  };
}
```

---

## Paso 2: Registrar la fábrica del nuevo tipo

En `services/integraciones/src/adaptadores/registro.ts`, importar la nueva fábrica y sumar una
entrada en `FABRICAS_PROVEEDORES_DEFECTO`:

```ts
import { crearAdaptadorTren } from './tren.ts';

export const FABRICAS_PROVEEDORES_DEFECTO: Record<string, FabricaAdaptadorProveedor> = {
  aerolinea: ...,
  hotel: ...,
  rentadora: ...,
  tren: (cfg, ctx) =>
    crearAdaptadorTren({
      nombre: cfg.nombre,
      url: cfg.url,
      claveApi: cfg.claveApi,
      intervaloConsultaMs: cfg.intervaloConsultaMs,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    }),
};
```

Si en el futuro se incorporan varios operadores ferroviarios con el mismo protocolo (por ejemplo,
`trenes-del-sur` y `expreso-andino`), **no hace falta escribir otro adaptador**: basta con agregar
una nueva entrada en `proveedores.yaml` con `tipo: tren`.

---

## Paso 3: Agregar la entrada en `config/proveedores.yaml`

Editar `services/integraciones/config/proveedores.yaml` y añadir el proveedor bajo `proveedores:`:

```yaml
proveedores:
  # ... proveedores existentes (aerolinea-andina, hotel-cordillera, rentadora-sur) ...

  - nombre: trenes-del-sur
    tipo: tren
    modo: consulta
    urlEnv: URL_TRENES_DEL_SUR
    urlPorDefecto: http://mock-trenes:4008
    claveApiEnv: CLAVE_API_TRENES_DEL_SUR
    intervaloConsultaSegEnv: INTERVALO_CONSULTA_TRENES_SEG
    intervaloConsultaSeg: 120
```

Si el proveedor de autobuses o trenes avisara por webhook en lugar de consulta periódica, declarar
`modo: aviso` y `secretoWebhookEnv: SECRETO_WEBHOOK_<PROVEEDOR>`.

---

## Paso 4: Declarar variables de entorno y credenciales

1. Documentar las nuevas variables (con valores de ejemplo `cambiar-...`) en:
   - `services/integraciones/.env.example`
   - `.env.example` (si se despliega con Docker Compose)
2. Pasar las variables al contenedor `integraciones` en `infra/region.compose.yaml` (si aplica).
3. **Nunca** escribir claves de API ni secretos de webhook directamente en `proveedores.yaml`.

---

## Paso 5: Agregar pruebas

En `services/integraciones/test/`:
- **Pruebas unitarias (`adaptadores.test.ts` o `<tipo>.test.ts`):**
  - Traducción de confirmación, modificación (diff mínimo) y cancelación.
  - Verificación de firma (si es modo `aviso`) o paginación (si es modo `consulta`).
  - Mensajes malformados → `ok: false` y sin datos personales en `cuerpoSinDatosPersonales`.
  - Lote representativo validando >= 99 % de traducción automática (QA-6) y conformidad con
    `specs/schemas/ReservaActualizada.json`.
- **Prueba de integración:** comprobar que un cambio en el proveedor (o mock) publica exactamente
  un evento `ReservaActualizada` en RabbitMQ vía outbox y que un mensaje repetido no duplica.

---

## Paso 6: Registrar el ADR en la wiki

Documentar en la wiki del proyecto (`ADR-0XX-Integracion-<proveedor>.md`) el protocolo elegido
(webhook vs. consulta), la estrategia de autenticación/firma, el mapeo de campos a
`ReservaActualizada`, los campos sensibles a quitar antes de `no_traducidos` y la decisión sobre
reprogramación asistida.

---

## Verificación de aislamiento (QA-10)

| Componente | ¿Requiere cambios? |
|---|---|
| `services/integraciones/src/adaptadores/<tipo>.ts` | **Sí** (archivo nuevo) |
| `services/integraciones/src/adaptadores/registro.ts` | **Sí** (1 línea de registro) |
| `services/integraciones/config/proveedores.yaml` | **Sí** (1 bloque YAML) |
| `services/integraciones/src/procesador.ts`, `consultador.ts`, `rutas.ts`, `repositorio.ts` | **No** |
| `services/viajes/`, `services/correo/`, `services/gateway/`, `services/asistente/`, `web/` | **No** |
| `specs/schemas/ReservaActualizada.json` | **No** |
