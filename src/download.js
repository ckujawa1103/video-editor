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
