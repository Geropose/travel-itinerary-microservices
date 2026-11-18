// Lo que comparten todas las pantallas: el cliente de API, la sesión y el almacenamiento local.
import { createContext, use, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { Api } from './api/cliente.ts';
import { leerClaims, type Almacen, type Claims, type Rol, type Sesion } from './api/sesion.ts';

export interface ContextoApp {
  api: Api;
  sesion: Sesion;
  almacen: Almacen;
}

const Contexto = createContext<ContextoApp | null>(null);

export function ProveedorApp({ valor, children }: { valor: ContextoApp; children: ReactNode }) {
  return <Contexto value={valor}>{children}</Contexto>;
}

export function useApp(): ContextoApp {
  const valor = use(Contexto);
  if (!valor) throw new Error('useApp necesita <ProveedorApp>');
  return valor;
}

/** Claims del JWT de la sesión actual; se actualiza al iniciar, renovar o cerrar la sesión. */
export function useClaims(): Claims | undefined {
  const { sesion } = useApp();
  const datos = useSyncExternalStore(sesion.suscribir, sesion.obtener);
  return useMemo(() => (datos ? leerClaims(datos.jwt) : undefined), [datos]);
}

export const tieneRol = (claims: Claims | undefined, rol: Rol) =>
  claims?.roles.includes(rol) ?? false;
