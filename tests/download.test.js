import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadWithProgress } from '../src/download.js';

/** A Response whose body streams in chunks, with a chosen Content-Length. */
function streamedResponse(bytes, { contentLength, ok = true, status = 200, chunk = 7 } = {}) {
  const body = new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
      c.close();
    },
  });
  const headers = contentLength == null ? {} : { 'content-length': String(contentLength) };
  return new Response(ok ? body : null, { status, headers });
}

const payload = new Uint8Array(64).map((_, i) => i);
const fetcher = (res) => async () => res;

test('a gzipped response, whose Content-Length is the compressed size, downloads fine', async () => {
  // The exact shape of the GitHub Pages failure: the header says 20 bytes,
  // the browser hands over 64 decoded ones.
  const progress = [];
  const out = await downloadWithProgress('x', {
    fetchImpl: fetcher(streamedResponse(payload, { contentLength: 20 })),
    onProgress: (received, total) => progress.push([received, total]),
  });
  assert.deepEqual([...out], [...payload], 'every byte survives');
  for (const [received, total] of progress) {
    assert.ok(total === 0 || received <= total, `never reports ${received} of ${total}`);
  }
});

test('an honest Content-Length drives the progress total', async () => {
  const progress = [];
  const out = await downloadWithProgress('x', {
    fetchImpl: fetcher(streamedResponse(payload, { contentLength: payload.length })),
    onProgress: (received, total) => progress.push([received, total]),
  });
  assert.equal(out.length, payload.length);
  assert.ok(progress.length > 1, 'reports as it goes');
  assert.deepEqual(progress.at(-1), [64, 64]);
});

test('a known decoded size wins over the header', async () => {
  const seen = [];
  await downloadWithProgress('x', {
    expectedBytes: payload.length,
    fetchImpl: fetcher(streamedResponse(payload, { contentLength: 20 })),
    onProgress: (received, total) => seen.push(total),
  });
  assert.ok(seen.every((t) => t === payload.length), 'uses the real size throughout');
});

test('a missing Content-Length still downloads', async () => {
  const out = await downloadWithProgress('x', { fetchImpl: fetcher(streamedResponse(payload)) });
  assert.deepEqual([...out], [...payload]);
});

test('an HTTP error is reported as one, not as a stream problem', async () => {
  await assert.rejects(
    downloadWithProgress('engine.wasm', { fetchImpl: fetcher(streamedResponse(payload, { ok: false, status: 404 })) }),
    /Could not download engine\.wasm \(HTTP 404\)/,
  );
});

test('the body is read once, so no fallback can ever double-read it', async () => {
  const res = streamedResponse(payload, { contentLength: 20 });
  await downloadWithProgress('x', { fetchImpl: fetcher(res) });
  // If the implementation had re-read the body, this would already have thrown.
  assert.equal(res.bodyUsed, true);
});

/* ------------------------------------------------------------------ *
 * reading a picked file
 * ------------------------------------------------------------------ */

import { readFileBytes } from '../src/download.js';

const bytes = new Uint8Array(48).map((_, i) => (i * 7) % 251);

test('a healthy file is read through the fast path', async () => {
  const seen = [];
  const out = await readFileBytes(new Blob([bytes]), { onProgress: (r, t) => seen.push([r, t]) });
  assert.deepEqual([...out], [...bytes]);
  assert.deepEqual(seen.at(-1)[0], bytes.length);
});

test('a file whose arrayBuffer() fails falls back to streaming', async () => {
  const blob = new Blob([bytes]);
  const flaky = {
    name: 'clip.mp4',
    size: bytes.length,
    arrayBuffer: () => Promise.reject(new Error('permission denied')),
    stream: () => blob.stream(),
  };
  const out = await readFileBytes(flaky);
  assert.deepEqual([...out], [...bytes], 'streaming recovers what the one-shot read could not');
});

test('when every read fails the user is told what to do, not given a code', async () => {
  const dead = {
    name: 'from-cloud.mp4',
    size: 1234,
    arrayBuffer: () => Promise.reject(new Error('NotReadableError')),
    stream: () => { throw new Error('NotReadableError'); },
  };
  await assert.rejects(readFileBytes(dead), (err) => {
    assert.match(err.message, /from-cloud\.mp4/, 'names the file');
    assert.match(err.message, /Google Photos|cloud/i, 'explains the likely cause');
    assert.match(err.message, /download it to the device/i, 'says what to do next');
    assert.ok(Array.isArray(err.attempts) && err.attempts.length >= 2, 'keeps the underlying causes for the log');
    return true;
  });
});

test('streaming reports progress against the file size', async () => {
  const blob = new Blob([bytes]);
  const seen = [];
  await readFileBytes(
    { name: 'x.mp4', size: bytes.length, stream: () => blob.stream() },
    { onProgress: (r, t) => seen.push([r, t]) },
  );
  assert.ok(seen.length >= 1);
  assert.equal(seen.at(-1)[1], bytes.length);
});
