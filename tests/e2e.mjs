/**
 * End-to-end check: drives the real UI in Chromium and verifies each export by
 * feeding the result back through ffmpeg and reading its stream info.
 *
 *   npm run build && npm run test:e2e
 */
import { chromium } from 'playwright';

import { startStaticServer } from './static-server.mjs';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

/**
 * Use the sandbox's pre-installed Chromium when it is there; otherwise let
 * Playwright fall back to whatever `playwright install` put in place (CI).
 */
function browserPath() {
  const p = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
  return existsSync(p) ? { executablePath: p } : {};
}


const PORT = Number(process.env.E2E_PORT || 4178);
const URL_BASE = `http://127.0.0.1:${PORT}/`;
const HEADFUL = process.env.HEADFUL === '1';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

// Artifacts land here; it is git-ignored, so a fresh checkout has to create it.
const ARTIFACTS = 'test-results';
mkdirSync(ARTIFACTS, { recursive: true });

// Served gzipped, the way GitHub Pages serves it, so production-only
// compression bugs surface here rather than on a phone.
const server = await startStaticServer({ root: 'dist', port: PORT });

let browser;

try {
  browser = await chromium.launch({
    headless: !HEADFUL,
    ...browserPath(),
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('pageerror', (e) => console.log('   page error:', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('   console:', m.text()));

  await page.goto(URL_BASE, { waitUntil: 'load' });

  console.log('· loading the ffmpeg engine (this downloads ~32 MB)…');
  await page.evaluate(() => window.__pocketcut.ensureEngine());
  const engine = await page.evaluate(() => ({
    encoders: [...window.__pocketcut.runner.caps.encoders].length,
    filters: [...window.__pocketcut.runner.caps.filters].length,
    hasAac: window.__pocketcut.runner.caps.encoders.has('aac'),
    hasLame: window.__pocketcut.runner.caps.encoders.has('libmp3lame'),
    hasBoxblur: window.__pocketcut.runner.caps.filters.has('boxblur'),
    hasEq: window.__pocketcut.runner.caps.filters.has('eq'),
    hasTranspose: window.__pocketcut.runner.caps.filters.has('transpose'),
  }));
  console.log(`  engine: ${engine.encoders} encoders, ${engine.filters} filters`);
  check('capability probe found encoders and filters', engine.encoders > 10 && engine.filters > 10);
  check('libmp3lame present (MP3 export)', engine.hasLame);
  check('aac present (MP4 audio)', engine.hasAac);
  check('boxblur + transpose present (blur fill, rotate)', engine.hasBoxblur && engine.hasTranspose);

  console.log('\n· building a test clip…');
  const fixture = await page.evaluate(async () => {
    const r = window.__pocketcut.runner;
    await r.exec([
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', '4', '-g', '25', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', 'fixture.mp4',
    ]);
    const data = await r.readFile('fixture.mp4');
    await r.remove('fixture.mp4');
    return Array.from(data);
  });
  check('generated a 640x360 / 4s test clip', fixture.length > 1000, `${(fixture.length / 1024).toFixed(0)} KB`);

  await page.setInputFiles('#fileInput', {
    name: 'holiday clip.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from(fixture),
  });
  await page.waitForFunction(() => window.__pocketcut.app.info?.probed === true, { timeout: 60000 });

  const info = await page.evaluate(() => window.__pocketcut.app.info);
  check('source probed', info.width === 640 && info.height === 360 && info.hasAudio,
    `${info.width}x${info.height}, ${info.duration.toFixed(2)}s, audio=${info.audioCodec}`);

  /** Re-open the last result inside ffmpeg and report what it actually contains. */
  async function inspectResult() {
    return page.evaluate(async () => {
      const { app, runner } = window.__pocketcut;
      const bytes = new Uint8Array(await app.result.blob.arrayBuffer());
      await runner.writeFile('verify.bin', bytes);
      const p = await runner.probe('verify.bin');
      await runner.remove('verify.bin');
      return { ...p, name: app.result.name, size: app.result.blob.size };
    });
  }

  async function runTool(tabName, buttonId, label) {
    await page.click(`.tab[data-tab="${tabName}"]`);
    // The audio panel keeps its three tools inside collapsed <details>.
    await page.evaluate((id) => document.getElementById(id).closest('details')?.setAttribute('open', ''), buttonId);
    await page.click(`#${buttonId}`);
    // runJob flips app.busy synchronously, so this waits for *this* job, not a
    // stale status line left over from the previous one.
    await page.waitForFunction(() => window.__pocketcut.app.busy === false, { timeout: 300000 });
    const status = await page.textContent('#jobStatus');
    if (/Failed/.test(status) || !(await page.evaluate(() => !!window.__pocketcut.app.result))) {
      check(label, false, status);
      return null;
    }
    const r = await inspectResult();
    console.log(`      ${r.name} · ${(r.size / 1024).toFixed(0)} KB · ` +
      `${r.width || '-'}x${r.height || '-'} · ${r.duration.toFixed(2)}s · ${status}`);
    return r;
  }

  /* ---- clip ---- */
  console.log('\n· clip a section (stream copy)');
  await page.click('.tab[data-tab="clip"]');
  await page.fill('#startTime', '0:01.0');
  await page.fill('#endTime', '0:03.0');
  await page.dispatchEvent('#endTime', 'change');
  let r = await runTool('clip', 'runClip', 'clip: exports a shorter file');
  if (r) check('clip: roughly 2 seconds long', Math.abs(r.duration - 2) < 0.6, `${r.duration.toFixed(2)}s`);
  if (r) check('clip: keeps both streams', r.hasVideo && r.hasAudio);

  console.log('\n· clip a section (exact / re-encode)');
  await page.check('#clipReencode');
  r = await runTool('clip', 'runClip', 'clip: exact mode re-encodes');
  if (r) check('clip: exact cut is close to 2s', Math.abs(r.duration - 2) < 0.35, `${r.duration.toFixed(2)}s`);
  await page.uncheck('#clipReencode');
  await page.click('#resetSelection');

  /* ---- audio ---- */
  console.log('\n· extract the audio as MP3');
  r = await runTool('audio', 'runExtract', 'audio: exports an MP3');
  if (r) check('audio: mp3 file with an audio stream and no video', r.hasAudio && !r.hasVideo, r.audioCodec);
  if (r) check('audio: named .mp3', r.name.endsWith('.mp3'), r.name);

  console.log('\n· strip the audio');
  r = await runTool('audio', 'runStrip', 'audio: exports a silent video');
  if (r) check('audio: silent video has video but no audio', r.hasVideo && !r.hasAudio);
  if (r) check('audio: strip kept the full duration', Math.abs(r.duration - 4) < 0.3, `${r.duration.toFixed(2)}s`);

  console.log('\n· add a new audio track');
  const music = await page.evaluate(async () => {
    const r = window.__pocketcut.runner;
    await r.exec(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '2', '-c:a', 'libmp3lame', 'music.mp3']);
    const d = await r.readFile('music.mp3');
    await r.remove('music.mp3');
    return Array.from(d);
  });
  await page.click('.tab[data-tab="audio"]');
  await page.evaluate(() => document.getElementById('audioInput').closest('details').setAttribute('open', ''));
  await page.setInputFiles('#audioInput', { name: 'song.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from(music) });
  await page.waitForSelector('#addAudioOpts:not([hidden])');
  await page.check('#audioLoop');
  r = await runTool('audio', 'runAddAudio', 'audio: swaps in a new track');
  if (r) check('audio: new track covers the whole video', r.hasAudio && Math.abs(r.duration - 4) < 0.4, `${r.duration.toFixed(2)}s`);

  console.log('\n· mix the new track with the original');
  await page.check('input[name="amode"][value="mix"]');
  r = await runTool('audio', 'runAddAudio', 'audio: mixes both tracks');
  if (r) check('audio: mix keeps video and audio', r.hasVideo && r.hasAudio);
  await page.check('input[name="amode"][value="replace"]');

  /* ---- frame ---- */
  console.log('\n· crop, trimming the leftovers away');
  await page.click('.tab[data-tab="frame"]');
  await page.selectOption('#aspect', '1:1');
  await page.selectOption('#frameSize', '480');
  await page.selectOption('#frameQuality', 'fast');
  r = await runTool('frame', 'runFrame', 'frame: square crop exports');
  if (r) check('frame: output is a 480x480 square', r.width === 480 && r.height === 480, `${r.width}x${r.height}`);

  console.log('\n· crop to 9:16 with the blurred fill');
  await page.selectOption('#aspect', '9:16');
  await page.check('input[name="fill"][value="blur"]');
  await page.selectOption('#frameSize', '480');
  r = await runTool('frame', 'runFrame', 'frame: blurred fill exports');
  if (r) check('frame: blurred fill is 480x854 (9:16)', r.width === 480 && r.height >= 848 && r.height <= 856, `${r.width}x${r.height}`);
  if (r) check('frame: blurred fill kept the audio', r.hasAudio);

  console.log('\n· rotate 90 degrees');
  await page.check('input[name="fill"][value="trim"]');
  await page.selectOption('#aspect', 'source');
  await page.click('#rotRight');
  await page.selectOption('#frameSize', 'source');
  r = await runTool('frame', 'runFrame', 'frame: rotation exports');
  if (r) check('frame: rotated output is 360x640', r.width === 360 && r.height === 640, `${r.width}x${r.height}`);

  console.log('\n· rotate + crop + blurred fill + trimmed to the selection');
  await page.click('#rotRight');
  await page.selectOption('#aspect', '4:5');
  await page.check('input[name="fill"][value="blur"]');
  await page.selectOption('#frameSize', '480');
  await page.fill('#startTime', '0:00.5');
  await page.fill('#endTime', '0:02.5');
  await page.dispatchEvent('#endTime', 'change');
  await page.check('#frameUseSelection');
  r = await runTool('frame', 'runFrame', 'frame: combined operation exports');
  if (r) check('frame: combined output is 480x600 (4:5)', r.width === 480 && r.height === 600, `${r.width}x${r.height}`);
  if (r) check('frame: combined output honoured the selection exactly', Math.abs(r.duration - 2) < 0.2, `${r.duration.toFixed(2)}s`);

  /* ---- eyeball the blurred fill ---- */
  console.log('\n· save a still from the blurred-fill export for inspection');
  await page.check('input[name="fill"][value="blur"]');
  await page.selectOption('#aspect', '9:16');
  await page.selectOption('#frameSize', '480');
  await page.uncheck('#frameUseSelection');
  await page.selectOption('#frameQuality', 'balanced');
  r = await runTool('frame', 'runFrame', 'frame: still-frame export ran');
  if (r) {
    const png = await page.evaluate(async () => {
      const { app, runner } = window.__pocketcut;
      await runner.writeFile('still.mp4', new Uint8Array(await app.result.blob.arrayBuffer()));
      await runner.exec(['-ss', '00:00:01.000', '-i', 'still.mp4', '-frames:v', '1', 'still.png']);
      const d = await runner.readFile('still.png');
      await runner.remove('still.mp4', 'still.png');
      return Array.from(d);
    });
    writeFileSync(`${ARTIFACTS}/blur-fill-frame.png`, Buffer.from(png));
    check('frame: wrote test-results/blur-fill-frame.png', png.length > 1000, `${(png.length / 1024).toFixed(0)} KB`);
  }

  /* ---- the safety net for a discarded tab ---- */
  console.log('\n· the finished export is written down in case the tab is discarded');
  const stashed = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('pocket-cut', 1);
        req.onsuccess = () => {
          const get = req.result.transaction('last-export', 'readonly').objectStore('last-export').get('result');
          get.onsuccess = () => resolve({ has: !!get.result?.blob, name: get.result?.name || '' });
          get.onerror = () => resolve({ has: false });
        };
        req.onerror = () => resolve({ has: false });
      }),
  );
  check('the last export is recoverable after a reload', stashed.has, stashed.name);

  /* ---- chaining ---- */
  console.log('\n· feed the result back in as a new source');
  await page.click('#chainBtn');
  await page.waitForFunction(() => window.__pocketcut.app.info?.probed === true && window.__pocketcut.app.info.width === 480,
    { timeout: 60000 });
  check('result can be edited again', true);

  await page.screenshot({ path: `${ARTIFACTS}/app.png`, fullPage: true }).catch(() => {});
} catch (err) {
  check('test run completed without throwing', false, err?.message || String(err));
  console.error(err);
} finally {
  await browser?.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
