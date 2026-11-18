// Estructura de las pantallas con sesión: barra con el menú, el idioma y cerrar sesión. En el
// teléfono el menú queda abajo, al alcance del pulgar (CONST-1).
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import { cerrarSesion } from '../acciones.ts';
import { SelectorIdioma, useEnLinea } from '../componentes.tsx';
import { tieneRol, useApp, useClaims } from '../contexto.tsx';

/** Pantallas del menú del usuario (rol usuario). */
export const MENU_USUARIO = [
  { ruta: '/', clave: 'menu.panel' },
  { ruta: '/archivados', clave: 'menu.archivados' },
  { ruta: '/correo', clave: 'menu.correo' },
  { ruta: '/whitelist', clave: 'menu.whitelist' },
  { ruta: '/asistente', clave: 'menu.asistente' },
] as const;

/** El analista solo usa Analítica (el gateway no lo deja entrar al resto, CONVENCIONES 4.6). */
export const MENU_ANALISTA = [{ ruta: '/analitica', clave: 'menu.analitica' }] as const;

export function Layout() {
  const { t } = useTranslation();
  const { api, sesion } = useApp();
  const claims = useClaims();
  const enLinea = useEnLinea();
  const esAnalista = tieneRol(claims, 'analista');
  const menu = esAnalista ? MENU_ANALISTA : MENU_USUARIO;

  return (
    <div className="layout">
      <header className="barra">
        <span className="marca">{t('app.nombre')}</span>
        <div className="barra-acciones">
          <SelectorIdioma />
          {!esAnalista && (
            <NavLink className="enlace-barra" to="/preferencias">
              {t('menu.preferencias')}
            </NavLink>
          )}
          <button
            type="button"
            className="secundario"
            onClick={() => void cerrarSesion(api, sesion, claims)}
          >
            {t('app.cerrarSesion')}
          </button>
        </div>
      </header>
      {!enLinea && (
        <p className="aviso" role="status">
          {t('app.sinConexion')}
        </p>
      )}
      <main className="contenido">
        <Outlet />
      </main>
      <nav className="menu" aria-label={t('menu.titulo')}>
        {menu.map(({ ruta, clave }) => (
          <NavLink key={ruta} to={ruta} end>
            {t(clave)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
