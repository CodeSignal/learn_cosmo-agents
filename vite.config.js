import { defineConfig } from 'vite';

export default defineConfig({
  root: './client',
  server: {
    host: '0.0.0.0',
    hmr: true,
    allowedHosts: true,
    port: 3000,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/engine': { target: 'http://localhost:3001', changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
