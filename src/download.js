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

/** Describe a failure precisely enough to act on: DOMExceptions carry a name. */
function describe(err) {
  const name = err?.name && err.name !== 'Error' ? err.name : '';
  const message = err?.message || String(err);
  return name && !message.includes(name) ? `${name}: ${message}` : message;
}

const SLICE = 4 * 1024 * 1024;

/**
 * Read a picked File into memory, trying every route the platform offers.
 *
 * Android hands the browser a File backed by a content provider, and those
 * reads fail in ways a desktop never sees: a whole-file read may be refused
 * while slice-by-slice reads succeed, and some failures are transient. So work
 * through the options rather than giving up on the first refusal, and keep what
 * each one said — the DOMException name (NotReadableError, NotFoundError,
 * SecurityError) is the difference between advice and a guess.
 */
export async function readFileBytes(file, options = {}) {
  const { onProgress = () => {}, retryDelayMs = 250 } = options;
  const size = file?.size || 0;
  const attempts = [];

  const joined = (chunks, length) => {
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  };

  // 1. One shot: fastest, and the only route that needs a single allocation.
  const whole = async () => {
    const buf = await file.arrayBuffer();
    onProgress(buf.byteLength, size);
    return new Uint8Array(buf);
  };

  // 2. Streamed: gives progress, and survives some refusals the one-shot hits.
  const streamed = async () => {
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
    return joined(chunks, received);
  };

  // 3. Sliced: each slice re-opens the underlying content, which is what makes
  //    this work on providers that refuse to serve the whole file at once.
  const sliced = async () => {
    const chunks = [];
    let received = 0;
    for (let start = 0; start < size; start += SLICE) {
      const buf = await file.slice(start, Math.min(start + SLICE, size)).arrayBuffer();
      chunks.push(new Uint8Array(buf));
      received += buf.byteLength;
      onProgress(received, size);
    }
    if (received === 0 && size > 0) throw new Error('read nothing');
    return joined(chunks, received);
  };

  // 4. The legacy API, kept only for anything old enough to need it.
  const legacy = () =>
    new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(new Uint8Array(fr.result));
      fr.onerror = () => reject(fr.error || new Error('FileReader failed'));
      fr.readAsArrayBuffer(file);
    });

  const routes = [
    ['whole file', whole, typeof file?.arrayBuffer === 'function'],
    ['streaming', streamed, typeof file?.stream === 'function'],
    ['in slices', sliced, typeof file?.slice === 'function' && typeof file?.arrayBuffer === 'function'],
    // Some provider-backed reads fail once and then succeed, so give the most
    // reliable route a second go before falling back to the oldest API.
    ['whole file again', whole, typeof file?.arrayBuffer === 'function'],
    ['FileReader', legacy, typeof FileReader === 'function'],
  ];

  for (const [label, run, usable] of routes) {
    if (!usable) continue;
    if (label.endsWith('again') && retryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
    try {
      return await run();
    } catch (err) {
      attempts.push(`${label} — ${describe(err)}`);
    }
  }

  const reason = attempts[0] ? attempts[0].replace(/^[^—]*— /, '') : 'no reason given';
  const err = new Error(
    `This device would not let the app read "${file?.name || 'that file'}" (${reason}). ` +
      'Try copying it to a different folder with the Files app and picking the copy, ' +
      'or if it came from Google Photos or Drive, download it to the device first.',
  );
  err.attempts = attempts;
  throw err;
}
