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

// A visible build stamp, so a stale cached copy can be identified at a glance.
const buildId = [
  new Date().toISOString().slice(0, 16).replace('T', ' '),
  (process.env.GITHUB_SHA || '').slice(0, 7),
].filter(Boolean).join(' · ');

export default defineConfig({
  // Set VITE_BASE when deploying under a subdirectory, e.g. GitHub Pages.
  base: process.env.VITE_BASE || '/',
  define: {
    __FFMPEG_WASM_BYTES__: JSON.stringify(wasmBytes),
    __BUILD_ID__: JSON.stringify(buildId),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: 'es' },
  server: { host: true },
  preview: { host: true },
});
