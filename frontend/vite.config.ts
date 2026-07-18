import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    // Mirror the deployed routing in dev: vercel.json rewrites `/console` →
    // console.html, and the root serves public/index.html (the landing) as a
    // plain static file — Vite dev does neither on its own (no root
    // index.html). /console.html stays untouched (its next char is a dot).
    {
      name: 'console-route',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url) {
            req.url = req.url.replace(/^\/console(?=$|\?)/, '/console.html');
            if (req.url === '/') req.url = '/index.html';
          }
          next();
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      // The console entry is console.html — public/index.html (the landing page) owns the root URL.
      input: fileURLToPath(new URL('console.html', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
