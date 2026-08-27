// Copies the ffmpeg.wasm core out of node_modules into public/ffmpeg so the app
// self-hosts it — the service worker can then cache it for offline use, and
// there is no CDN in the loop.
//
// Only the single-threaded core is shipped: @ffmpeg/core-mt (0.12.6, 0.12.9 and
// 0.12.10 all tested) crashes with "null function or function signature
// mismatch" on any job that decodes H.264 and re-encodes it, which is most of
// what this app does.
import { mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'ffmpeg');

const files = [
  ['@ffmpeg/core/dist/esm/ffmpeg-core.js', 'core/ffmpeg-core.js'],
  ['@ffmpeg/core/dist/esm/ffmpeg-core.wasm', 'core/ffmpeg-core.wasm'],
];

let copied = 0;
for (const [from, to] of files) {
  const src = join(root, 'node_modules', from);
  const dst = join(out, to);
  if (!existsSync(src)) {
    console.error(`vendor-ffmpeg: missing ${from} — run npm install first`);
    process.exit(1);
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  copied += statSync(dst).size;
}
console.log(`vendor-ffmpeg: copied ${files.length} files (${(copied / 1e6).toFixed(1)} MB) into public/ffmpeg`);
