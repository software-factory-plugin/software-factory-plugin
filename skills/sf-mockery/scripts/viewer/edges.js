// Edges: bezier arrows from the triggering element (or the frame edge) to the target frame.
// Drawn into one SVG inside the transformed world, so they pan/zoom with everything else.

const INSET = 40; // keep arrow ends away from frame corners
const escEdge = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));

// The element an edge starts from: explicit fromSelector, else the source's [data-goto="<to>"].
export const anchorSelector = (e) => e.fromSelector || `[data-goto="${e.to}"]`;

export function drawEdges(svg, labelLayer, edges, frames) {
  let paths = '';
  let labels = '';
  for (const e of edges) {
    const a = frames.get(e.from);
    const b = frames.get(e.to);
    if (!a || !b) { console.warn(`[mockery] edge ${e.from} -> ${e.to} references a missing node`); continue; }
    const mods = (e.style || '').split(/\s+/).filter(Boolean).map((s) => `edge--${s}`).join(' ');
    const r = route(a, b, a.anchors.get(anchorSelector(e)));
    paths += `<g class="edge ${mods}">`
      + (r.anchor ? `<rect class="edge-anchor" x="${r.anchor.x - 4}" y="${r.anchor.y - 4}" width="${r.anchor.w + 8}" height="${r.anchor.h + 8}" rx="10"/>` : '')
      + (r.lead ? `<path class="edge-lead" d="${r.lead}"/>` : '')
      + `<path class="edge-line" d="${r.d}"/>`
      + `<path class="edge-head" d="M0 0L-14 -7L-14 7Z" style="transform:translate(${r.end.x}px,${r.end.y}px) rotate(${r.angle}deg) scale(var(--k))"/>`
      + '</g>';
    if (e.label) labels += `<div class="edge-label ${mods}" style="left:${r.mid.x}px;top:${r.mid.y}px">${escEdge(e.label)}</div>`;
  }
  svg.innerHTML = paths;
  labelLayer.innerHTML = labels;
}

function route(a, b, anchor) {
  const S = a.outer;
  const T = b.outer;
  // Leave horizontally if the frames are side by side, vertically if they are stacked.
  const gapX = Math.max(T.x - (S.x + S.w), S.x - (T.x + T.w));
  const gapY = Math.max(T.y - (S.y + S.h), S.y - (T.y + T.h));
  const horiz = gapX >= gapY;
  const sign = (horiz ? Math.sign(T.x + T.w / 2 - S.x - S.w / 2) : Math.sign(T.y + T.h / 2 - S.y - S.h / 2)) || 1;
  const A = anchor && { x: a.node.x + anchor.x, y: a.node.y + anchor.y, w: anchor.w, h: anchor.h };

  let start, exit, end;
  if (horiz) {
    const y = A ? clamp(A.y + A.h / 2, S.y, S.y + S.h) : clamp(T.y + T.h / 2, S.y + INSET, S.y + S.h - INSET);
    exit = { x: sign > 0 ? S.x + S.w : S.x, y };
    start = A ? { x: sign > 0 ? A.x + A.w : A.x, y } : exit;
    end = { x: sign > 0 ? T.x : T.x + T.w, y: clamp(y, T.y + INSET, T.y + T.h - INSET) };
  } else {
    const x = A ? clamp(A.x + A.w / 2, S.x, S.x + S.w) : clamp(T.x + T.w / 2, S.x + INSET, S.x + S.w - INSET);
    exit = { x, y: sign > 0 ? S.y + S.h : S.y };
    start = A ? { x, y: sign > 0 ? A.y + A.h : A.y } : exit;
    // Arrows entering from above land right of center so they miss the frame's title label.
    end = { x: clamp(x, sign > 0 ? T.x + T.w / 2 : T.x + INSET, T.x + T.w - INSET), y: sign > 0 ? T.y : T.y + T.h };
  }

  const pull = Math.max(48, (horiz ? Math.abs(end.x - exit.x) : Math.abs(end.y - exit.y)) / 2);
  const c1 = horiz ? { x: exit.x + sign * pull, y: exit.y } : { x: exit.x, y: exit.y + sign * pull };
  const c2 = horiz ? { x: end.x - sign * pull, y: end.y } : { x: end.x, y: end.y - sign * pull };
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
