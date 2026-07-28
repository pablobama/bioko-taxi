import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En desarrollo, /api se redirige al servidor Fastify (npm run servir en
// /servidor). En producción la PWA se sirve desde el propio servidor y no
// hay redirección que hacer.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
  build: {
    // Objetivo de la sección 12: PWA < 1 MB. Sin mapas, sin librerías pesadas.
    chunkSizeWarningLimit: 300,
  },
});
