// Edges: bezier arrows from the triggering element (or the frame edge) to the target frame.
// Drawn into one SVG inside the transformed world, so they pan/zoom with everything else.

const SVG_NS = 'http://www.w3.org/2000/svg';
const INSET = 40; // keep arrow ends away from frame corners
const VALID_EDGE_STYLES = new Set(['dashed', 'error', 'success', 'muted']);

const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
const cssEscape = (s) => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
  ? CSS.escape(String(s))
  : String(s).replace(/["\\]/g, '\\$&'));

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

// The element an edge starts from: explicit fromSelector, else the source's [data-goto="<to>"].
export const anchorSelector = (e) => e.fromSelector || `[data-goto="${cssEscape(e.to)}"]`;

export function drawEdges(svg, labelLayer, edges, frames) {
  const svgFrag = document.createDocumentFragment();
  const labelFrag = document.createDocumentFragment();

  // Count edges per (from, to) pair so parallel edges separate cleanly instead of overlapping identically.
  const pairTotals = new Map();
  const resolvedEdges = [];
  for (const e of edges) {
    const a = frames.get(e.from);
    const b = frames.get(e.to);
    if (!a || !b) {
      console.warn(`[mockery] edge ${e.from} -> ${e.to} references a missing node`);
      continue;
    }
    const key = `${e.from}\0${e.to}`;
    pairTotals.set(key, (pairTotals.get(key) || 0) + 1);
    resolvedEdges.push({ edge: e, a, b, key });
  }

  const pairSeen = new Map();
  for (const { edge: e, a, b, key } of resolvedEdges) {
    const idx = pairSeen.get(key) || 0;
    pairSeen.set(key, idx + 1);
    const total = pairTotals.get(key) || 1;
    const parallelOffset = (idx - (total - 1) / 2) * 36;

    const modClasses = String(e.style || '')
      .split(/\s+/)
      .filter((s) => VALID_EDGE_STYLES.has(s))
      .map((s) => `edge--${s}`);

    const r = route(a, b, a.anchors.get(anchorSelector(e)), parallelOffset);
    const g = svgEl('g', { class: ['edge', ...modClasses].join(' ') });

    if (r.anchor) {
      g.appendChild(svgEl('rect', {
        class: 'edge-anchor',
        x: r.anchor.x - 4,
        y: r.anchor.y - 4,
        width: r.anchor.w + 8,
        height: r.anchor.h + 8,
        rx: 10,
      }));
    }
    if (r.lead) {
      g.appendChild(svgEl('path', { class: 'edge-lead', d: r.lead }));
    }
    g.appendChild(svgEl('path', { class: 'edge-line', d: r.d }));

    const head = svgEl('path', { class: 'edge-head', d: 'M0 0L-14 -7L-14 7Z' });
    head.style.transform = `translate(${r.end.x}px,${r.end.y}px) rotate(${r.angle}deg) scale(var(--k))`;
    g.appendChild(head);

    svgFrag.appendChild(g);

    if (e.label) {
      const label = document.createElement('div');
      label.className = ['edge-label', ...modClasses].join(' ');
      label.style.left = `${r.mid.x}px`;
      label.style.top = `${r.mid.y}px`;
      label.textContent = String(e.label);
      labelFrag.appendChild(label);
    }
  }

  svg.replaceChildren(svgFrag);
  labelLayer.replaceChildren(labelFrag);
}

function route(a, b, anchor, parallelOffset = 0) {
  const S = a.outer;
  const T = b.outer;
  const A = anchor && { x: a.node.x + anchor.x, y: a.node.y + anchor.y, w: anchor.w, h: anchor.h };

  // Self-loop: curve cleanly outside the right edge of the frame and re-enter lower down.
  if (a === b) {
    const loopSpan = Math.min(120, Math.max(48, S.h * 0.25));
    const exitY = A
      ? clamp(A.y + A.h / 2, S.y + INSET, S.y + S.h - INSET - 32)
      : clamp(S.y + S.h * 0.35 + parallelOffset * 0.6, S.y + INSET, S.y + S.h - INSET - 32);
    const endY = clamp(exitY + loopSpan, S.y + INSET + 32, S.y + S.h - INSET);
    const x = S.x + S.w;
    const start = A ? { x: A.x + A.w, y: exitY } : { x, y: exitY };
    const exit = { x, y: exitY };
    const end = { x, y: endY };
    const reach = 100 + Math.abs(parallelOffset) * 1.4;
    const c1 = { x: x + reach, y: exitY - 24 };
    const c2 = { x: x + reach, y: endY + 24 };
    const tail = { x: end.x + 4, y: end.y };

    return {
      lead: A && `M${start.x} ${start.y} L${exit.x} ${exit.y}`,
      d: `M${exit.x} ${exit.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${tail.x} ${tail.y}`,
      end,
      angle: 180,
      mid: {
        x: (exit.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
        y: (exit.y + 3 * c1.y + 3 * c2.y + end.y) / 8,
      },
      anchor: A,
    };
  }

  // Leave horizontally if the frames are side by side, vertically if they are stacked.
  const gapX = Math.max(T.x - (S.x + S.w), S.x - (T.x + T.w));
  const gapY = Math.max(T.y - (S.y + S.h), S.y - (T.y + T.h));
  const horiz = gapX >= gapY;
  const sign = (horiz ? Math.sign(T.x + T.w / 2 - S.x - S.w / 2) : Math.sign(T.y + T.h / 2 - S.y - S.h / 2)) || 1;

  let start, exit, end;
  if (horiz) {
    const y = A
      ? clamp(A.y + A.h / 2, S.y, S.y + S.h)
      : clamp(T.y + T.h / 2 + parallelOffset * 0.4, S.y + INSET, S.y + S.h - INSET);
    exit = { x: sign > 0 ? S.x + S.w : S.x, y };
    start = A ? { x: sign > 0 ? A.x + A.w : A.x, y } : exit;
    end = {
      x: sign > 0 ? T.x : T.x + T.w,
      y: clamp(y + parallelOffset * 0.4, T.y + INSET, T.y + T.h - INSET),
    };
  } else {
    const x = A
      ? clamp(A.x + A.w / 2, S.x, S.x + S.w)
      : clamp(T.x + T.w / 2 + parallelOffset * 0.4, S.x + INSET, S.x + S.w - INSET);
    exit = { x, y: sign > 0 ? S.y + S.h : S.y };
    start = A ? { x, y: sign > 0 ? A.y + A.h : A.y } : exit;
    // Arrows entering from above land right of center so they miss the frame's title label.
    end = {
      x: clamp(x + parallelOffset * 0.4, sign > 0 ? T.x + T.w / 2 : T.x + INSET, T.x + T.w - INSET),
      y: sign > 0 ? T.y : T.y + T.h,
    };
  }

  const pull = Math.max(48, (horiz ? Math.abs(end.x - exit.x) : Math.abs(end.y - exit.y)) / 2);
  const c1 = horiz
    ? { x: exit.x + sign * pull, y: exit.y + parallelOffset }
    : { x: exit.x + parallelOffset, y: exit.y + sign * pull };
  const c2 = horiz
    ? { x: end.x - sign * pull, y: end.y + parallelOffset }
    : { x: end.x + parallelOffset, y: end.y - sign * pull };
  const tail = horiz ? { x: end.x - sign * 4, y: end.y } : { x: end.x, y: end.y - sign * 4 };

  return {
    // A light straight lead-out from the button to the frame edge, then the curve to the target.
    lead: A && `M${start.x} ${start.y} L${exit.x} ${exit.y}`,
    d: `M${exit.x} ${exit.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${tail.x} ${tail.y}`,
    end,
    angle: horiz ? (sign > 0 ? 0 : 180) : (sign > 0 ? 90 : -90),
    mid: { x: (exit.x + 3 * c1.x + 3 * c2.x + end.x) / 8, y: (exit.y + 3 * c1.y + 3 * c2.y + end.y) / 8 },
    anchor: A,
  };
}
