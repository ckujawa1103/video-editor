/**
 * Thin wrapper around ffmpeg.wasm: loads the core, keeps one instance alive
 * across jobs, and exposes probe/run helpers.
 *
 * Single-threaded on purpose. @ffmpeg/core-mt would be faster, but every
 * published build of it (0.12.6 / 0.12.9 / 0.12.10) aborts with "null function
 * or function signature mismatch" as soon as one job both decodes H.264 and
 * encodes it again — which covers cropping, rotating and blurred fill.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { downloadWithProgress, bytesToBlobUrl, readFileBytes } from './download.js';
import { parseProbe, parseCaps, DEFAULT_CAPS } from './ops.js';

const CORE = 'ffmpeg/core';

// Baked in at build time from the vendored file, so the progress bar stays
// accurate even when the server gzips the response.
const EXPECTED_WASM_BYTES = typeof __FFMPEG_WASM_BYTES__ === 'number' ? __FFMPEG_WASM_BYTES__ : 0;

function coreUrl(dir, file) {
  // import.meta.env.BASE_URL keeps this working when hosted in a subdirectory.
  const base = import.meta.env?.BASE_URL || '/';
  return new URL(`${dir}/${file}`, new URL(base, location.href)).href;
}

export class Runner {
  constructor() {
    this.ff = null;
    this.loading = null;
    this.dead = false;
    // Bumped every time a fresh core is loaded, so callers know the virtual
    // filesystem has been wiped and anything staged in it must be re-written.
    this.generation = 0;
    this.caps = DEFAULT_CAPS;
    this.log = [];
    this.onLog = () => {};
    this.onProgress = () => {};
    this.onDownload = () => {};
    this.capturing = null;
    this.running = false;
  }

  async load(onStatus = () => {}) {
    // A crashed WebAssembly module never recovers; throw it away and start over.
    if (this.dead) this.terminate();
    if (this.ff) return this.ff;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const ff = new FFmpeg();
      ff.on('log', ({ message }) => {
        if (this.capturing) this.capturing.push(message);
        this.log.push(message);
        if (this.log.length > 4000) this.log.splice(0, 2000);
        this.onLog(message);
      });
      ff.on('progress', ({ progress, time }) => this.onProgress(progress, time));

      // Fetch the core ourselves rather than handing ff.load() the URLs, so
      // the 32 MB download can report progress instead of looking frozen.
      onStatus('Loading the video engine…');
      const coreURL = await toBlobURL(coreUrl(CORE, 'ffmpeg-core.js'), 'text/javascript');
      const wasmBytes = await downloadWithProgress(coreUrl(CORE, 'ffmpeg-core.wasm'), {
        expectedBytes: EXPECTED_WASM_BYTES,
        onProgress: (received, total) => this.onDownload(received, total),
      });
      const wasmURL = bytesToBlobUrl(wasmBytes, 'application/wasm');
      onStatus('Starting the video engine…');
      await ff.load({ coreURL, wasmURL });

      this.ff = ff;
      this.dead = false;
      this.generation += 1;
      onStatus('Detecting engine features…');
      await this.detectCaps();
      return ff;
    })();

    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /** Ask the core which encoders and filters it actually shipped with. */
  async detectCaps() {
    try {
      const encoders = await this.capture(['-hide_banner', '-encoders']);
      const filters = await this.capture(['-hide_banner', '-filters']);
      const caps = parseCaps(encoders, filters);
      if (caps.encoders.size > 0) this.caps = caps;
    } catch {
      this.caps = DEFAULT_CAPS;
    }
  }

  /** Run ffmpeg purely for its log output. */
  async capture(args) {
    const buf = [];
    this.capturing = buf;
    try {
      await this.ff.exec(args);
    } catch {
      /* informational commands exit non-zero; the log is what we want */
    } finally {
      this.capturing = null;
    }
    return buf.join('\n');
  }

  async writeFile(name, source, onProgress) {
    let data;
    if (source instanceof Uint8Array) data = source;
    else if (typeof Blob !== 'undefined' && source instanceof Blob) data = await readFileBytes(source, { onProgress });
    else data = await fetchFile(source);
    await this.ff.writeFile(name, data);
    return name;
  }

  async readFile(name) {
    return this.ff.readFile(name);
  }

  async remove(...names) {
    for (const n of names) {
      try {
        await this.ff.deleteFile(n);
      } catch {
        /* already gone */
      }
    }
  }

  /** Read duration / size / codecs straight from ffmpeg rather than trusting the DOM. */
  async probe(name) {
    const log = await this.capture(['-hide_banner', '-i', name]);
    return parseProbe(log);
  }

  /**
   * Execute a job. Returns the log so failures can be explained properly.
   * @param {string[]} args
   */
  async exec(args) {
    if (this.running) throw new Error('A job is already running.');
    this.running = true;
    const buf = [];
    this.capturing = buf;
    try {
      const code = await this.ff.exec(args);
      const log = buf.join('\n');
      if (code !== 0) throw new FfmpegError(`ffmpeg exited with code ${code}`, log, args);
      return log;
    } catch (err) {
      if (err instanceof FfmpegError) throw err;
      // Anything that escapes as a raw throw came out of the WebAssembly module
      // itself, which leaves it unusable — retire the instance.
      this.dead = true;
      throw new FfmpegError(err?.message || 'The video engine crashed.', buf.join('\n'), args);
    } finally {
      this.capturing = null;
      this.running = false;
    }
  }

  terminate() {
    try {
      this.ff?.terminate();
    } catch {
      /* ignore */
    }
    this.ff = null;
    this.loading = null;
    this.running = false;
    this.dead = false;
  }
}

export class FfmpegError extends Error {
  constructor(message, log, args) {
    super(message);
    this.name = 'FfmpegError';
    this.log = log || '';
    this.args = args || [];
  }

  /** Turn ffmpeg's wall of text into one line a human can act on. */
  get friendly() {
    const l = this.log;
    if (/Stream map .* matches no streams|Output file .* does not contain any stream/i.test(l)) {
      return 'That file does not have the stream this tool needs (for example, no audio track).';
    }
    if (/Invalid data found when processing input|moov atom not found/i.test(l)) {
      return 'The file could not be read — it may be corrupt or in a format this engine does not support.';
    }
    if (/No such filter|Unknown filter/i.test(l)) {
      return 'This build of the video engine is missing a filter this option needs.';
    }
    if (/Unknown encoder|Encoder .* not found/i.test(l)) {
      return 'This build of the video engine is missing the encoder this option needs.';
    }
    if (/Out of memory|memory access out of bounds|Aborted|RuntimeError|table index is out of bounds/i.test(`${l} ${this.message}`)) {
      return 'The video engine ran out of memory. Try a shorter clip, a smaller output size, or the Fast quality preset.';
    }
    if (/engine crashed/i.test(this.message)) {
      return 'The video engine stopped unexpectedly. It has been restarted — try a shorter clip or a smaller output size.';
    }
    if (/codec .* not currently supported in container|Could not write header/i.test(l)) {
      return 'That combination of codec and file type is not allowed. Try turning off "no re-encode".';
    }
    return this.message;
  }
}
