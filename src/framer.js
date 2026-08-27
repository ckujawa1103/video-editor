/**
 * The interactive framing surface: a rotatable video preview with a draggable
 * crop box on top, plus a live canvas that shows exactly what the export will
 * look like (including the blurred fill).
 */
import { ASPECTS, clamp, even } from './ops.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN_PX = 24; // minimum crop size, in on-screen pixels

export function createFramer({ stage, rotor, video, layer, box, canvas, onChange }) {
  const state = {
    srcW: 0,
    srcH: 0,
    rotate: 0,
    flipH: false,
    aspect: 'source',
    fill: 'trim',
    blurAmount: 14,
    bgZoom: 1.15,
    bgDim: 0.06,
    // crop, in rotated-source pixels
    crop: { x: 0, y: 0, w: 0, h: 0 },
    scale: 1,
    ready: false,
  };

  for (const h of HANDLES) {
    const el = document.createElement('span');
    el.className = `handle h-${h}`;
    el.dataset.handle = h;
    box.appendChild(el);
  }

  /** Frame size after rotation — the space the crop box lives in. */
  function rotated() {
    const swap = state.rotate === 90 || state.rotate === 270;
    return { w: swap ? state.srcH : state.srcW, h: swap ? state.srcW : state.srcH };
  }

  function ratio() {
    return ASPECTS[state.aspect]?.ratio ?? null;
  }

  /** In trim mode a fixed output aspect means the box itself must be locked. */
  function lockedRatio() {
    return state.fill === 'trim' ? ratio() : null;
  }

  function layoutStage() {
    if (!state.srcW || !state.srcH) return;
    const { w: rw, h: rh } = rotated();
    const avail = stage.getBoundingClientRect();
    const maxW = Math.max(160, avail.width || 320);
    const maxH = Math.max(160, Number(stage.dataset.maxHeight) || 420);
    const scale = Math.min(maxW / rw, maxH / rh);
    state.scale = scale;

    const dw = Math.round(rw * scale);
    const dh = Math.round(rh * scale);
    rotor.style.width = `${dw}px`;
    rotor.style.height = `${dh}px`;
    layer.style.width = `${dw}px`;
    layer.style.height = `${dh}px`;

    // The <video> keeps its own orientation and is rotated about its centre;
    // because both boxes are centred, the rotated result lands exactly on top.
    video.style.width = `${Math.round(state.srcW * scale)}px`;
    video.style.height = `${Math.round(state.srcH * scale)}px`;
    video.style.transform = `translate(-50%, -50%) rotate(${state.rotate}deg) scaleX(${state.flipH ? -1 : 1})`;
    drawBox();
  }

  function drawBox() {
    const s = state.scale;
    box.style.left = `${state.crop.x * s}px`;
    box.style.top = `${state.crop.y * s}px`;
    box.style.width = `${state.crop.w * s}px`;
    box.style.height = `${state.crop.h * s}px`;
  }

  /** Force the crop into the frame, honouring a locked aspect ratio. */
  function normalise(c = state.crop) {
    const { w: rw, h: rh } = rotated();
    if (!rw || !rh) return;
    const lock = lockedRatio();
    let { x, y, w, h } = c;

    w = clamp(w, 16, rw);
    h = clamp(h, 16, rh);
    if (lock) {
      // Fit the largest ratio-correct box that still fits inside w x h.
      if (w / h > lock) w = h * lock;
      else h = w / lock;
      if (w > rw) (w = rw), (h = rw / lock);
      if (h > rh) (h = rh), (w = rh * lock);
    }
    x = clamp(x, 0, rw - w);
    y = clamp(y, 0, rh - h);
    state.crop = { x, y, w, h };
  }

  function resetCrop() {
    const { w: rw, h: rh } = rotated();
    const lock = lockedRatio();
    let w = rw;
    let h = rh;
    if (lock) {
      if (rw / rh > lock) w = rh * lock;
      else h = rw / lock;
    }
    state.crop = { x: (rw - w) / 2, y: (rh - h) / 2, w, h };
    normalise();
    drawBox();
    emit();
  }

  /* ---------------- dragging ---------------- */

  let drag = null;

  function pointFromEvent(e) {
    const r = layer.getBoundingClientRect();
    return { x: (e.clientX - r.left) / state.scale, y: (e.clientY - r.top) / state.scale };
  }

  function onDown(e) {
    if (!state.ready) return;
    const handle = e.target?.dataset?.handle || null;
    if (!handle && e.target !== box && !box.contains(e.target)) return;
    e.preventDefault();
    e.target.setPointerCapture?.(e.pointerId);
    drag = { handle, start: pointFromEvent(e), orig: { ...state.crop } };
  }

  function onMove(e) {
    if (!drag) return;
    e.preventDefault();
    const p = pointFromEvent(e);
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    const { w: rw, h: rh } = rotated();
    const o = drag.orig;
    const lock = lockedRatio();
    const minW = MIN_PX / state.scale;

    if (!drag.handle) {
      state.crop = { ...o, x: clamp(o.x + dx, 0, rw - o.w), y: clamp(o.y + dy, 0, rh - o.h) };
    } else {
      let { x, y, w, h } = o;
      const H = drag.handle;
      if (H.includes('w')) (x = o.x + dx), (w = o.w - dx);
      if (H.includes('e')) w = o.w + dx;
      if (H.includes('n')) (y = o.y + dy), (h = o.h - dy);
      if (H.includes('s')) h = o.h + dy;

      if (w < minW) (x = H.includes('w') ? o.x + o.w - minW : x), (w = minW);
      if (h < minW) (y = H.includes('n') ? o.y + o.h - minW : y), (h = minW);

      if (lock) {
        // Drive the locked dimension from whichever edge is being dragged.
        if (H === 'n' || H === 's') w = h * lock;
        else h = w / lock;
        if (H.includes('w')) x = o.x + o.w - w;
        if (H.includes('n')) y = o.y + o.h - h;
      }

      // Keep the box inside the frame without changing its shape.
      if (x < 0) (w += x), (x = 0);
      if (y < 0) (h += y), (y = 0);
      if (x + w > rw) w = rw - x;
      if (y + h > rh) h = rh - y;
      if (lock) {
        if (w / h > lock) w = h * lock;
        else h = w / lock;
        if (H.includes('w')) x = clamp(o.x + o.w - w, 0, rw - w);
        if (H.includes('n')) y = clamp(o.y + o.h - h, 0, rh - h);
      }
      state.crop = { x, y, w, h };
    }
    drawBox();
    emit();
  }

  function onUp() {
    if (!drag) return;
    drag = null;
    normalise();
    drawBox();
    emit();
  }

  layer.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  /* ---------------- live WYSIWYG preview ---------------- */

  const off = document.createElement('canvas');
  const offCtx = off.getContext('2d', { willReadFrequently: false });
  let rafId = 0;

  function renderPreview() {
    if (!state.ready || !canvas || video.readyState < 2) return;
    const { w: rw, h: rh } = rotated();
    const k = Math.min(1, 640 / Math.max(rw, rh));
    off.width = Math.max(2, Math.round(rw * k));
    off.height = Math.max(2, Math.round(rh * k));

    // Step 1: bake rotation and flip into an offscreen frame.
    offCtx.save();
    offCtx.translate(off.width / 2, off.height / 2);
    offCtx.rotate((state.rotate * Math.PI) / 180);
    if (state.flipH) offCtx.scale(-1, 1);
    const vw = state.srcW * k;
    const vh = state.srcH * k;
    try {
      offCtx.drawImage(video, -vw / 2, -vh / 2, vw, vh);
    } catch {
      offCtx.restore();
      return;
    }
    offCtx.restore();

    // Step 2: compose the crop onto the output canvas.
    const c = state.crop;
    const sx = c.x * k;
    const sy = c.y * k;
    const sw = Math.max(1, c.w * k);
    const sh = Math.max(1, c.h * k);
    const dims = outputDims();
    const boxW = 300;
    const boxH = 380;
    const fit = Math.min(boxW / dims.width, boxH / dims.height);
    canvas.width = Math.max(2, Math.round(dims.width * fit));
    canvas.height = Math.max(2, Math.round(dims.height * fit));
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const blurring = state.fill === 'blur' && ratio();
    if (blurring) {
      const cover = Math.max(canvas.width / sw, canvas.height / sh) * state.bgZoom;
      const bw = sw * cover;
      const bh = sh * cover;
      ctx.save();
      if ('filter' in ctx) ctx.filter = `blur(${Math.max(2, (state.blurAmount / 100) * 40).toFixed(1)}px)`;
      ctx.drawImage(off, sx, sy, sw, sh, (canvas.width - bw) / 2, (canvas.height - bh) / 2, bw, bh);
      ctx.restore();
      if (state.bgDim > 0) {
        ctx.fillStyle = `rgba(0,0,0,${Math.min(0.6, state.bgDim * 2).toFixed(2)})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      const contain = Math.min(canvas.width / sw, canvas.height / sh);
      const fw = sw * contain;
      const fh = sh * contain;
      ctx.drawImage(off, sx, sy, sw, sh, (canvas.width - fw) / 2, (canvas.height - fh) / 2, fw, fh);
    } else {
      ctx.drawImage(off, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    }
  }

  function loop() {
    rafId = requestAnimationFrame(loop);
    if (!video.paused && !video.ended) renderPreview();
  }

  function outputDims() {
    const c = state.crop;
    const r = ratio();
    let w = c.w;
    let h = c.h;
    if (r) {
      if (state.fill === 'blur') {
        if (r >= c.w / c.h) (h = c.h), (w = c.h * r);
        else (w = c.w), (h = c.w / r);
      } else {
        h = c.w / r;
      }
    }
    return { width: Math.max(2, w), height: Math.max(2, h) };
  }

  function emit() {
    renderPreview();
    onChange?.(getSettings());
  }

  function getSettings() {
    const { w: rw, h: rh } = rotated();
    const c = state.crop;
    const full = Math.abs(c.w - rw) < 1 && Math.abs(c.h - rh) < 1 && c.x < 1 && c.y < 1;
    return {
      rotate: state.rotate,
      flipH: state.flipH,
      aspect: state.aspect,
      fill: state.fill,
      blurAmount: state.blurAmount,
      bgZoom: state.bgZoom,
      bgDim: state.bgDim,
      rotatedWidth: rw,
      rotatedHeight: rh,
      crop: full ? null : { x: Math.round(c.x), y: Math.round(c.y), w: even(Math.round(c.w)), h: even(Math.round(c.h)) },
      cropW: even(Math.round(c.w)),
      cropH: even(Math.round(c.h)),
    };
  }

  return {
    state,
    getSettings,
    setSource(w, h) {
      state.srcW = w;
      state.srcH = h;
      state.ready = w > 0 && h > 0;
      state.rotate = 0;
      state.flipH = false;
      layoutStage();
      resetCrop();
      if (!rafId) loop();
    },
    setRotate(deg) {
      const next = ((deg % 360) + 360) % 360;
      if (next === state.rotate) return;
      state.rotate = next;
      layoutStage();
      resetCrop();
    },
    rotateBy(delta) {
      this.setRotate(state.rotate + delta);
    },
    setFlip(on) {
      state.flipH = !!on;
      layoutStage();
      emit();
    },
    setAspect(key) {
      state.aspect = key;
      normalise();
      // A locked box may no longer fit the frame after a ratio change.
      if (lockedRatio()) resetCrop();
      else (drawBox(), emit());
    },
    setFill(mode) {
      state.fill = mode === 'blur' ? 'blur' : 'trim';
      // Both modes want a fresh box: trim wants the largest crop of the chosen
      // shape, blurred fill wants the whole frame with the gaps filled in.
      resetCrop();
    },
    setBackground({ blurAmount, bgZoom, bgDim }) {
      if (blurAmount != null) state.blurAmount = blurAmount;
      if (bgZoom != null) state.bgZoom = bgZoom;
      if (bgDim != null) state.bgDim = bgDim;
      emit();
    },
    resetCrop,
    relayout: layoutStage,
    render: renderPreview,
    destroy() {
      cancelAnimationFrame(rafId);
      rafId = 0;
      layer.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    },
  };
}
