// Rutas de la aplicación. Registro y login son públicos; el resto necesita sesión. /analitica es
// solo del rol analista y las demás del rol usuario (el gateway lo vuelve a verificar, ADR-005).
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes } from 'react-router';
import type { Rol } from './api/sesion.ts';
import { EnConstruccion, SinPermiso } from './componentes.tsx';
import { tieneRol, useClaims } from './contexto.tsx';
import { Login, Registro } from './pantallas/Acceso.tsx';
import { Correo } from './pantallas/Correo.tsx';
import { Layout } from './pantallas/Layout.tsx';
import { Panel } from './pantallas/Panel.tsx';
import { Preferencias } from './pantallas/Preferencias.tsx';
import { ViajeDetalle } from './pantallas/ViajeDetalle.tsx';
import { Whitelist } from './pantallas/Whitelist.tsx';

/** Pantalla de inicio de cada rol. */
const inicioDe = (analista: boolean) => (analista ? '/analitica' : '/');

function SoloSinSesion({ children }: { children: ReactNode }) {
  const claims = useClaims();
  if (claims) return <Navigate to={inicioDe(tieneRol(claims, 'analista'))} replace />;
  return children;
}

function ConSesion({ children }: { children: ReactNode }) {
  return useClaims() ? children : <Navigate to="/login" replace />;
}

/** Solo para un rol. El analista que entra a una pantalla de usuario va a la suya. */
function ConRol({ rol, children }: { rol: Rol; children: ReactNode }) {
  const claims = useClaims();
  if (tieneRol(claims, rol)) return children;
  if (rol === 'usuario' && tieneRol(claims, 'analista'))
    return <Navigate to="/analitica" replace />;
  return <SinPermiso />;
}

export function App() {
  const { t } = useTranslation();
  const enConstruccion = (clave: string) => (
    <ConRol rol="usuario">
      <EnConstruccion titulo={t(clave)} />
    </ConRol>
  );
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <SoloSinSesion>
            <Login />
          </SoloSinSesion>
        }
      />
      <Route
        path="/registro"
        element={
          <SoloSinSesion>
            <Registro />
          </SoloSinSesion>
        }
      />
      <Route
        element={
          <ConSesion>
            <Layout />
          </ConSesion>
        }
      >
        <Route
          index
          element={
            <ConRol rol="usuario">
              <Panel />
            </ConRol>
          }
        />
        <Route path="archivados" element={enConstruccion('menu.archivados')} />
        <Route
          path="correo"
          element={
            <ConRol rol="usuario">
              <Correo />
            </ConRol>
          }
        />
        <Route
          path="whitelist"
          element={
            <ConRol rol="usuario">
              <Whitelist />
            </ConRol>
          }
        />
        <Route
          path="preferencias"
          element={
            <ConRol rol="usuario">
              <Preferencias />
            </ConRol>
          }
        />
        <Route
          path="viajes/:viajeId"
          element={
            <ConRol rol="usuario">
              <ViajeDetalle />
            </ConRol>
          }
        />
        <Route path="asistente" element={enConstruccion('menu.asistente')} />
        <Route
          path="analitica"
          element={
            <ConRol rol="analista">
              <EnConstruccion titulo={t('menu.analitica')} />
            </ConRol>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
