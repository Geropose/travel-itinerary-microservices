import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { crearApi } from './api/cliente.ts';
import { crearSesion } from './api/sesion.ts';
import { App } from './App.tsx';
import { borrarPanel } from './cache/panel.ts';
import { ProveedorApp } from './contexto.tsx';
import { idiomaInicial, iniciarIdiomas } from './idiomas/i18n.ts';
import './estilos.css';

const almacen = window.localStorage;
const sesion = crearSesion(almacen);
iniciarIdiomas(idiomaInicial(almacen, navigator.language));
const api = crearApi({
  urlBase: (import.meta.env.VITE_URL_API as string | undefined) ?? 'http://localhost:8000',
  sesion,
  alVencer: (sub) => {
    if (sub) void borrarPanel(sub).catch(() => undefined);
  },
});
// Para las pantallas de cada dueño (cache de las consultas en memoria).
const consultas = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

const raiz = document.getElementById('raiz');
if (!raiz) throw new Error('Falta el elemento #raiz');
createRoot(raiz).render(
  <StrictMode>
    <QueryClientProvider client={consultas}>
      <ProveedorApp valor={{ api, sesion, almacen }}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ProveedorApp>
    </QueryClientProvider>
  </StrictMode>,
);
