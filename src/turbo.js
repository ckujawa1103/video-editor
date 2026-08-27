/**
 * The hardware path.
 *
 * The WebAssembly encoder is the slow part of every render — an x264 encode
 * costs roughly the clip's own length, while decoding costs a fraction of it.
 * Phones have a dedicated video encoder sitting idle the whole time, and
 * WebCodecs is how a page reaches it. This module runs the same crop / rotate /
 * blurred-fill transform through hardware decode, a canvas, and hardware
 * encode, which turns the encode from the dominant cost into a rounding error.
 *
 * It handles video only. The finished track is handed back for ffmpeg to mux
 * the original audio into, because that is a stream copy costing a fraction of
 * a second and it reuses a path that is already proven.
 *
 * Everything here is best-effort: any device that cannot do it throws
 * `TurboUnavailable`, and the caller falls back to the WebAssembly encoder.
 */
import {
  ALL_FORMATS, BlobSource, BufferTarget, CanvasSource, Input, Mp4OutputFormat,
  Output, VideoSampleSink, canEncodeVideo,
} from 'mediabunny';
import { blurPixels, videoBitrate } from './ops.js';

export class TurboUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'TurboUnavailable';
  }
}

/** Does this browser have the pieces at all? Cheap enough to call on load. */
export function turboPossible() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

/**
 * Can this device encode H.264 at this size? Answered by the browser, which
 * knows what its hardware supports; a desktop Chromium built without
 * proprietary codecs says no here and the app falls back.
 */
export async function turboSupported(width, height, codec = 'avc') {
  if (!turboPossible()) return false;
  try {
    return await canEncodeVideo(codec, { width, height });
  } catch {
    return false;
  }
}

/**
 * Draw one decoded frame through the crop / rotate / fill transform.
 *
 * Two steps on purpose. The sample is drawn into a canvas the size of the
 * user's rotation of the frame, so the crop rectangle can be applied in the
 * same coordinates the crop box uses on screen; then that rectangle is composed
 * onto the output canvas. `sample.draw` applies the file's own rotation
 * metadata, so a video recorded sideways arrives upright.
 */
function drawFrame(sample, scratch, scratchCtx, ctx, s) {
  const { displayW, displayH, rotate, flipH, crop, width: W, height: H, fill } = s;

  scratchCtx.save();
  scratchCtx.translate(scratch.width / 2, scratch.height / 2);
  if (rotate) scratchCtx.rotate((rotate * Math.PI) / 180);
  if (flipH) scratchCtx.scale(-1, 1);
  sample.draw(scratchCtx, -displayW / 2, -displayH / 2, displayW, displayH);
  scratchCtx.restore();

  const sx = crop.x;
  const sy = crop.y;
  const sw = crop.w;
  const sh = crop.h;

  if (fill === 'blur') {
    const cover = Math.max(W / sw, H / sh) * (s.bgZoom ?? 1.15);
    const bw = sw * cover;
    const bh = sh * cover;
    ctx.save();
    ctx.filter = `blur(${blurPixels(Math.min(W, H), s.blurAmount).toFixed(1)}px)`;
    ctx.drawImage(scratch, sx, sy, sw, sh, (W - bw) / 2, (H - bh) / 2, bw, bh);
    ctx.restore();
    if (s.bgDim > 0) {
      ctx.fillStyle = `rgba(0,0,0,${Math.min(0.6, s.bgDim * 2).toFixed(2)})`;
      ctx.fillRect(0, 0, W, H);
    }
    const contain = Math.min(W / sw, H / sh);
    const fw = sw * contain;
    const fh = sh * contain;
    ctx.drawImage(scratch, sx, sy, sw, sh, (W - fw) / 2, (H - fh) / 2, fw, fh);
  } else {
    ctx.drawImage(scratch, sx, sy, sw, sh, 0, 0, W, H);
  }
}

/**
 * Render the video track of `file` through the transform, in hardware.
 *
 * @param {{file: Blob, settings: object, onProgress?: Function, shouldStop?: Function}} o
 * @returns {Promise<{blob: Blob, frames: number, width: number, height: number}>}
 */
export async function renderTurbo({ file, settings, onProgress = () => {}, shouldStop = () => false }) {
  if (!turboPossible()) throw new TurboUnavailable('This browser has no WebCodecs support.');

  const s = settings;
  const W = s.width;
  const H = s.height;
  // H.264 everywhere real; the override exists so the pipeline can be exercised
  // on a desktop Chromium built without proprietary codecs.
  const codec = s.codec || 'avc';
  if (!(await turboSupported(W, H, codec))) {
    throw new TurboUnavailable(`This device cannot encode ${codec} at ${W}x${H}.`);
  }

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let output;
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new TurboUnavailable('That file has no video track.');
    if (!(await videoTrack.canDecode())) throw new TurboUnavailable('This device cannot decode that video.');

    const fps = (await videoTrack.computePacketStats(100).catch(() => null))?.averagePacketRate || 30;

    const rotW = s.rotate === 90 || s.rotate === 270 ? s.displayH : s.displayW;
    const rotH = s.rotate === 90 || s.rotate === 270 ? s.displayW : s.displayH;
    const scratch = new OffscreenCanvas(Math.max(2, Math.round(rotW)), Math.max(2, Math.round(rotH)));
    const scratchCtx = scratch.getContext('2d', { alpha: false });

    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false });

    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const source = new CanvasSource(canvas, {
      codec,
      bitrate: videoBitrate(W, H, fps, s.quality),
      // Full quality mode; the encoder is not the bottleneck any more.
      latencyMode: 'quality',
    });
    output.addVideoTrack(source);
    await output.start();

    const start = s.start || 0;
    const end = s.duration > 0 ? start + s.duration : undefined;
    const expected = Math.max(1, Math.round(((end ?? (await videoTrack.computeDuration())) - start) * fps));

    const sink = new VideoSampleSink(videoTrack);
    let frames = 0;
    let lastTimestamp = 0;

    for await (const sample of sink.samples(start, end)) {
      if (shouldStop()) {
        sample.close();
        throw new TurboUnavailable('Cancelled.');
      }
      try {
        drawFrame(sample, scratch, scratchCtx, ctx, {
          ...s, width: W, height: H,
          displayW: s.displayW, displayH: s.displayH,
        });
        const timestamp = Math.max(0, sample.timestamp - start);
        // A frame with no duration would collapse the timeline; fall back to
        // the frame rate we measured.
        const duration = sample.duration > 0 ? sample.duration : 1 / fps;
        await source.add(timestamp, duration);
        lastTimestamp = timestamp + duration;
        frames += 1;
        if (frames % 5 === 0) onProgress(Math.min(0.99, frames / expected), frames);
      } finally {
        sample.close();
      }
    }

    if (frames === 0) throw new TurboUnavailable('No frames were decoded.');

    await output.finalize();
    onProgress(1, frames);
    return {
      blob: new Blob([output.target.buffer], { type: 'video/mp4' }),
      frames,
      duration: lastTimestamp,
      width: W,
      height: H,
    };
  } catch (err) {
    try {
      await output?.cancel();
    } catch {
      /* already torn down */
    }
    if (err instanceof TurboUnavailable) throw err;
    throw new TurboUnavailable(err?.message || String(err));
  } finally {
    try {
      await input.dispose?.();
    } catch {
      /* nothing worth reporting from teardown */
    }
  }
}
