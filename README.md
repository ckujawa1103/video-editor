# Pocket Cut

A small video editor that runs entirely in the browser on your phone. Pick a
video, cut it, crop it, rotate it, swap the audio, and save the result. Nothing
is ever uploaded — the whole video engine (ffmpeg, compiled to WebAssembly) runs
on the device, so it also works with no signal.

## What it does

| Tool | What happens |
| --- | --- |
| **Clip** | Exports the selected section as its own file. Lossless stream copy by default (instant); an "exact cut" option re-encodes so the cut lands on the precise frame. |
| **Crop & rotate** | Drag the crop box, rotate in 90° steps, flip, and pick an output shape (9:16, 1:1, 4:5, 16:9, 4:3). |
| **Trim it away** | The output is exactly the crop — no padding. |
| **Blurred fill** | The crop sits on a canvas of the chosen shape and a blurred, zoomed copy of the video fills the empty space, the way vertical TikToks do. Blur, background zoom and darkening are adjustable. |
| **Save the audio** | Exports the sound as MP3 (or M4A / WAV), optionally just the selected section. |
| **Remove the audio** | Drops the audio track and copies the video untouched — instant and lossless. |
| **Add an audio track** | Drops in a new track: replace the original or mix with it, set where in the track to start, adjust levels, loop a short track to cover the video, fade out at the end. The track is always trimmed to the video's length. |

A live preview canvas shows exactly what the export will look like, blurred fill
included. **Edit this result** feeds an export straight back in as the new
source, so operations can be chained (clip → crop → add music) without leaving
the page.

## Why a web app and not an Android APK

- `ffmpeg-kit`, the standard ffmpeg binding for Android, was retired in 2025 and
  its prebuilt binaries were pulled, so a native build has no maintained
  foundation.
- An APK means sideloading an unsigned build and re-installing by hand on every
  change.
- A web app installs to the home screen from the browser, updates itself, and
  runs the same code everywhere.

The trade-off is speed: WebAssembly re-encoding is slower than native. It is
mitigated where it matters — clipping, removing audio and adding audio are all
**stream copies** that do not re-encode at all, so they finish more or less
instantly regardless of file size. Only cropping, rotating and blurred fill have
to re-encode.

## Install it on your phone

1. Open the deployed URL in Chrome.
2. Menu → **Add to Home screen**.
3. Open it once from the home screen so the engine (~32 MB) is cached. After
   that it works offline.

## Running it locally

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # -> dist/
npm run preview        # serve the production build
```

`npm run build` copies the ffmpeg core out of `node_modules` into
`public/ffmpeg/` first (that directory is generated and git-ignored).

## Tests

```bash
npm test               # unit tests for every ffmpeg command the app builds
npm run build && npm run test:e2e   # drives the real UI in Chromium
```

The end-to-end test generates a test clip in the browser, runs every tool
against it, and verifies each export by feeding it back through ffmpeg and
reading the actual stream info — dimensions, duration and which streams
survived. It also writes `test-results/blur-fill-frame.png` so the blurred fill
can be eyeballed.

It serves the build over a **gzipping** static server (`tests/static-server.mjs`)
rather than `vite preview`, because GitHub Pages compresses responses and that
changes real behaviour: `Content-Length` then describes the compressed size
while the browser decodes far more bytes. An earlier version of the engine
loader treated the header as the true length and failed on the deployed site
only. Testing against a compressing server keeps that class of bug visible.

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every
push to the repository's default branch, and sets `VITE_BASE` to `/<repo-name>/`
so assets resolve under the Pages subdirectory.

One-time setup, in a browser: **Settings → Pages → Build and deployment →
Source → GitHub Actions**. The workflow cannot do this for you — creating a
Pages site is not a permission the Actions token can be granted.

GitHub Pages also only serves **private** repositories on paid plans. For a
private repo on the free plan, either make the repository public or use a host
that serves private repos for free — Cloudflare Pages and Netlify both do — with
build command `npm run build` and output directory `dist`.

Any static host works: the build output is plain files and needs no special
headers.

## Speed

Rendering happens in WebAssembly on the device, so the x264 preset decides
almost everything. Measured on an 8.3s 720x1280 clip:

| preset | time | vs. clip length |
| --- | --- | --- |
| stream copy (clip, mute, add audio) | 0.2s | 0.03x |
| decode only | 3.9s | 0.5x |
| `ultrafast` | 9.9s | 1.2x |
| `superfast` | 22.6s | 2.7x |
| `veryfast` | 38.9s | 4.7x |
| `medium` | 121.9s | 14.7x |

CRF barely moves the clock but decides the file size, so the presets in
`QUALITY` buy speed with the x264 preset and quality with CRF. Everything from
`veryfast` onwards makes a phone render feel broken; a unit test keeps those
presets out.

Clipping, removing audio and adding audio are stream copies and do not
re-encode at all, so they finish more or less instantly whatever the file size.
Trimming before cropping is therefore always worth it.

## Rendering in the background

A web page cannot insist on running while it is in the background — Android is
free to freeze or discard the tab, and no API changes that. What the app does
instead:

- holds a **screen wake lock** for the duration of a render, so the display does
  not sleep, which is the usual reason a tab gets dropped; it is re-taken
  whenever the page becomes visible again
- **warns before a navigation** throws away a render in progress
- **writes each finished export to IndexedDB immediately**, so a tab discarded
  before the file was saved costs a reload rather than the whole render

The most effective measure is simply that renders are fast enough not to need
any of this.

## Notes and limits

- **Memory.** The engine works in memory, in a 32-bit WebAssembly heap. Very
  large sources (roughly 250 MB and up) can exhaust it during a re-encode. Clip
  the section you want first, then crop it — the clip step is free.
- **Stream-copy cuts snap to keyframes.** That is inherent to cutting without
  re-encoding; the start moves back to the nearest keyframe, usually well under
  a second. Tick **Exact cut** when the precise frame matters.
- **Single-threaded on purpose.** `@ffmpeg/core-mt` would use several cores, but
  every published build (0.12.6, 0.12.9, 0.12.10 were all tested) aborts with
  `null function or function signature mismatch` as soon as a single job both
  decodes H.264 and re-encodes it — which is most of what this app does. The
  single-threaded core passes the full test suite, so that is what ships.
- **Preview vs. editing.** If the browser cannot play a format it will say
  "preview unavailable" — editing still works, because ffmpeg reads the file
  independently of the video element.

## Layout

```
index.html            markup for the whole app
src/ops.js            pure builders: settings -> ffmpeg argument arrays
src/ffmpeg-runner.js  loads the core, probes files, runs jobs, recovers from crashes
src/framer.js         crop box, rotation, and the live result preview canvas
src/main.js           wiring: file loading, tabs, jobs, results
public/sw.js          offline cache for the app shell and the engine
tests/ops.test.js     unit tests for every command
tests/e2e.mjs         full browser run-through
```
