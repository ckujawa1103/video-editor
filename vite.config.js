import { defineConfig } from 'vite';

export default defineConfig({
  // Set VITE_BASE when deploying under a subdirectory, e.g. GitHub Pages.
  base: process.env.VITE_BASE || '/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: 'es' },
  server: { host: true },
  preview: { host: true },
});
