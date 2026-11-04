import { defineConfig } from 'vite';

export default defineConfig({
  root: './client',
  // The simulation's own files are under /_cosmo (a task's app may use the rest); the page is at /.
  base: '/_cosmo/',
  server: {
    host: '0.0.0.0',
    hmr: true,
    allowedHosts: true,
    port: 3000,
    proxy: {
      '/_cosmo/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/_cosmo/engine': { target: 'http://localhost:3001', changeOrigin: true, ws: true },
      '/_cosmo/agents': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
