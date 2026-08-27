/**
 * Fetch a file while reporting how many bytes have arrived.
 *
 * Two things here are deliberate, and both come from a real failure:
 *
 * 1. `Content-Length` is treated as a *hint*, never as a check. When a server
 *    compresses the response — GitHub Pages gzips the 32 MB ffmpeg core down to
 *    about 10 MB — the header carries the compressed length while the browser
 *    hands us the decoded bytes. Comparing the two and concluding the download
 *    was truncated is wrong.
 * 2. The body is read exactly once. Falling back to `response.arrayBuffer()`
 *    after the stream has been consumed throws "body stream already read",
 *    which turns any hiccup into a confusing error about the wrong thing.
 */
export async function downloadWithProgress(url, options = {}) {
  const { onProgress = () => {}, expectedBytes = 0, fetchImpl = fetch } = options;

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Could not download ${url} (HTTP ${res.status}).`);

  // A known decoded size beats the header, which may describe compressed bytes.
  const headerLength = Number(res.headers?.get?.('content-length')) || 0;
  const total = expectedBytes > 0 ? expectedBytes : headerLength;

  if (!res.body?.getReader) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    // Never report a total we have already exceeded — that means it was the
    // compressed length, so switch to reporting raw bytes instead.
    onProgress(received, received > total ? 0 : total);
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  onProgress(received, received > total ? received : total);
  return out;
}

/** Wrap bytes in an object URL so a worker can load them without re-fetching. */
export function bytesToBlobUrl(bytes, type) {
  return URL.createObjectURL(new Blob([bytes], { type }));
}

/**
 * Read a picked File into memory.
 *
 * `FileReader` — what @ffmpeg/util uses — is the legacy API and is the part
 * that fails, with a bare "File could not be read! Code=-1", when Android hands
 * over a handle whose backing content is not actually readable (a video picked
 * straight out of a cloud gallery is the usual case). Try the modern APIs
 * first, fall back through the older ones, and if everything fails say what the
 * user can do about it rather than quoting an error code.
 */
export async function readFileBytes(file, options = {}) {
  const { onProgress = () => {} } = options;
  const size = file?.size || 0;
  const attempts = [];

  // Fastest and least memory-hungry: one allocation, no intermediate copies.
  if (typeof file?.arrayBuffer === 'function') {
    try {
      const buf = await file.arrayBuffer();
      onProgress(buf.byteLength, size);
      return new Uint8Array(buf);
    } catch (err) {
      attempts.push(`arrayBuffer: ${err?.message || err}`);
    }
  }

  // Streaming gives progress on a large file and survives some cases the
  // one-shot read does not.
  if (typeof file?.stream === 'function') {
    try {
      const reader = file.stream().getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress(received, size);
      }
      const out = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    } catch (err) {
      attempts.push(`stream: ${err?.message || err}`);
    }
  }

  // Last resort, for anything old enough to need it.
  if (typeof FileReader === 'function') {
    try {
      return await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(new Uint8Array(fr.result));
        fr.onerror = () => reject(fr.error || new Error('FileReader failed'));
        fr.readAsArrayBuffer(file);
      });
    } catch (err) {
      attempts.push(`FileReader: ${err?.message || err}`);
    }
  }

  const err = new Error(
    `This device would not let the app read "${file?.name || 'that file'}". ` +
      'If you picked it from Google Photos, Drive or another cloud app, download it to the device first ' +
      'and pick it from Files or Gallery instead.',
  );
  err.attempts = attempts;
  throw err;
}
