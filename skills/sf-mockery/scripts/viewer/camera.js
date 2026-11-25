// Camera: a single translate+scale transform on #world. Pan, zoom toward the cursor,
// animated fits, and persistence so reloads never reset the view.

const MIN_SCALE = 0.02;
const MAX_SCALE = 4;
const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

function safeReadStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeWriteStorage(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore file:// or private-mode restrictions */ }
}

export function createCamera(viewport, world, { storeKey, onChange, onTap }) {
  const cam = { x: 0, y: 0, s: 1 };
  let raf = 0, anim = 0, settleTimer = 0, saveTimer = 0;
  let pendingResizeObserver = null;

  function render() {
    raf = 0;
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.s})`;
    let grid = 24 * cam.s;
    while (grid < 12) grid *= 4;
    viewport.style.backgroundSize = `${grid}px ${grid}px`;
    viewport.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
    // GPU-layer the world only while moving; dropping it afterwards re-rasterizes text crisply.
    world.classList.add('is-moving');
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => world.classList.remove('is-moving'), 160);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => safeWriteStorage(storeKey, JSON.stringify(cam)), 200);
    onChange(cam);
  }

  function set(x, y, s) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(s) || !(s > 0)) return;
    cam.x = x; cam.y = y; cam.s = clampScale(s);
    raf ||= requestAnimationFrame(render);
  }

  function zoomAt(cx, cy, s) {
    if (!Number.isFinite(s) || !(s > 0)) return;
    const k = clampScale(s) / cam.s;
    set(cx - (cx - cam.x) * k, cy - (cy - cam.y) * k, cam.s * k);
  }

  const size = () => [viewport.clientWidth, viewport.clientHeight];
  const stop = () => { cancelAnimationFrame(anim); anim = 0; };

  function zoomBy(factor) {
    stop();
    const [w, h] = size();
    zoomAt(w / 2, h / 2, cam.s * factor);
  }

  // Interpolate the world-space center linearly and the scale geometrically.
  function animateTo(t, ms = 320) {
    stop();
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      set(t.x, t.y, t.s);
      return;
    }
    const [w, h] = size();
    const from = { cx: (w / 2 - cam.x) / cam.s, cy: (h / 2 - cam.y) / cam.s, ls: Math.log(cam.s) };
    const to = { cx: (w / 2 - t.x) / t.s, cy: (h / 2 - t.y) / t.s, ls: Math.log(t.s) };
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = 1 - (1 - p) ** 3;
      const s = Math.exp(from.ls + (to.ls - from.ls) * e);
      set(w / 2 - (from.cx + (to.cx - from.cx) * e) * s, h / 2 - (from.cy + (to.cy - from.cy) * e) * s, s);
      anim = p < 1 ? requestAnimationFrame(step) : 0;
    };
    anim = requestAnimationFrame(step);
  }

  function fit(r, opts = {}) {
    if (!r || !(r.w > 0) || !(r.h > 0) || !Number.isFinite(r.x) || !Number.isFinite(r.y)) return;
    const { pad = 48, animate = true, maxScale = 1 } = opts;
    const [w, h] = size();
    if (!(w > 0) || !(h > 0)) { // not laid out yet (e.g. a tab opened hidden): fit once it has a size
      if (pendingResizeObserver) {
        pendingResizeObserver.disconnect();
        pendingResizeObserver = null;
      }
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => {
          if (viewport.clientWidth > 0 && viewport.clientHeight > 0) {
            ro.disconnect();
            if (pendingResizeObserver === ro) pendingResizeObserver = null;
            fit(r, opts);
          }
        });
        pendingResizeObserver = ro;
        ro.observe(viewport);
      }
      return;
    }
    const availW = Math.max(1, w - pad * 2);
    const availH = Math.max(1, h - pad * 2);
    const s = clampScale(Math.min(availW / r.w, availH / r.h, maxScale));
    if (!Number.isFinite(s) || !(s > 0)) return;
    const target = { x: w / 2 - (r.x + r.w / 2) * s, y: h / 2 - (r.y + r.h / 2) * s, s };
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return;
    if (animate) animateTo(target);
    else { stop(); set(target.x, target.y, target.s); }
  }

  function restore() {
    try {
      const raw = safeReadStorage(storeKey);
      const c = raw ? JSON.parse(raw) : null;
      if (c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.s) && c.s > 0) {
        set(c.x, c.y, c.s);
        return true;
      }
    } catch { /* ignore corrupt state */ }
    return false;
  }

  // Trackpad two-finger scroll pans; pinch (ctrlKey) or cmd/ctrl+wheel zooms toward the cursor.
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    stop();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.clientHeight : 1;
    if (e.ctrlKey || e.metaKey) {
      const dy = Math.max(-60, Math.min(60, e.deltaY * unit));
      zoomAt(e.clientX, e.clientY, cam.s * Math.exp(-dy * 0.01));
    } else {
      set(cam.x - e.deltaX * unit, cam.y - e.deltaY * unit, cam.s);
    }
  }, { passive: false });

  // Safari reports trackpad pinch as gesture events instead of ctrl+wheel.
  let gestureStart = 1;
  viewport.addEventListener('gesturestart', (e) => { e.preventDefault(); stop(); gestureStart = cam.s; });
  viewport.addEventListener('gesturechange', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, gestureStart * e.scale); });

  // Drag anywhere to pan; a press without movement is a tap (select / follow link).
  let drag = null;
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 1) e.preventDefault();
    stop();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false, path: e.composedPath() };
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      try { viewport.setPointerCapture(e.pointerId); } catch { /* ignore synthetic/detached pointers */ }
      viewport.classList.add('is-panning');
    }
    set(drag.cx + dx, drag.cy + dy, cam.s);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && e.type === 'pointerup') onTap(drag.path);
    viewport.classList.remove('is-panning');
    drag = null;
  };
  viewport.addEventListener('pointerup', end);
  viewport.addEventListener('pointercancel', end);
  viewport.addEventListener('lostpointercapture', end);
  addEventListener('resize', () => set(cam.x, cam.y, cam.s));

  return {
    cam,
    fit,
    zoomBy,
    restore,
    pan: (dx, dy) => { stop(); set(cam.x + dx, cam.y + dy, cam.s); },
    zoomTo: (s) => zoomBy(s / cam.s),
  };
}
