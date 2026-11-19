// Almacén en memoria de casos recibidos por la agencia de viajes (specs/externos/agencia.md).

export type PrioridadCaso = 'urgent' | 'high' | 'normal' | 'low';

export interface SolicitanteCaso {
  name?: string;
  email?: string;
}

export interface CasoAgencia {
  id: number;
  status: 'new' | 'open' | 'pending' | 'hold' | 'solved' | 'closed';
  subject: string;
  priority: PrioridadCaso;
  external_id?: string;
  tags: string[];
  requester?: SolicitanteCaso;
  comment: { body: string };
  created_at: string;
  updated_at: string;
}

export interface RespuestaTicket {
  id: number;
  status: CasoAgencia['status'];
  subject: string;
  priority: PrioridadCaso;
  external_id?: string;
  tags: string[];
  requester?: SolicitanteCaso;
  created_at: string;
  updated_at: string;
}

export interface AlmacenCasos {
  crear(datos: {
    subject: string;
    commentBody: string;
    priority: PrioridadCaso;
    external_id?: string;
    tags: string[];
    requester?: SolicitanteCaso;
  }): CasoAgencia;
  listar(): CasoAgencia[];
  buscar(id: number): CasoAgencia | undefined;
  limpiar(): void;
}

export function aTicketPublico(caso: CasoAgencia): RespuestaTicket {
  return {
    id: caso.id,
    status: caso.status,
    subject: caso.subject,
    priority: caso.priority,
    ...(caso.external_id ? { external_id: caso.external_id } : {}),
    tags: [...caso.tags],
    ...(caso.requester ? { requester: { ...caso.requester } } : {}),
    created_at: caso.created_at,
    updated_at: caso.updated_at,
  };
}

export function crearAlmacenCasos(reloj: () => number = Date.now): AlmacenCasos {
  const casos = new Map<number, CasoAgencia>();
  let siguienteId = 35436;

  return {
    crear(datos) {
      const ahora = new Date(reloj()).toISOString();
      const caso: CasoAgencia = {
        id: siguienteId++,
        status: 'new',
        subject: datos.subject,
        priority: datos.priority,
        ...(datos.external_id ? { external_id: datos.external_id } : {}),
        tags: [...datos.tags],
        ...(datos.requester ? { requester: { ...datos.requester } } : {}),
        comment: { body: datos.commentBody },
        created_at: ahora,
        updated_at: ahora,
      };
      casos.set(caso.id, caso);
      return {
        ...caso,
        tags: [...caso.tags],
        comment: { ...caso.comment },
        ...(caso.requester ? { requester: { ...caso.requester } } : {}),
      };
    },

    listar() {
      return [...casos.values()].map((c) => ({
        ...c,
        tags: [...c.tags],
        comment: { ...c.comment },
        ...(c.requester ? { requester: { ...c.requester } } : {}),
      }));
    },

    buscar(id) {
      const c = casos.get(id);
      if (!c) return undefined;
      return {
        ...c,
        tags: [...c.tags],
        comment: { ...c.comment },
        ...(c.requester ? { requester: { ...c.requester } } : {}),
      };
    },

    limpiar() {
      casos.clear();
      siguienteId = 35436;
    },
  };
}
