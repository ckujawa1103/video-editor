import { statSync } from 'node:fs';
import { defineConfig } from 'vite';

// The decoded size of the engine, so the app can show real download progress
// without trusting Content-Length (which is the compressed size when the host
// gzips, as GitHub Pages does).
let wasmBytes = 0;
try {
  wasmBytes = statSync(new URL('./public/ffmpeg/core/ffmpeg-core.wasm', import.meta.url)).size;
} catch {
  /* not vendored yet; the app falls back to reporting bytes received */
}

export default defineConfig({
  // Set VITE_BASE when deploying under a subdirectory, e.g. GitHub Pages.
  base: process.env.VITE_BASE || '/',
  define: { __FFMPEG_WASM_BYTES__: JSON.stringify(wasmBytes) },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: 'es' },
  server: { host: true },
  preview: { host: true },
});
