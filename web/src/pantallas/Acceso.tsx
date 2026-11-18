// Pantallas de inicio de sesión y registro (autenticacion.yaml).
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { iniciarSesion, registrarse, type ErrorAcceso } from '../acciones.ts';
import type { Region } from '../api/sesion.ts';
import { SelectorIdioma, useIdioma } from '../componentes.tsx';
import { useApp } from '../contexto.tsx';

const MENSAJES: Record<ErrorAcceso, string> = {
  credenciales: 'login.errorCredenciales',
  bloqueado: 'login.errorBloqueado',
  emailUsado: 'registro.errorEmailUsado',
  noDisponible: 'errores.noDisponible',
  inesperado: 'errores.inesperado',
};

function Marco({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <main className="acceso">
      <header className="acceso-cabecera">
        <span className="marca">{t('app.nombre')}</span>
        <SelectorIdioma />
      </header>
      <section className="tarjeta">
        <h1>{titulo}</h1>
        {children}
      </section>
    </main>
  );
}

function useEnvio() {
  const [error, setError] = useState<ErrorAcceso>();
  const [enviando, setEnviando] = useState(false);
  const enviar = async (accion: () => Promise<{ ok: boolean; error?: ErrorAcceso }>) => {
    setEnviando(true);
    setError(undefined);
    const resultado = await accion();
    setEnviando(false);
    if (!resultado.ok) setError(resultado.error ?? 'inesperado');
  };
  return { error, enviando, enviar };
}

export function Login() {
  const { t } = useTranslation();
  const { api, sesion, almacen } = useApp();
  const { error, enviando, enviar } = useEnvio();

  const alEnviar = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const datos = new FormData(e.currentTarget);
    void enviar(() =>
      iniciarSesion(
        api,
        sesion,
        almacen,
        String(datos.get('email')),
        String(datos.get('contrasena')),
      ),
    );
  };

  return (
    <Marco titulo={t('login.titulo')}>
      <form className="formulario" onSubmit={alEnviar}>
        <label>
          {t('login.email')}
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          {t('login.contrasena')}
          <input name="contrasena" type="password" autoComplete="current-password" required />
        </label>
        {error && <p role="alert">{t(MENSAJES[error])}</p>}
        <button type="submit" disabled={enviando}>
          {t('login.entrar')}
        </button>
      </form>
      <p>
        {t('login.sinCuenta')} <Link to="/registro">{t('login.irARegistro')}</Link>
      </p>
    </Marco>
  );
}

export function Registro() {
  const { t } = useTranslation();
  const { api, sesion, almacen } = useApp();
  const idioma = useIdioma();
  const { error, enviando, enviar } = useEnvio();
  const regionInicial = sesion.region() ?? 'region-1';

  const alEnviar = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const datos = new FormData(e.currentTarget);
    void enviar(() =>
      registrarse(api, sesion, almacen, {
        nombre: String(datos.get('nombre')),
        email: String(datos.get('email')),
        contrasena: String(datos.get('contrasena')),
        region: String(datos.get('region')) as Region,
        idioma,
      }),
    );
  };

  return (
    <Marco titulo={t('registro.titulo')}>
      <form className="formulario" onSubmit={alEnviar}>
        <label>
          {t('registro.nombre')}
          <input name="nombre" autoComplete="name" required maxLength={100} />
        </label>
        <label>
          {t('registro.email')}
          <input name="email" type="email" autoComplete="email" required maxLength={254} />
        </label>
        <label>
          {t('registro.contrasena')}
          <input
            name="contrasena"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={128}
            aria-describedby="ayuda-contrasena"
          />
          <small id="ayuda-contrasena">{t('registro.ayudaContrasena')}</small>
        </label>
        <label>
          {t('registro.region')}
          <select name="region" defaultValue={regionInicial} aria-describedby="ayuda-region">
            <option value="region-1">{t('regiones.region-1')}</option>
            <option value="region-2">{t('regiones.region-2')}</option>
          </select>
          <small id="ayuda-region">{t('registro.regionAyuda')}</small>
        </label>
        {error && <p role="alert">{t(MENSAJES[error])}</p>}
        <button type="submit" disabled={enviando}>
          {t('registro.crear')}
        </button>
      </form>
      <p>
        {t('registro.conCuenta')} <Link to="/login">{t('registro.irALogin')}</Link>
      </p>
    </Marco>
  );
}
