/** Proveedores de correo soportados por defecto (extensible vía RegistroAdaptadores, ADR-003). */
export type ProveedorCorreo = 'gmail' | 'outlook' | (string & {});

export type CodigoErrorProveedor =
  | 'scope-insuficiente'
  | 'codigo-invalido'
  | 'permiso-revocado'
  | 'token-invalido'
  | 'limite-cuota'
  | 'cursor-expirado'
  | 'mensaje-no-encontrado'
  | 'proveedor-no-disponible';

/** Error normalizado que lanzan los adaptadores sin exponer credenciales ni detalles internos. */
export class ErrorProveedorCorreo extends Error {
  readonly codigo: CodigoErrorProveedor;
  readonly retryAfterSeg?: number;

  constructor(codigo: CodigoErrorProveedor, mensaje: string, retryAfterSeg?: number) {
    super(mensaje);
    this.name = 'ErrorProveedorCorreo';
    this.codigo = codigo;
    if (retryAfterSeg !== undefined) this.retryAfterSeg = retryAfterSeg;
  }
}

export interface CredencialesOAuth {
  accessToken: string;
  /** En Gmail no se reenvía al renovar; en Outlook rota en cada renovación. */
  refreshToken?: string;
  expiraEn: Date;
  scope: string;
}

export interface PerfilCorreo {
  email: string;
}

export interface SuscripcionAvisos {
  suscripcionId: string;
  venceEn: Date;
  cursorInicial?: string;
  secreto?: string;
}

export interface DesdeRevision {
  cursor?: string | null;
  fechaDesde?: Date;
}

export interface ResumenMensajeNuevo {
  id: string;
  recibidoEn?: Date;
}

export interface ResultadoListaMensajes {
  mensajes: ResumenMensajeNuevo[];
  nuevoCursor?: string;
  cursorExpirado?: boolean;
}

export interface MensajeCorreo {
  id: string;
  remitente: string;
  asunto: string;
  recibidoEn: Date;
  cuerpoHtml?: string;
  cuerpoTexto?: string;
  cursor?: string;
  internetMessageId?: string;
}

/**
 * Puerto único para todos los proveedores de correo (ADR-003).
 * Agregar un proveedor nuevo implica implementar esta interfaz y registrarla sin tocar los demás.
 */
export interface AdaptadorCorreo {
  readonly proveedor: ProveedorCorreo;
  /** Indica si el proveedor entrega avisos push y no requiere polling por intervalo tras la revisión inicial. */
  readonly soportaPush?: boolean;

  /** Construye la URL OAuth de autorización con scope de solo lectura y el `state` firmado. */
  urlAutorizacion(state: string): string;

  /** Comprueba opcionalmente que el `scope` informado en la query del callback sea solo lectura. */
  validarScopeCallback?(scope: string): boolean;

  /** Canjea el `code` por tokens, valida que el scope sea solo lectura y consulta el perfil. */
  canjearCodigo(codigo: string): Promise<{
    credenciales: CredencialesOAuth;
    perfil: PerfilCorreo;
  }>;

  /** Renueva el access token a partir del refresh token guardado. */
  renovarToken(refreshToken: string): Promise<CredencialesOAuth>;

  /** Lista mensajes nuevos desde el cursor o fecha indicados. */
  listarNuevos(accessToken: string, desde: DesdeRevision): Promise<ResultadoListaMensajes>;

  /** Obtiene un mensaje completo decodificado (encabezados y cuerpos HTML/texto). */
  leerMensaje(accessToken: string, mensajeId: string): Promise<MensajeCorreo>;

  /** Activa notificaciones push en el proveedor cuando el proveedor las soporta. */
  suscribirAvisos(accessToken: string): Promise<SuscripcionAvisos | null>;

  /** Cancela la suscripción push al desconectar una cuenta, si el proveedor lo soporta. */
  desuscribirAvisos?(accessToken: string, suscripcionId: string): Promise<void>;
}
