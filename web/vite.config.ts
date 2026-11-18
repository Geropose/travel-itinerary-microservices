import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Aplicación web y móvil (CONST-1): el mismo código se instala como PWA en el teléfono. El service
// worker guarda la aplicación para que abra sin red; el último panel lo guarda la cache local en
// IndexedDB (src/cache/panel.ts, QA-3).
export default defineConfig({
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icono.svg'],
      manifest: {
        name: 'Trotamundos',
        short_name: 'Trotamundos',
        description: 'Tus viajes, reservas e itinerarios en un solo lugar.',
        lang: 'es',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#0f766e',
        icons: [
          { src: 'icono-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icono-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icono-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        // La API está en otro origen (el enrutador global): el service worker no la toca.
        navigateFallback: '/index.html',
      },
    }),
  ],
});
