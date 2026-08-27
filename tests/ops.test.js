import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASPECTS, buildAddAudio, buildClip, buildExtractAudio, buildFrame, buildStripAudio,
  canCopyAudio, even, parseCaps, parseProbe, parseTimecode, targetSize, timecode, audioEncoder,
} from '../src/ops.js';

const argOf = (args, flag) => args[args.indexOf(flag) + 1];
const src = { input: 'source.mp4', base: 'clip' };

test('timecode round-trips', () => {
  assert.equal(timecode(0), '00:00:00.000');
  assert.equal(timecode(3661.5), '01:01:01.500');
  assert.equal(parseTimecode('1:01.5'), 61.5);
  assert.equal(parseTimecode('01:01:01.5'), 3661.5);
  assert.equal(parseTimecode('12.25'), 12.25);
  assert.equal(parseTimecode('nope'), null);
  assert.equal(parseTimecode(''), null);
});

test('even() never returns odd or zero', () => {
  assert.equal(even(101), 100);
  assert.equal(even(100), 100);
  assert.equal(even(1), 2);
  assert.equal(even(0), 2);
});

test('extract audio produces an mp3 with the requested bitrate', () => {
  const { args, output } = buildExtractAudio({ ...src, bitrate: '320k' });
  assert.equal(output, 'clip-audio.mp3');
  assert.equal(argOf(args, '-c:a'), 'libmp3lame');
  assert.equal(argOf(args, '-b:a'), '320k');
  assert.ok(args.includes('-vn'));
});

test('extract audio honours a selection and falls back when lame is missing', () => {
  const { args } = buildExtractAudio({ ...src, start: 5, duration: 10 });
  assert.equal(argOf(args, '-ss'), timecode(5));
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'), 'input seek must come before -i');
  assert.equal(argOf(args, '-t'), timecode(10));

  const caps = { encoders: new Set(['aac']), filters: new Set() };
  const fallback = buildExtractAudio({ ...src, caps });
  assert.equal(fallback.output, 'clip-audio.m4a');
  assert.equal(argOf(fallback.args, '-c:a'), 'aac');

  const wav = buildExtractAudio({ ...src, format: 'wav' });
  assert.equal(wav.output, 'clip-audio.wav');
  assert.equal(argOf(wav.args, '-c:a'), 'pcm_s16le');
});

test('stripping audio is a pure stream copy', () => {
  const { args, output } = buildStripAudio({ input: 'source.mov', base: 'clip' });
  assert.equal(output, 'clip-muted.mov');
  assert.ok(args.includes('-an'));
  assert.deepEqual([argOf(args, '-c')], ['copy']);
  assert.ok(!args.includes('libx264'));
});

test('clip copies streams by default and re-encodes on request', () => {
  const copy = buildClip({ ...src, start: 3, duration: 7 });
  assert.equal(copy.output, 'clip-clip.mp4');
  assert.equal(argOf(copy.args, '-ss'), timecode(3));
  assert.equal(argOf(copy.args, '-t'), timecode(7));
  assert.equal(argOf(copy.args, '-c'), 'copy');
  assert.ok(copy.args.includes('-avoid_negative_ts'));

  const exact = buildClip({ ...src, start: 3, duration: 7, reencode: true, quality: 'best' });
  assert.equal(argOf(exact.args, '-c:v'), 'libx264');
  assert.equal(argOf(exact.args, '-crf'), '20');
  assert.equal(argOf(exact.args, '-preset'), 'medium');
  assert.ok(!exact.args.includes('-avoid_negative_ts'));
});

test('unknown containers fall back to mp4 rather than failing at mux time', () => {
  assert.equal(buildClip({ input: 'a.avi', base: 'a', start: 0, duration: 1 }).output, 'a-clip.mp4');
  assert.equal(buildStripAudio({ input: 'a.3gp', base: 'a' }).output, 'a-muted.mp4');
});

test('adding audio replaces the track without touching the video', () => {
  const { args, output } = buildAddAudio({
    video: 'source.mp4', audio: 'added.mp3', base: 'clip', audioStart: 12, audioVolume: 0.5,
  });
  assert.equal(output, 'clip-newaudio.mp4');
  assert.equal(argOf(args, '-c:v'), 'copy');
  assert.ok(args.includes('-shortest'));
  assert.equal(argOf(args, '-ss'), timecode(12));
  assert.ok(args.indexOf('-ss') > args.indexOf('source.mp4'), '-ss must apply to the audio input');
  assert.match(argOf(args, '-filter:a'), /volume=0\.500/);
  assert.deepEqual(args.filter((a) => a === '-map').length, 2);
});

test('adding audio can loop and fade', () => {
  const { args } = buildAddAudio({
    video: 'v.mp4', audio: 'a.mp3', base: 'c', loop: true, fadeOut: 2, videoDuration: 30,
  });
  assert.equal(argOf(args, '-stream_loop'), '-1');
  assert.ok(args.indexOf('-stream_loop') > args.indexOf('v.mp4'), 'loop applies to the audio input only');
  assert.match(argOf(args, '-filter:a'), /afade=t=out:st=28\.00:d=2\.00/);
});

test('mixing needs the source to actually have audio', () => {
  const mixed = buildAddAudio({
    video: 'v.mp4', audio: 'a.mp3', base: 'c', mode: 'mix', sourceHasAudio: true, originalVolume: 0.3,
  });
  const graph = argOf(mixed.args, '-filter_complex');
  assert.match(graph, /\[0:a\]volume=0\.300\[orig\]/);
  assert.match(graph, /amix=inputs=2/);

  const noSource = buildAddAudio({ video: 'v.mp4', audio: 'a.mp3', base: 'c', mode: 'mix', sourceHasAudio: false });
  assert.ok(!noSource.args.includes('-filter_complex'), 'falls back to replace');
});

test('target size: blur fill grows the canvas, trim keeps the crop', () => {
  // A 3:4 crop asked to become 9:16 gains height, never loses width.
  const blur = targetSize({ cropW: 600, cropH: 800, aspect: '9:16', fill: 'blur' });
  assert.equal(blur.width, 600);
  assert.equal(blur.height, 1066);

  const trim = targetSize({ cropW: 600, cropH: 800, aspect: 'source', fill: 'trim' });
  assert.deepEqual(trim, { width: 600, height: 800 });
});

test('output size presets are measured on the short edge', () => {
  assert.deepEqual(targetSize({ cropW: 600, cropH: 800, aspect: '9:16', fill: 'blur', shortEdge: 1080 }), { width: 1080, height: 1920 });
  assert.deepEqual(targetSize({ cropW: 3840, cropH: 2160, aspect: '16:9', fill: 'trim', shortEdge: 720 }), { width: 1280, height: 720 });
  assert.deepEqual(targetSize({ cropW: 900, cropH: 900, aspect: '1:1', fill: 'trim', shortEdge: 1080 }), { width: 1080, height: 1080 });
});

test('frame: rotation swaps the crop space and clamps the box', () => {
  const r = buildFrame({
    ...src, rotate: 90, crop: { x: -50, y: 0, w: 9999, h: 9999 },
    sourceWidth: 1920, sourceHeight: 1080,
  });
  const vf = argOf(r.args, '-vf');
  assert.match(vf, /transpose=1/);
  // After a 90 degree turn the frame is 1080x1920, so the crop clamps to that.
  assert.match(vf, /crop=1080:1920:0:0/);
});

test('frame: 180 and flip', () => {
  const r = buildFrame({ ...src, rotate: 180, flipH: true, sourceWidth: 640, sourceHeight: 480 });
  const vf = argOf(r.args, '-vf');
  assert.match(vf, /transpose=1,transpose=1,hflip/);
});

test('frame: trim mode is a plain -vf chain with even dimensions', () => {
  const r = buildFrame({
    ...src, crop: { x: 11, y: 7, w: 641, h: 481 }, fill: 'trim',
    sourceWidth: 1920, sourceHeight: 1080, hasAudio: true, audioCodec: 'aac',
  });
  assert.ok(!r.args.includes('-filter_complex'));
  assert.match(argOf(r.args, '-vf'), /crop=640:480:11:7/);
  assert.equal(r.width % 2, 0);
  assert.equal(r.height % 2, 0);
  assert.equal(argOf(r.args, '-c:a'), 'copy', 'aac in mp4 can be copied');
});

test('frame: blurred fill builds a split/overlay graph at the target size', () => {
  const r = buildFrame({
    ...src, crop: { x: 0, y: 0, w: 1920, h: 1080 }, fill: 'blur', aspect: '9:16', shortEdge: 1080,
    sourceWidth: 1920, sourceHeight: 1080, hasAudio: true, audioCodec: 'opus',
  });
  const g = argOf(r.args, '-filter_complex');
  assert.match(g, /split=2\[fg\]\[bg\]/);
  assert.match(g, /boxblur=\d+:2/);
  assert.match(g, /overlay=\(main_w-overlay_w\)\/2:\(main_h-overlay_h\)\/2/);
  assert.match(g, /\[fg\]scale=1080:1920:force_original_aspect_ratio=decrease/);
  assert.equal(r.width, 1080);
  assert.equal(r.height, 1920);
  assert.equal(argOf(r.args, '-c:a'), 'aac', 'opus cannot be copied into mp4');
  assert.equal(argOf(r.args, '-map'), '[v]');
});

test('frame: blurred fill with no target shape degrades to a plain crop', () => {
  const r = buildFrame({ ...src, fill: 'blur', aspect: 'source', sourceWidth: 640, sourceHeight: 480 });
  assert.ok(!r.args.includes('-filter_complex'));
  assert.equal(r.output, 'clip-cropped.mp4');
});

test('frame: a video with no audio gets -an', () => {
  const r = buildFrame({ ...src, sourceWidth: 640, sourceHeight: 480, hasAudio: false });
  assert.ok(r.args.includes('-an'));
});

test('blur radius stays inside what boxblur will accept', () => {
  for (const shortEdge of [0, 480, 720, 1080, 1440]) {
    for (const blurAmount of [2, 14, 40, 100]) {
      const r = buildFrame({
        ...src, crop: { x: 0, y: 0, w: 200, h: 120 }, fill: 'blur', aspect: '9:16',
        shortEdge, blurAmount, sourceWidth: 200, sourceHeight: 120,
      });
      const g = argOf(r.args, '-filter_complex');
      const radius = Number(/boxblur=(\d+):2/.exec(g)[1]);
      const [, bw, bh] = /crop=(\d+):(\d+),\s*boxblur/.exec(g.replace(/,boxblur/, ',boxblur')) || [];
      assert.ok(radius >= 1, `radius ${radius} must be positive`);
      assert.ok(radius <= Math.min(Number(bw), Number(bh)) / 2, `radius ${radius} too large for ${bw}x${bh}`);
    }
  }
});

test('audio codec choice respects the container', () => {
  assert.equal(audioEncoder('mp4'), 'aac');
  assert.equal(audioEncoder('webm'), 'libopus');
  assert.equal(audioEncoder('mp4', { encoders: new Set(['libmp3lame']), filters: new Set() }), 'libmp3lame');
  assert.ok(canCopyAudio('aac', 'mp4'));
  assert.ok(!canCopyAudio('opus', 'mp4'));
  assert.ok(!canCopyAudio('', 'mp4'));
});

test('probe parses ffmpeg stream banners', () => {
  const log = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'source.mp4':
  Duration: 00:01:03.42, start: 0.000000, bitrate: 17085 kb/s
  Stream #0:0[0x1](eng): Video: h264 (High) (avc1 / 0x31637661), yuvj420p(pc), 3840x2160, 16871 kb/s, 29.98 fps, 30 tbr
      rotate          : 90
  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 189 kb/s
`;
  const p = parseProbe(log);
  assert.equal(Math.round(p.duration), 63);
  assert.equal(p.width, 3840);
  assert.equal(p.height, 2160);
  assert.equal(p.videoCodec, 'h264');
  assert.equal(p.audioCodec, 'aac');
  assert.equal(p.hasAudio, true);
  assert.equal(p.rotation, 90);
  assert.equal(Math.round(p.fps), 30);
});

test('probe reports a missing audio track', () => {
  const p = parseProbe(`Duration: 00:00:05.00, start: 0.0\n  Stream #0:0: Video: h264, yuv420p, 640x480, 30 fps`);
  assert.equal(p.hasAudio, false);
  assert.equal(p.hasVideo, true);
});

test('capability parsing reads -encoders and -filters output', () => {
  const caps = parseCaps(
    ' V....D libx264              libx264 H.264\n A....D libmp3lame           libmp3lame MP3\n',
    ' ... boxblur           V->V       Blur the input.\n TSC eq               V->V       Adjust brightness.\n',
  );
  assert.ok(caps.encoders.has('libx264'));
  assert.ok(caps.encoders.has('libmp3lame'));
  assert.ok(caps.filters.has('boxblur'));
  assert.ok(caps.filters.has('eq'));
});

test('every aspect preset produces a usable ratio or null', () => {
  for (const [key, val] of Object.entries(ASPECTS)) {
    assert.ok(val.ratio === null || val.ratio > 0, `${key} ratio`);
    assert.equal(typeof val.label, 'string');
  }
});

test('frame can trim in the same pass instead of a separate copy step', () => {
  const r = buildFrame({ ...src, start: 1.5, duration: 2, sourceWidth: 640, sourceHeight: 480 });
  assert.equal(argOf(r.args, '-ss'), timecode(1.5));
  assert.ok(r.args.indexOf('-ss') < r.args.indexOf('-i'), 'seek before input');
  assert.equal(argOf(r.args, '-t'), timecode(2));
  assert.ok(r.args.indexOf('-t') > r.args.indexOf('source.mp4'));

  const whole = buildFrame({ ...src, sourceWidth: 640, sourceHeight: 480 });
  assert.ok(!whole.args.includes('-ss') && !whole.args.includes('-t'));
});
