/**
 * Pure builders that turn UI settings into ffmpeg argument arrays.
 *
 * Nothing in here touches the DOM or ffmpeg.wasm, so every command the app can
 * possibly run is covered by the unit tests in tests/ops.test.js.
 */

/** Round down to an even number (H.264 + yuv420p need even dimensions). */
export function even(n) {
  return Math.max(2, Math.floor(n / 2) * 2);
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Seconds -> the `HH:MM:SS.mmm` form ffmpeg is happiest with. */
export function timecode(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s - h * 3600 - m * 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`;
}

/** `1:23.4` / `83.4` / `01:02:03` -> seconds. Returns null when unparseable. */
export function parseTimecode(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  const t = String(text ?? '').trim();
  if (!t) return null;
  const parts = t.split(':');
  if (parts.length > 3 || parts.some((p) => p !== '' && Number.isNaN(Number(p)))) return null;
  let total = 0;
  for (const p of parts) total = total * 60 + (p === '' ? 0 : Number(p));
  return Number.isFinite(total) ? total : null;
}

export const QUALITY = {
  fast: { crf: 26, preset: 'ultrafast', label: 'Fast' },
  balanced: { crf: 23, preset: 'veryfast', label: 'Balanced' },
  best: { crf: 20, preset: 'medium', label: 'Best' },
};

export const ASPECTS = {
  source: { label: 'Same as crop', ratio: null },
  '9:16': { label: '9:16 vertical (TikTok / Reels)', ratio: 9 / 16 },
  '1:1': { label: '1:1 square', ratio: 1 },
  '4:5': { label: '4:5 portrait', ratio: 4 / 5 },
  '16:9': { label: '16:9 landscape', ratio: 16 / 9 },
  '4:3': { label: '4:3 classic', ratio: 4 / 3 },
};

/**
 * Output size presets, measured on the *short* edge — the same thing "1080p"
 * means for both 1920x1080 and 1080x1920. `0` keeps the source scale.
 */
export const SIZES = { source: 0, '480': 480, '720': 720, '1080': 1080, '1440': 1440 };

/**
 * Capabilities of the loaded ffmpeg core. Filled in at runtime by probing the
 * binary; these defaults match the stock @ffmpeg/core build.
 */
export const DEFAULT_CAPS = {
  encoders: new Set(['libx264', 'aac', 'libmp3lame', 'libopus', 'libvorbis']),
  filters: new Set(['scale', 'crop', 'overlay', 'boxblur', 'transpose', 'hflip', 'vflip', 'split', 'setsar', 'amix', 'volume', 'eq']),
};

const has = (set, name) => !set || set.size === 0 || set.has(name);

/** Pick an audio encoder that the container will actually accept. */
export function audioEncoder(container, caps = DEFAULT_CAPS) {
  const enc = caps.encoders;
  if (container === 'webm') {
    if (has(enc, 'libopus')) return 'libopus';
    if (has(enc, 'libvorbis')) return 'libvorbis';
  }
  if (has(enc, 'aac')) return 'aac';
  if (has(enc, 'libmp3lame')) return 'libmp3lame';
  return 'aac';
}

/** Audio that is already MP4-legal can be stream-copied instead of re-encoded. */
export function canCopyAudio(sourceCodec, container) {
  if (!sourceCodec) return false;
  const c = String(sourceCodec).toLowerCase();
  if (container === 'mp4' || container === 'mov' || container === 'm4v') {
    return c === 'aac' || c === 'mp3' || c === 'alac';
  }
  if (container === 'webm') return c === 'opus' || c === 'vorbis';
  return false;
}

export function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function baseOf(name) {
  return (name || 'video').replace(/\.[A-Za-z0-9]+$/, '').replace(/[^\w.\- ]+/g, '_').slice(0, 60) || 'video';
}

/** Containers we are willing to stream-copy back into. Everything else -> mp4. */
export function safeContainer(ext) {
  return ['mp4', 'mov', 'mkv', 'webm', 'm4v'].includes(ext) ? ext : 'mp4';
}

function x264(quality) {
  const q = QUALITY[quality] || QUALITY.balanced;
  return ['-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf), '-pix_fmt', 'yuv420p'];
}

function faststart(container) {
  return container === 'mp4' || container === 'mov' || container === 'm4v' ? ['-movflags', '+faststart'] : [];
}

/* ------------------------------------------------------------------ *
 * 1. Extract the audio to an MP3
 * ------------------------------------------------------------------ */

/**
 * @param {{input:string, base:string, start?:number, duration?:number,
 *          bitrate?:string, format?:'mp3'|'m4a'|'wav', caps?:object}} o
 */
export function buildExtractAudio(o) {
  const caps = o.caps || DEFAULT_CAPS;
  const format = o.format || 'mp3';
  const args = [];
  if (o.start > 0) args.push('-ss', timecode(o.start));
  args.push('-i', o.input);
  if (o.duration > 0) args.push('-t', timecode(o.duration));
  args.push('-vn', '-map', '0:a:0');

  if (format === 'wav') {
    args.push('-c:a', 'pcm_s16le');
  } else if (format === 'm4a' || !has(caps.encoders, 'libmp3lame')) {
    args.push('-c:a', audioEncoder('mp4', caps), '-b:a', o.bitrate || '192k');
  } else {
    args.push('-c:a', 'libmp3lame', '-b:a', o.bitrate || '192k');
  }
  const ext = format === 'wav' ? 'wav' : format === 'm4a' || !has(caps.encoders, 'libmp3lame') ? 'm4a' : 'mp3';
  const output = `${o.base}-audio.${ext}`;
  args.push(output);
  return { args, output };
}

/* ------------------------------------------------------------------ *
 * 2. Strip the audio, keep the video untouched
 * ------------------------------------------------------------------ */

/** Pure stream copy: no re-encode, no quality loss, near-instant. */
export function buildStripAudio(o) {
  const container = safeContainer(extOf(o.input));
  const output = `${o.base}-muted.${container}`;
  const args = ['-i', o.input, '-map', '0:v', '-an', '-c', 'copy', ...faststart(container), output];
  return { args, output };
}

/* ------------------------------------------------------------------ *
 * 3. Clip a section out as its own file
 * ------------------------------------------------------------------ */

/**
 * @param {{input:string, base:string, start:number, duration:number,
 *          reencode?:boolean, quality?:string, audioCodec?:string, caps?:object}} o
 */
export function buildClip(o) {
  const caps = o.caps || DEFAULT_CAPS;
  const srcExt = extOf(o.input);
  const container = o.reencode ? 'mp4' : safeContainer(srcExt);
  const output = `${o.base}-clip.${container}`;
  // Input-side -ss seeks fast and is still frame-accurate when we re-encode.
  const args = ['-ss', timecode(o.start), '-i', o.input, '-t', timecode(o.duration)];

  if (o.reencode) {
    args.push(...x264(o.quality));
    args.push('-c:a', audioEncoder(container, caps), '-b:a', '192k');
  } else {
    // Copy mode snaps the start to the nearest keyframe at or before `start`.
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
  }
  args.push(...faststart(container), output);
  return { args, output };
}

/* ------------------------------------------------------------------ *
 * 4. Add / replace an audio track, trimmed to fit
 * ------------------------------------------------------------------ */

/**
 * @param {{video:string, audio:string, base:string, mode?:'replace'|'mix',
 *          audioStart?:number, audioVolume?:number, originalVolume?:number,
 *          loop?:boolean, fadeIn?:number, fadeOut?:number, videoDuration?:number,
 *          sourceHasAudio?:boolean, caps?:object}} o
 */
export function buildAddAudio(o) {
  const caps = o.caps || DEFAULT_CAPS;
  const container = 'mp4';
  const output = `${o.base}-newaudio.${container}`;
  const mix = o.mode === 'mix' && o.sourceHasAudio;
  const aVol = o.audioVolume ?? 1;
  const oVol = o.originalVolume ?? 1;
  const fadeIn = o.fadeIn || 0;
  const fadeOut = o.fadeOut || 0;
  const dur = o.videoDuration || 0;

  const args = ['-i', o.video];
  if (o.loop) args.push('-stream_loop', '-1');
  if (o.audioStart > 0) args.push('-ss', timecode(o.audioStart));
  args.push('-i', o.audio);

  // The added track's own chain: level, then optional fades.
  const addChain = [`volume=${aVol.toFixed(3)}`];
  if (fadeIn > 0) addChain.push(`afade=t=in:st=0:d=${fadeIn.toFixed(2)}`);
  if (fadeOut > 0 && dur > 0) addChain.push(`afade=t=out:st=${Math.max(0, dur - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)}`);

  if (mix) {
    const graph =
      `[1:a]${addChain.join(',')}[add];` +
      `[0:a]volume=${oVol.toFixed(3)}[orig];` +
      `[orig][add]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`;
    args.push('-filter_complex', graph, '-map', '0:v:0', '-map', '[aout]');
  } else {
    args.push('-filter:a', addChain.join(','), '-map', '0:v:0', '-map', '1:a:0');
  }

  args.push('-c:v', 'copy', '-c:a', audioEncoder(container, caps), '-b:a', '192k');
  // Always end when the video ends, whether the track is short or looping.
  args.push('-shortest', ...faststart(container), output);
  return { args, output };
}

/* ------------------------------------------------------------------ *
 * 5. Crop / rotate / flip, with trim-away or blurred-fill framing
 * ------------------------------------------------------------------ */

/**
 * Work out the pixel size of the finished frame.
 *
 * `aspect` is the aspect of the *output*. In trim mode the crop box is already
 * locked to it, so this just cleans up rounding; in blur mode the canvas is
 * grown to it and the blurred copy fills whatever the crop does not cover.
 *
 * @param {{cropW:number, cropH:number, aspect:string, fill:'trim'|'blur', shortEdge?:number}} o
 */
export function targetSize(o) {
  const cropW = Math.max(2, o.cropW);
  const cropH = Math.max(2, o.cropH);
  const ratio = ASPECTS[o.aspect]?.ratio ?? null;

  let w = cropW;
  let h = cropH;

  if (ratio) {
    if (o.fill === 'blur') {
      // Grow the canvas outwards until it hits the ratio: never crops content.
      if (ratio >= cropW / cropH) h = cropH, (w = cropH * ratio);
      else w = cropW, (h = cropW / ratio);
    } else {
      // Trim mode: the box was ratio-locked, so snap off any rounding drift.
      h = cropW / ratio;
    }
  }

  const short = Math.min(w, h);
  const target = o.shortEdge || 0;
  if (target > 0 && short > 0) {
    const k = target / short;
    w *= k;
    h *= k;
  }
  return { width: even(Math.round(w)), height: even(Math.round(h)) };
}

/**
 * @param {{input:string, base:string, rotate?:0|90|180|270, flipH?:boolean,
 *          crop?:{x:number,y:number,w:number,h:number}|null,
 *          fill?:'trim'|'blur', aspect?:string, shortEdge?:number,
 *          blurAmount?:number, bgZoom?:number, bgDim?:number,
 *          quality?:string, sourceWidth:number, sourceHeight:number,
 *          start?:number, duration?:number,
 *          hasAudio?:boolean, audioCodec?:string, caps?:object}} o
 */
export function buildFrame(o) {
  const caps = o.caps || DEFAULT_CAPS;
  const container = 'mp4';
  // Blur fill only means anything when there is empty space to fill.
  const fill = o.fill === 'blur' && ASPECTS[o.aspect || 'source']?.ratio ? 'blur' : 'trim';
  const output = `${o.base}-${fill === 'blur' ? 'framed' : 'cropped'}.${container}`;
  const rotate = ((o.rotate || 0) % 360 + 360) % 360;

  // Dimensions of the frame *after* rotation — the space the crop box lives in.
  const rotW = rotate === 90 || rotate === 270 ? o.sourceHeight : o.sourceWidth;
  const rotH = rotate === 90 || rotate === 270 ? o.sourceWidth : o.sourceHeight;

  const pre = [];
  if (rotate === 90) pre.push('transpose=1');
  else if (rotate === 270) pre.push('transpose=2');
  else if (rotate === 180) pre.push('transpose=1', 'transpose=1');
  if (o.flipH) pre.push('hflip');

  let cropW = rotW;
  let cropH = rotH;
  if (o.crop) {
    cropW = even(clamp(Math.round(o.crop.w), 2, rotW));
    cropH = even(clamp(Math.round(o.crop.h), 2, rotH));
    const x = clamp(Math.round(o.crop.x), 0, rotW - cropW);
    const y = clamp(Math.round(o.crop.y), 0, rotH - cropH);
    pre.push(`crop=${cropW}:${cropH}:${x}:${y}`);
  }

  const { width: W, height: H } = targetSize({
    cropW,
    cropH,
    aspect: o.aspect || 'source',
    fill,
    shortEdge: o.shortEdge || 0,
  });

  // Re-encoding anyway, so trimming in the same pass is both faster and exact.
  const args = [];
  if (o.start > 0) args.push('-ss', timecode(o.start));
  args.push('-i', o.input);
  if (o.duration > 0) args.push('-t', timecode(o.duration));

  if (fill === 'blur') {
    // Blur a cheap downscaled copy, then blow it back up: far faster than
    // blurring at full resolution and the result is smoother.
    const zoom = clamp(o.bgZoom ?? 1.15, 1, 2.5);
    const bw = even(Math.round((W / 6) * 1));
    const bh = even(Math.round((H / 6) * 1));
    const radius = clamp(Math.round((Math.min(bw, bh) * (o.blurAmount ?? 14)) / 100), 1, Math.floor(Math.min(bw, bh) / 2) - 1 || 1);
    const zw = even(Math.round(bw * zoom));
    const zh = even(Math.round(bh * zoom));

    const bg =
      `[bg]scale=${zw}:${zh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},` +
      `boxblur=${radius}:2,scale=${W}:${H}`;
    const dim = o.bgDim > 0 && has(caps.filters, 'eq') ? `,eq=brightness=${(-Math.abs(o.bgDim)).toFixed(2)}` : '';

    const graph =
      `[0:v]${[...pre, 'split=2'].join(',')}[fg][bg];` +
      `${bg}${dim}[bgb];` +
      `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgs];` +
      `[bgb][fgs]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2,setsar=1[v]`;
    args.push('-filter_complex', graph, '-map', '[v]');
  } else {
    const vf = [...pre, `scale=${W}:${H}:flags=bicubic`, 'setsar=1'];
    args.push('-vf', vf.join(','), '-map', '0:v:0');
  }

  if (o.hasAudio) {
    args.push('-map', '0:a?');
    args.push('-c:a', canCopyAudio(o.audioCodec, container) ? 'copy' : audioEncoder(container, caps));
  } else {
    args.push('-an');
  }

  args.push(...x264(o.quality), ...faststart(container), output);
  return { args, output, width: W, height: H, cropW, cropH };
}

/* ------------------------------------------------------------------ *
 * Probing: parse ffmpeg's own stderr banner for stream info
 * ------------------------------------------------------------------ */

/**
 * Read duration / dimensions / codecs out of the log ffmpeg prints for an input.
 * @param {string} log
 */
export function parseProbe(log) {
  const out = { duration: 0, width: 0, height: 0, fps: 0, videoCodec: '', audioCodec: '', hasVideo: false, hasAudio: false, rotation: 0 };

  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  if (dur) out.duration = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);

  const v = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*Video:\s*([A-Za-z0-9_]+)[^\n]*?(\d{2,5})x(\d{2,5})/.exec(log);
  if (v) {
    out.hasVideo = true;
    out.videoCodec = v[1].toLowerCase();
    out.width = Number(v[2]);
    out.height = Number(v[3]);
    const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(log.slice(v.index));
    if (fps) out.fps = Number(fps[1]);
  }

  const a = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*Audio:\s*([A-Za-z0-9_]+)/.exec(log);
  if (a) {
    out.hasAudio = true;
    out.audioCodec = a[1].toLowerCase();
  }

  const rot = /rotate\s*:\s*(-?\d+)/.exec(log) || /displaymatrix:\s*rotation of (-?\d+(?:\.\d+)?) degrees/.exec(log);
  if (rot) out.rotation = ((Math.round(Number(rot[1])) % 360) + 360) % 360;

  return out;
}

/** Turn `-encoders` / `-filters` output into lookup sets. */
export function parseCaps(encodersLog, filtersLog) {
  const encoders = new Set();
  for (const line of String(encodersLog || '').split('\n')) {
    const m = /^\s*[VAS][.F][.S][.X][.B][.D]\s+([A-Za-z0-9_]+)/.exec(line);
    if (m) encoders.add(m[1]);
  }
  const filters = new Set();
  for (const line of String(filtersLog || '').split('\n')) {
    // e.g. " ... boxblur           V->V       Blur the input."
    const m = /^\s*[.TSC]{3}\s+([A-Za-z0-9_]+)\s+\S*->\S*\s/.exec(line);
    if (m) filters.add(m[1]);
  }
  return { encoders, filters };
}
