/**
 * A tiny static server for the end-to-end test that behaves like GitHub Pages,
 * gzip and all.
 *
 * This matters: with an uncompressed server the engine downloads fine, but on a
 * gzipping host `Content-Length` describes the *compressed* size while the
 * browser decodes far more bytes. Code that treats the header as the true
 * length breaks only in production. Serving compressed here means the tests see
 * what the phone sees.
 */
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export function startStaticServer({ root, port, base = '/' }) {
  const cache = new Map();

  const load = (file) => {
    if (cache.has(file)) return cache.get(file);
    const raw = readFileSync(file);
    const entry = { raw, gzipped: gzipSync(raw, { level: 6 }), type: TYPES[extname(file)] || 'application/octet-stream' };
    cache.set(file, entry);
    return entry;
  };

  const server = createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (base !== '/' && pathname.startsWith(base)) pathname = pathname.slice(base.length - 1);
    if (pathname.endsWith('/')) pathname += 'index.html';

    const file = join(root, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    let entry;
    try {
      if (!statSync(file).isFile()) throw new Error('not a file');
      entry = load(file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }

    // Compress whenever the client will take it, exactly as Pages does — the
    // Content-Length then describes the compressed bytes.
    const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const body = wantsGzip ? entry.gzipped : entry.raw;
    const headers = { 'content-type': entry.type, 'content-length': String(body.length) };
    if (wantsGzip) headers['content-encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
