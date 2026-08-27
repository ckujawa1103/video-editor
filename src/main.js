import { Runner, FfmpegError } from './ffmpeg-runner.js';
import { createFramer } from './framer.js';
import {
  ASPECTS, SIZES, buildAddAudio, buildClip, buildExtractAudio, buildFrame,
  buildStripAudio, baseOf, extOf, parseTimecode, timecode, clamp,
} from './ops.js';

const $ = (id) => document.getElementById(id);

const runner = new Runner();

const app = {
  file: null,          // the source File
  base: 'video',       // sanitised name stem used for outputs
  fsName: null,        // name of the source inside ffmpeg's virtual filesystem
  fsGeneration: -1,    // which engine instance that staged copy belongs to
  info: null,          // merged DOM + ffmpeg probe metadata
  sel: { start: 0, end: 0 },
  audioFile: null,
  audioInfo: null,
  result: null,        // { url, blob, name, kind }
  busy: false,
};

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 7000 : 3500);
}

function fmtTime(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

/* ------------------------------------------------------------------ *
 * engine
 * ------------------------------------------------------------------ */

/**
 * Load the engine, restarting it if a previous job left it in a bad state. The
 * Runner does its own caching, so calling this before every job is cheap.
 */
async function ensureEngine() {
  await runner.load(setStatus);
  if (app.fsGeneration !== runner.generation) app.fsName = null;
  return runner;
}

runner.onLog = (line) => {
  const box = $('jobLog');
  box.textContent = `${box.textContent}${line}\n`.slice(-12000);
  box.scrollTop = box.scrollHeight;
};

runner.onProgress = (ratio) => {
  if (!app.busy) return;
  const pct = clamp((ratio || 0) * 100, 0, 100);
  if (pct > 0.5) {
    $('jobBar').classList.remove('indeterminate');
    $('jobBar').style.width = `${pct.toFixed(1)}%`;
  }
};

function setStatus(text) {
  $('jobStatus').textContent = text;
}

/**
 * Status for the source card: engine download, probing, and anything that goes
 * wrong on the way. Without this the app looks frozen while 32 MB downloads.
 */
function setSourceStatus(text, { progress = null, problem = false, retry = false } = {}) {
  const box = $('sourceStatus');
  box.hidden = !text;
  box.classList.toggle('problem', problem);
  $('sourceStatusText').textContent = text || '';
  $('retryProbe').hidden = !retry;
  const bar = $('sourceStatusBar');
  if (progress == null) {
    bar.classList.add('indeterminate');
    bar.style.width = '';
  } else {
    bar.classList.remove('indeterminate');
    bar.style.width = `${clamp(progress * 100, 0, 100).toFixed(0)}%`;
  }
}

/** Nothing can be exported until we know how long the video is. */
function setToolsReady(ready) {
  for (const b of document.querySelectorAll('.panel .primary')) b.disabled = !ready;
  if (ready) reflectAudioAvailability();
}

runner.onDownload = (received, total) => {
  const mb = (n) => (n / 1e6).toFixed(0);
  setSourceStatus(
    total
      ? `Downloading the video engine — ${mb(received)} of ${mb(total)} MB. This happens once, then it is cached.`
      : `Downloading the video engine — ${mb(received)} MB…`,
    { progress: total ? received / total : null },
  );
};

/* ------------------------------------------------------------------ *
 * source loading
 * ------------------------------------------------------------------ */

const previewEl = $('preview');

let previewFailed = false;

async function loadSource(file) {
  if (!file) return;
  previewFailed = false;
  releaseResult();
  app.file = file;
  app.base = baseOf(file.name);
  app.fsName = null;
  app.info = null;

  if (previewEl.src) URL.revokeObjectURL(previewEl.src);
  previewEl.src = URL.createObjectURL(file);
  previewEl.load();

  $('sourceBody').hidden = false;
  $('dropzone').hidden = true;
  $('tabs').hidden = false;
  $('stage').classList.add('pending');
  setToolsReady(false);
  setSourceStatus('Reading the video…');
  showTab(document.querySelector('.tab.active')?.dataset.tab || 'clip');

  if (file.size > 250 * 1024 * 1024) {
    toast('That file is large. The engine works in memory, so clip a shorter section first if a job fails.', true);
  }

  const dom = await new Promise((resolve) => {
    const done = () => resolve({
      duration: Number.isFinite(previewEl.duration) ? previewEl.duration : 0,
      width: previewEl.videoWidth || 0,
      height: previewEl.videoHeight || 0,
    });
    previewEl.addEventListener('loadedmetadata', done, { once: true });
    previewEl.addEventListener('error', () => {
      previewFailed = true;
      resolve({ duration: 0, width: 0, height: 0 });
    }, { once: true });
    // A browser that cannot handle the codec often just stalls rather than
    // raising an error, so treat "still nothing after 6s" as a failure too.
    setTimeout(() => {
      if (previewEl.readyState < 1) previewFailed = true;
      done();
    }, 6000);
  });

  app.info = { ...dom, hasAudio: true, audioCodec: '', videoCodec: '', fps: 0, probed: false };
  app.sel = { start: 0, end: dom.duration || 0 };
  syncSelectionInputs();
  refreshMeta();
  if (dom.width) {
    $('stage').classList.remove('pending');
    framer.setSource(dom.width, dom.height);
  }

  // The browser only tells us so much; ask ffmpeg for the rest in the background.
  probeInBackground();
}

async function probeInBackground() {
  const file = app.file;
  try {
    setSourceStatus('Starting the video engine…');
    await ensureEngine();
    if (app.file !== file) return;
    setSourceStatus('Reading the video details…');
    const name = await stageSource();
    if (app.file !== file) return;
    const p = await runner.probe(name);
    if (app.file !== file) return;

    // ffmpeg reports coded dimensions; rotation metadata decides how it displays.
    const swap = p.rotation === 90 || p.rotation === 270;
    const dispW = swap ? p.height : p.width;
    const dispH = swap ? p.width : p.height;

    const before = app.info || {};
    app.info = {
      ...before,
      duration: p.duration || before.duration || 0,
      width: before.width || dispW,
      height: before.height || dispH,
      hasAudio: p.hasAudio,
      audioCodec: p.audioCodec,
      videoCodec: p.videoCodec,
      fps: p.fps,
      probed: true,
    };
    if (!app.sel.end || app.sel.end > app.info.duration) app.sel.end = app.info.duration;
    if (!before.width && dispW) {
      $('stage').classList.remove('pending');
      framer.setSource(dispW, dispH);
    }
    syncSelectionInputs();
    refreshMeta();

    if (!app.info.width || !app.info.duration) {
      setSourceStatus(
        'The engine could not read this file\u2019s video track, so the editing tools are switched off. ' +
          'Try a different file, or open the engine log after running a job for details.',
        { problem: true, retry: true },
      );
      setToolsReady(false);
      return;
    }

    setSourceStatus('');
    setToolsReady(true);
    reflectAudioAvailability();
  } catch (err) {
    console.warn('probe failed', err);
    if (app.file !== file) return;
    setSourceStatus(`Could not start the video engine: ${err?.message || err}`, { problem: true, retry: true });
    setToolsReady(false);
  }
}

/** Copy the source into ffmpeg's filesystem once, then reuse it for every job. */
async function stageSource() {
  if (app.fsName) return app.fsName;
  const ext = extOf(app.file.name) || 'mp4';
  const name = `source.${ext}`;
  setStatus('Reading the video…');
  await runner.writeFile(name, app.file);
  app.fsName = name;
  app.fsGeneration = runner.generation;
  return name;
}

function refreshMeta() {
  const i = app.info || {};
  const bits = [];
  if (i.width) bits.push(`${i.width}×${i.height}`);
  if (i.duration) bits.push(fmtTime(i.duration));
  if (i.fps) bits.push(`${i.fps.toFixed(0)} fps`);
  if (app.file) bits.push(fmtBytes(app.file.size));
  if (i.probed) bits.push(i.hasAudio ? `audio: ${i.audioCodec || 'yes'}` : 'no audio');
  if (previewFailed) {
    // Some browsers refuse to play formats ffmpeg is perfectly happy to edit.
    bits.push('this browser cannot play the file — editing still works');
  }
  if (!i.probed) bits.push('reading…');
  $('sourceMeta').textContent = bits.join(' · ');
}

function reflectAudioAvailability() {
  const has = app.info?.hasAudio !== false;
  $('runExtract').disabled = !has;
  $('runStrip').disabled = !has;
  const mixRadio = document.querySelector('input[name="amode"][value="mix"]');
  if (mixRadio) {
    mixRadio.disabled = !has;
    if (!has && mixRadio.checked) {
      document.querySelector('input[name="amode"][value="replace"]').checked = true;
      $('origVolRow').hidden = true;
    }
  }
  if (!has) setSummaryNote();
}

function setSummaryNote() {
  const d = $('runExtract').closest('details');
  if (d && !d.querySelector('.noaudio')) {
    const p = document.createElement('p');
    p.className = 'hint noaudio';
    p.textContent = 'This video has no audio track.';
    d.appendChild(p);
  }
}

/* ------------------------------------------------------------------ *
 * transport + selection
 * ------------------------------------------------------------------ */

let selectionPlayback = null;

function syncSelectionInputs() {
  const d = app.info?.duration || 0;
  app.sel.start = clamp(app.sel.start, 0, d);
  app.sel.end = clamp(app.sel.end || d, app.sel.start, d);
  $('startTime').value = fmtTime(app.sel.start);
  $('endTime').value = fmtTime(app.sel.end);
  const fill = $('rangeFill');
  if (d > 0) {
    fill.style.left = `${(app.sel.start / d) * 100}%`;
    fill.style.width = `${((app.sel.end - app.sel.start) / d) * 100}%`;
  } else {
    fill.style.left = '0';
    fill.style.width = '100%';
  }
  const len = Math.max(0, app.sel.end - app.sel.start);
  $('selLabel').textContent = `${fmtTime(len)} selected`;
  updateClipHint();
}

function readSelectionInputs() {
  const d = app.info?.duration || 0;
  const s = parseTimecode($('startTime').value);
  const e = parseTimecode($('endTime').value);
  if (s != null) app.sel.start = clamp(s, 0, d);
  if (e != null) app.sel.end = clamp(e, app.sel.start, d || e);
  if (app.sel.end <= app.sel.start) app.sel.end = Math.min(d, app.sel.start + 0.1);
  syncSelectionInputs();
}

previewEl.addEventListener('timeupdate', () => {
  const d = app.info?.duration || previewEl.duration || 0;
  if (d > 0) $('seek').value = String(Math.round((previewEl.currentTime / d) * 1000));
  $('timeLabel').textContent = `${fmtTime(previewEl.currentTime)} / ${fmtTime(d)}`;
  if (selectionPlayback != null && previewEl.currentTime >= selectionPlayback) {
    previewEl.pause();
    selectionPlayback = null;
  }
});
previewEl.addEventListener('play', () => ($('playBtn').textContent = '❚❚ Pause'));
previewEl.addEventListener('pause', () => {
  $('playBtn').textContent = '▶︎ Play';
  framer.render();
});
previewEl.addEventListener('seeked', () => framer.render());
previewEl.addEventListener('loadeddata', () => framer.render());

$('playBtn').addEventListener('click', () => {
  if (previewEl.paused) previewEl.play().catch(() => {});
  else previewEl.pause();
});
$('seek').addEventListener('input', () => {
  const d = app.info?.duration || previewEl.duration || 0;
  selectionPlayback = null;
  if (d > 0) previewEl.currentTime = (Number($('seek').value) / 1000) * d;
});
for (const btn of document.querySelectorAll('[data-set]')) {
  btn.addEventListener('click', () => {
    const t = previewEl.currentTime || 0;
    if (btn.dataset.set === 'start') app.sel.start = t;
    else app.sel.end = t;
    if (app.sel.end <= app.sel.start) {
      if (btn.dataset.set === 'start') app.sel.end = Math.min(app.info?.duration || t, t + 1);
      else app.sel.start = Math.max(0, t - 1);
    }
    syncSelectionInputs();
  });
}
$('startTime').addEventListener('change', readSelectionInputs);
$('endTime').addEventListener('change', readSelectionInputs);
$('playSelection').addEventListener('click', () => {
  previewEl.currentTime = app.sel.start;
  selectionPlayback = app.sel.end;
  previewEl.play().catch(() => {});
});
$('resetSelection').addEventListener('click', () => {
  app.sel = { start: 0, end: app.info?.duration || 0 };
  syncSelectionInputs();
});

/* ------------------------------------------------------------------ *
 * file pickers
 * ------------------------------------------------------------------ */

$('fileInput').addEventListener('change', (e) => loadSource(e.target.files?.[0]));
$('changeFile').addEventListener('click', () => $('fileInput').click());

const dz = $('dropzone');
for (const type of ['dragenter', 'dragover']) {
  dz.addEventListener(type, (e) => (e.preventDefault(), dz.classList.add('over')));
}
for (const type of ['dragleave', 'drop']) {
  dz.addEventListener(type, (e) => (e.preventDefault(), dz.classList.remove('over')));
}
dz.addEventListener('drop', (e) => loadSource(e.dataTransfer?.files?.[0]));

$('audioInput').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  app.audioFile = f;
  app.audioInfo = null;
  $('audioFileName').textContent = f.name;
  $('addAudioOpts').hidden = false;
  $('audioTrackHint').textContent = 'Reading track…';
  try {
    await ensureEngine();
    const name = `added.${extOf(f.name) || 'mp3'}`;
    await runner.writeFile(name, f);
    const p = await runner.probe(name);
    await runner.remove(name);
    app.audioInfo = p;
    const vd = app.info?.duration || 0;
    const short = p.duration && vd && p.duration < vd;
    $('audioTrackHint').textContent =
      `Track is ${fmtTime(p.duration)} long; the video is ${fmtTime(vd)}. ` +
      (short ? 'It is shorter than the video — turn on looping to cover the gap.' : 'It will be trimmed to the video length.');
    $('audioLoop').checked = !!short;
  } catch {
    $('audioTrackHint').textContent = 'Could not read the track length; it will be trimmed to the video length.';
  }
});

/* ------------------------------------------------------------------ *
 * tabs
 * ------------------------------------------------------------------ */

function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `panel-${name}`;
  $('croplayer').hidden = name !== 'frame';
  if (name === 'frame') {
    framer.relayout();
    framer.render();
  }
}
$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) showTab(tab.dataset.tab);
});

/* ------------------------------------------------------------------ *
 * framer wiring
 * ------------------------------------------------------------------ */

const framer = createFramer({
  stage: $('stage'),
  rotor: $('rotor'),
  video: previewEl,
  layer: $('croplayer'),
  box: $('cropbox'),
  canvas: $('framePreview'),
  onChange: updateFrameDims,
});

for (const [key, val] of Object.entries(ASPECTS)) {
  $('aspect').add(new Option(val.label, key));
}
for (const key of Object.keys(SIZES)) {
  $('frameSize').add(new Option(key === 'source' ? 'Same as source' : `${key}p`, key));
}

function frameOptions() {
  const s = framer.getSettings();
  return {
    ...s,
    shortEdge: SIZES[$('frameSize').value] || 0,
    quality: $('frameQuality').value,
  };
}

function updateFrameDims() {
  const o = frameOptions();
  const i = app.info || {};
  if (!i.width) return;
  const built = buildFrame({
    input: 'x.mp4', base: 'x',
    rotate: o.rotate, flipH: o.flipH, crop: o.crop, fill: o.fill, aspect: o.aspect,
    shortEdge: o.shortEdge, sourceWidth: i.width, sourceHeight: i.height,
  });
  $('frameDims').textContent = `${built.width} × ${built.height}${o.fill === 'blur' && ASPECTS[o.aspect]?.ratio ? ' · blurred fill' : ''}`;
}

$('rotLeft').addEventListener('click', () => framer.rotateBy(-90));
$('rotRight').addEventListener('click', () => framer.rotateBy(90));
$('flipBtn').addEventListener('click', () => framer.setFlip(!framer.state.flipH));
$('resetCrop').addEventListener('click', () => framer.resetCrop());
$('aspect').addEventListener('change', () => {
  framer.setAspect($('aspect').value);
  updateFillHint();
});
$('frameSize').addEventListener('change', updateFrameDims);
for (const r of document.querySelectorAll('input[name="fill"]')) {
  r.addEventListener('change', () => {
    framer.setFill(r.value);
    updateFillHint();
  });
}
for (const [id, key, div] of [['blurAmount', 'blurAmount', 1], ['bgZoom', 'bgZoom', 100], ['bgDim', 'bgDim', 100]]) {
  $(id).addEventListener('input', () => framer.setBackground({ [key]: Number($(id).value) / div }));
}

function updateFillHint() {
  const blur = document.querySelector('input[name="fill"]:checked').value === 'blur';
  const hasRatio = !!ASPECTS[$('aspect').value]?.ratio;
  $('blurOpts').hidden = !blur;
  if (blur && !hasRatio) {
    toast('Pick an output shape (like 9:16) so there is empty space to fill.');
  }
  updateFrameDims();
}
window.addEventListener('resize', () => (framer.relayout(), framer.render()));

/* ------------------------------------------------------------------ *
 * jobs
 * ------------------------------------------------------------------ */

function updateClipHint() {
  const exact = $('clipReencode').checked;
  $('clipQualityRow').hidden = !exact;
  $('clipModeHint').textContent = exact
    ? 'Re-encodes the section, so the cut lands on the exact frame you picked.'
    : 'Copies the streams untouched — very fast and lossless, but the start snaps back to the nearest keyframe (usually within a second or two).';
}
$('clipReencode').addEventListener('change', updateClipHint);

async function runJob(title, build, kind = 'video') {
  if (app.busy) return;
  if (!app.file) return toast('Choose a video first.', true);
  app.busy = true;
  releaseResult();
  $('jobCard').hidden = false;
  $('resultCard').hidden = true;
  $('jobTitle').textContent = title;
  $('jobLog').textContent = '';
  $('jobBar').style.width = '0%';
  $('jobBar').classList.add('indeterminate');
  setButtonsDisabled(true);
  const started = performance.now();

  try {
    await ensureEngine();
    const input = await stageSource();
    const plan = await build(input);
    setStatus('Processing…');
    await runner.exec(plan.args);
    setStatus('Collecting the result…');
    const data = await runner.readFile(plan.output);
    await runner.remove(plan.output, ...(plan.cleanup || []));
    const blob = new Blob([data.buffer ?? data], { type: plan.mime || (kind === 'audio' ? 'audio/mpeg' : 'video/mp4') });
    showResult(blob, plan.output, kind);
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    setStatus(`Finished in ${secs}s.`);
    $('jobBar').classList.remove('indeterminate');
    $('jobBar').style.width = '100%';
  } catch (err) {
    console.error(err);
    $('jobBar').classList.remove('indeterminate');
    $('jobBar').style.width = '0%';
    const msg = err instanceof FfmpegError ? err.friendly : err?.message || String(err);
    setStatus(`Failed: ${msg}`);
    $('logBox').open = true;
    toast(msg, true);
  } finally {
    app.busy = false;
    setButtonsDisabled(false);
  }
}

function setButtonsDisabled(on) {
  setToolsReady(!on && app.info?.probed === true && !!app.info?.duration);
}

function selectionOrNull(useSelection) {
  const d = app.info?.duration || 0;
  const whole = app.sel.start <= 0.001 && (!d || app.sel.end >= d - 0.001);
  if (!useSelection || whole) return null;
  return { start: app.sel.start, duration: Math.max(0.05, app.sel.end - app.sel.start) };
}

$('runClip').addEventListener('click', () =>
  runJob('Clipping…', (input) => {
    const d = app.info?.duration || 0;
    const dur = Math.max(0.05, app.sel.end - app.sel.start);
    if (d && dur >= d - 0.01 && app.sel.start < 0.01) toast('The selection covers the whole video.');
    return buildClip({
      input,
      base: app.base,
      start: app.sel.start,
      duration: dur,
      reencode: $('clipReencode').checked,
      quality: $('clipQuality').value,
      caps: runner.caps,
    });
  }));

$('runStrip').addEventListener('click', () =>
  runJob('Removing audio…', (input) => buildStripAudio({ input, base: app.base })));

$('runExtract').addEventListener('click', () =>
  runJob('Extracting audio…', (input) => {
    const range = selectionOrNull($('audioUseSelection').checked);
    const format = $('audioFormat').value;
    const plan = buildExtractAudio({
      input,
      base: app.base,
      start: range?.start || 0,
      duration: range?.duration || 0,
      bitrate: $('audioBitrate').value,
      format,
      caps: runner.caps,
    });
    plan.mime = format === 'wav' ? 'audio/wav' : format === 'm4a' ? 'audio/mp4' : 'audio/mpeg';
    return plan;
  }, 'audio'));

$('runAddAudio').addEventListener('click', () =>
  runJob('Adding audio…', async (input) => {
    if (!app.audioFile) throw new Error('Choose an audio file first.');
    const aName = `added.${extOf(app.audioFile.name) || 'mp3'}`;
    await runner.writeFile(aName, app.audioFile);
    const mode = document.querySelector('input[name="amode"]:checked').value;
    const plan = buildAddAudio({
      video: input,
      audio: aName,
      base: app.base,
      mode,
      audioStart: parseTimecode($('audioStart').value) || 0,
      audioVolume: Number($('audioVolume').value) / 100,
      originalVolume: Number($('origVolume').value) / 100,
      loop: $('audioLoop').checked,
      fadeOut: Number($('fadeOut').value) || 0,
      videoDuration: app.info?.duration || 0,
      sourceHasAudio: app.info?.hasAudio !== false,
      caps: runner.caps,
    });
    plan.cleanup = [aName];
    return plan;
  }));

$('runFrame').addEventListener('click', () =>
  runJob('Rendering…', async (input) => {
    const i = app.info || {};
    if (!i.width) throw new Error('Could not work out the video size.');
    const o = frameOptions();
    const range = selectionOrNull($('frameUseSelection').checked);

    const plan = buildFrame({
      input,
      base: app.base,
      start: range?.start || 0,
      duration: range?.duration || 0,
      rotate: o.rotate,
      flipH: o.flipH,
      crop: o.crop,
      fill: o.fill,
      aspect: o.aspect,
      shortEdge: o.shortEdge,
      blurAmount: o.blurAmount,
      bgZoom: o.bgZoom,
      bgDim: o.bgDim,
      quality: o.quality,
      sourceWidth: i.width,
      sourceHeight: i.height,
      hasAudio: i.hasAudio !== false,
      audioCodec: i.audioCodec,
      caps: runner.caps,
    });
    return plan;
  }));

$('cancelJob').addEventListener('click', async () => {
  if (!app.busy) return;
  runner.terminate();
  app.fsName = null;
  app.busy = false;
  setButtonsDisabled(false);
  $('jobBar').classList.remove('indeterminate');
  setStatus('Cancelled.');
});

/* ------------------------------------------------------------------ *
 * results
 * ------------------------------------------------------------------ */

function releaseResult() {
  if (app.result?.url) URL.revokeObjectURL(app.result.url);
  app.result = null;
  $('resultCard').hidden = true;
}

function showResult(blob, name, kind) {
  const url = URL.createObjectURL(blob);
  app.result = { url, blob, name, kind };
  $('resultCard').hidden = false;
  const v = $('resultVideo');
  const a = $('resultAudio');
  v.hidden = kind !== 'video';
  a.hidden = kind === 'video';
  if (kind === 'video') (v.src = url), v.load();
  else (a.src = url), a.load();
  $('resultMeta').textContent = `${name} · ${fmtBytes(blob.size)}`;
  const dl = $('downloadBtn');
  dl.href = url;
  dl.download = name;
  $('chainBtn').hidden = kind !== 'video';

  const file = new File([blob], name, { type: blob.type });
  const canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  $('shareBtn').hidden = !canShare;
  $('shareBtn').onclick = () => navigator.share({ files: [file], title: name }).catch(() => {});
  $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('chainBtn').addEventListener('click', async () => {
  if (!app.result) return;
  const file = new File([app.result.blob], app.result.name, { type: app.result.blob.type });
  await runner.remove(app.fsName);
  await loadSource(file);
  toast('Now editing the result.');
});

/* ------------------------------------------------------------------ *
 * chrome
 * ------------------------------------------------------------------ */

$('retryProbe').addEventListener('click', () => {
  runner.terminate();
  app.fsName = null;
  probeInBackground();
});

$('aboutBtn').addEventListener('click', () => $('aboutDlg').showModal());

for (const r of document.querySelectorAll('input[name="amode"]')) {
  r.addEventListener('change', () => ($('origVolRow').hidden = r.value !== 'mix' || !r.checked));
}
$('audioFormat').addEventListener('change', () => {
  $('audioBitrateRow').hidden = $('audioFormat').value === 'wav';
});

$('engineNote').textContent =
  'Everything runs on this device — no uploads. Cuts and audio swaps are instant; ' +
  'cropping and rotating have to re-encode, so give them time.';

updateClipHint();
updateFillHint();
setToolsReady(false);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './' }).catch(() => {});
  });
}

// A small handle for debugging and for the end-to-end tests. Everything here is
// local to the page; the app has no network side to expose.
window.__pocketcut = { app, runner, framer, ensureEngine, showTab };
