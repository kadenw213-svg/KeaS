import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = 'http://127.0.0.1:4850';

// Run from the repo root as `vite web` / `vite build web`: root is web/, output web/dist.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/v1': {
        target: SERVER,
        changeOrigin: true,
        // The server refuses cross-origin writes; through the proxy the page and API share an origin,
        // so present the request as coming from the server's own origin.
        configure: (proxy) => {
          proxy.on('proxyReq', (req, incoming) => {
            if (incoming.headers.origin) req.setHeader('origin', SERVER);
          });
        }
      }
    }
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2020' }
});
