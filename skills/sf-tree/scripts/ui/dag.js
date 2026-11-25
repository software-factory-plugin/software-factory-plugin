// DAG layout, scope-aware Critical Path computation, and lightweight CSS class-toggle hover highlighting.

export const P_NODE_W = 196;
export const P_NODE_H = 114;
export const P_COL_GAP = 40;
export const P_PAD_X = 24;
export const P_PAD_Y = 74;
export const P_ROW_GAP = 72;

export const PIPELINE_LAYOUT = Object.freeze({
  vision: { col: 0, row: 0 },
  "market-research": { col: 1, row: 0 },
  brd: { col: 2, row: 0 },
  prd: { col: 3, row: 0 },
  ux: { col: 4, row: 0 },
  ui: { col: 5, row: 0 },
  mockery: { col: 5, row: 1 },
  architecture: { col: 6, row: 0 },
  specs: { col: 7, row: 0 },
});

export const W_NODE_W = 224;
export const W_NODE_H = 114;
export const W_COL_GAP = 56;
export const W_ROW_GAP = 22;
export const W_PAD_X = 28;
export const W_PAD_Y = 52;

const SVG_NS = "http://www.w3.org/2000/svg";

export function pipelineNodeRect(phase) {
  const pos = PIPELINE_LAYOUT[phase] || { col: 0, row: 0 };
  const x = P_PAD_X + pos.col * (P_NODE_W + P_COL_GAP);
  const y = P_PAD_Y + pos.row * (P_NODE_H + P_ROW_GAP);
  return { x, y, w: P_NODE_W, h: P_NODE_H, col: pos.col, row: pos.row };
}

export function computeAncestorsAndDescendants(focusId, edges) {
  const up = new Set();
  const down = new Set();
  if (!focusId) return { up, down };

  const qUp = [focusId];
  while (qUp.length) {
    const cur = qUp.shift();
    for (const e of edges) {
      if (e.to === cur && !up.has(e.from) && e.from !== focusId) {
        up.add(e.from);
        qUp.push(e.from);
      }
    }
  }

  const qDown = [focusId];
  while (qDown.length) {
    const cur = qDown.shift();
    for (const e of edges) {
      if (e.from === cur && !down.has(e.to) && e.to !== focusId) {
        down.add(e.to);
        qDown.push(e.to);
      }
    }
  }
  return { up, down };
}

export function computePipelineBlastSet(nodes, edges) {
  const blastNodes = new Set();
  const byPhase = new Map(nodes.map((n) => [n.phase, n]));
  for (const n of nodes) {
    if (n.is_stale || n.status === "invalid" || n.status === "review_stale") {
      blastNodes.add(n.phase);
    }
  }
  const blastEdges = new Set();
  for (let i = 0; i < edges.length; i += 1) {
    const e = edges[i];
    const toNode = byPhase.get(e.to);
    const fromNode = byPhase.get(e.from);
    if (toNode && toNode.is_stale && fromNode && fromNode.exists) {
      if (
        fromNode.is_stale ||
        !fromNode.state_valid ||
        (toNode.stale_reasons || []).some((r) => r.includes(fromNode.file))
      ) {
        blastEdges.add(i);
        blastNodes.add(fromNode.phase);
      }
    }
  }
  return { blastNodes, blastEdges };
}

/**
 * Compute the remaining-work Critical Path strictly within `scopedItems` and `allEdges`.
 * Mirrors work-analyzer.mjs DP semantics:
 * - Only remaining items (`tech_status !== "done" && tech_status !== "canceled"`) participate.
 * - Weight is positive numeric `estimate` else `1` for tie-breaking unestimated chains.
 * - `points` sums only real positive `estimate` values (never exceeds scoped remaining points).
 */
export function computeScopedCriticalPath(scopedItems, allEdges) {
  const items = Array.isArray(scopedItems) ? scopedItems : [];
  const edges = Array.isArray(allEdges) ? allEdges : [];

  const isRemaining = (it) =>
    it.tech_status !== "done" && it.tech_status !== "canceled";
  const weightOf = (it) =>
    typeof it.estimate === "number" && Number.isFinite(it.estimate) && it.estimate > 0
      ? it.estimate
      : 1;

  const remaining = items.filter(isRemaining);
  if (remaining.length === 0) {
    return {
      ids: [],
      nodeSet: new Set(),
      edgeSet: new Set(),
      points: 0,
      weight: 0,
    };
  }

  const byId = new Map(remaining.map((it) => [it.id, it]));
  const rankById = new Map(remaining.map((it, idx) => [it.id, idx]));

  // Sort by tier ascending (guaranteed topological order from work-analyzer) then deterministic order.
  const ordered = [...remaining].sort((a, b) => {
    const ta = typeof a.tier === "number" ? a.tier : 0;
    const tb = typeof b.tier === "number" ? b.tier : 0;
    if (ta !== tb) return ta - tb;
    return rankById.get(a.id) - rankById.get(b.id);
  });

  const orderPos = new Map(ordered.map((it, idx) => [it.id, idx]));
  const parents = new Map(ordered.map((it) => [it.id, []]));
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    // Skip any back-edge to keep DP strictly acyclic.
    if (orderPos.get(e.from) >= orderPos.get(e.to)) continue;
    parents.get(e.to).push(e.from);
  }

  const bestWeight = new Map();
  const bestLen = new Map();
  const bestPrev = new Map();

  for (const item of ordered) {
    const w = weightOf(item);
    let bestPW = 0;
    let bestPL = 0;
    let chosenParent = null;

    for (const pid of parents.get(item.id)) {
      const pw = bestWeight.get(pid) ?? 0;
      const pl = bestLen.get(pid) ?? 0;
      if (
        pw > bestPW ||
        (pw === bestPW && pl > bestPL) ||
        (pw === bestPW &&
          pl === bestPL &&
          chosenParent !== null &&
          rankById.get(pid) < rankById.get(chosenParent))
      ) {
        bestPW = pw;
        bestPL = pl;
        chosenParent = pid;
      }
    }

    bestWeight.set(item.id, w + bestPW);
    bestLen.set(item.id, 1 + bestPL);
    bestPrev.set(item.id, chosenParent);
  }

  let bestEndId = null;
  let maxW = 0;
  let maxL = 0;
  for (const item of ordered) {
    const w = bestWeight.get(item.id) ?? 0;
    const l = bestLen.get(item.id) ?? 0;
    if (
      w > maxW ||
      (w === maxW && l > maxL) ||
      (w === maxW &&
        l === maxL &&
        bestEndId !== null &&
        rankById.get(item.id) < rankById.get(bestEndId))
    ) {
      maxW = w;
      maxL = l;
      bestEndId = item.id;
    }
  }

  const ids = [];
  let cur = bestEndId;
  while (cur) {
    ids.push(cur);
    cur = bestPrev.get(cur) || null;
  }
  ids.reverse();

  const nodeSet = new Set(ids);
  const edgeSet = new Set();
  for (let i = 0; i < ids.length - 1; i += 1) {
    edgeSet.add(`${ids[i]}\u0000${ids[i + 1]}`);
  }

  const points = ids.reduce((acc, id) => {
    const it = byId.get(id);
    const pts =
      it && typeof it.estimate === "number" && Number.isFinite(it.estimate) && it.estimate > 0
        ? it.estimate
        : 0;
    return acc + pts;
  }, 0);

  return { ids, nodeSet, edgeSet, points, weight: maxW };
}

function buildArrowMarkers(doc, markers) {
  const defs = doc.createElementNS(SVG_NS, "defs");
  for (const m of markers) {
    const marker = doc.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", m.id);
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", "7");
    marker.setAttribute("refY", "4");
    marker.setAttribute("orient", "auto");
    const poly = doc.createElementNS(SVG_NS, "polygon");
    poly.setAttribute("points", "0 1, 8 4, 0 7");
    poly.setAttribute("fill", m.color);
    marker.appendChild(poly);
    defs.appendChild(marker);
  }
  return defs;
}

function createEl(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * Create a stateful DAG renderer that caches mounted node/edge elements so
 * mouseenter/mouseleave and selection/highlight toggles mutate ONLY CSS classes
 * and marker attributes (zero DOM teardown on hover).
 */
export function createDagController({
  els,
  doc = globalThis.document,
  workBadgeForStatus,
  badgeForPipelineStatus,
  onSelectWorkItem,
  onSelectPipelineNode,
  onHoverWorkChange,
  onHoverPipelineChange,
}) {
  // Cached references for lightweight highlight toggling without DOM rebuild
  let workCache = null;
  let pipelineCache = null;

  function applyWorkHighlight({ selectedWorkId, hoveredWorkId, highlightCriticalPath }) {
    if (!workCache) return;
    const { visibleIds, visibleEdges, cpNodeSet, cpEdgeSet, nodeEls, edgeEntries } = workCache;
    const focusId = hoveredWorkId || selectedWorkId;
    const activeFocus = focusId && visibleIds.has(focusId) ? focusId : null;
    const { up, down } = computeAncestorsAndDescendants(activeFocus, visibleEdges);

    for (const entry of edgeEntries) {
      const { el: pathEl, edge } = entry;
      let cls = "dag-edge";
      let markerId = "warr-default";

      if (highlightCriticalPath) {
        if (cpEdgeSet.has(`${edge.from}\u0000${edge.to}`)) {
          cls += " edge-blast";
          markerId = "warr-cp";
        } else {
          cls += " dimmed";
        }
      } else if (activeFocus) {
        const isUpEdge =
          (edge.to === activeFocus || up.has(edge.to)) &&
          (up.has(edge.from) || edge.from === activeFocus) &&
          edge.from !== activeFocus;
        const isDownEdge =
          (edge.from === activeFocus || down.has(edge.from)) &&
          (down.has(edge.to) || edge.to === activeFocus) &&
          edge.to !== activeFocus;
        if (isUpEdge) {
          cls += " edge-upstream";
          markerId = "warr-up";
        } else if (isDownEdge) {
          cls += " edge-downstream";
          markerId = "warr-down";
        } else {
          cls += " dimmed";
        }
      }

      pathEl.setAttribute("class", cls);
      pathEl.setAttribute("marker-end", `url(#${markerId})`);
    }

    for (const [id, card] of nodeEls.entries()) {
      card.classList.toggle("selected", id === selectedWorkId);
      let isBlast = false;
      let isUp = false;
      let isDown = false;
      let isDim = false;

      if (highlightCriticalPath) {
        if (cpNodeSet.has(id)) isBlast = true;
        else isDim = true;
      } else if (activeFocus && activeFocus !== id) {
        if (up.has(id)) isUp = true;
        else if (down.has(id)) isDown = true;
        else isDim = true;
      }

      card.classList.toggle("node-blast", isBlast);
      card.classList.toggle("node-upstream", isUp);
      card.classList.toggle("node-downstream", isDown);
      card.classList.toggle("dimmed", isDim);
    }
  }

  function renderWorkDag({
    wg,
    visibleItems,
    scopedCp,
    selectedWorkId,
    hoveredWorkId,
    highlightCriticalPath,
    zoom,
  }) {
    pipelineCache = null;
    els.dagStage.classList.remove("hidden");

    const visibleIds = new Set(visibleItems.map((it) => it.id));
    const visibleEdges = (wg.edges || []).filter(
      (e) => visibleIds.has(e.from) && visibleIds.has(e.to)
    );

    const projectById = new Map((wg.projects || []).map((p) => [p.id, p]));
    const milestoneById = new Map((wg.milestones || []).map((m) => [m.id, m]));

    // Group visible items by tier and compress empty tier gaps
    const tierGroups = new Map();
    for (const item of visibleItems) {
      const t = typeof item.tier === "number" ? item.tier : 0;
      if (!tierGroups.has(t)) tierGroups.set(t, []);
      tierGroups.get(t).push(item);
    }
    const sortedTiers = [...tierGroups.keys()].sort((a, b) => a - b);

    const workRects = new Map();
    let maxRows = 1;
    sortedTiers.forEach((tierNum, colIdx) => {
      const group = tierGroups.get(tierNum);
      if (group.length > maxRows) maxRows = group.length;
      group.forEach((item, rowIdx) => {
        const x = W_PAD_X + colIdx * (W_NODE_W + W_COL_GAP);
        const y = W_PAD_Y + rowIdx * (W_NODE_H + W_ROW_GAP);
        workRects.set(item.id, {
          x,
          y,
          w: W_NODE_W,
          h: W_NODE_H,
          col: colIdx,
          row: rowIdx,
          tier: tierNum,
        });
      });
    });

    const stageW =
      W_PAD_X * 2 +
      sortedTiers.length * W_NODE_W +
      Math.max(0, sortedTiers.length - 1) * W_COL_GAP;
    const stageH =
      W_PAD_Y +
      maxRows * W_NODE_H +
      Math.max(0, maxRows - 1) * W_ROW_GAP +
      48;

    els.dagStage.style.width = `${stageW}px`;
    els.dagStage.style.height = `${stageH}px`;
    els.dagStage.style.transform = `scale(${zoom})`;

    els.dagEdges.setAttribute("width", String(stageW));
    els.dagEdges.setAttribute("height", String(stageH));
    els.dagEdges.setAttribute("viewBox", `0 0 ${stageW} ${stageH}`);
    els.dagEdges.textContent = "";

    els.dagEdges.appendChild(
      buildArrowMarkers(doc, [
        { id: "warr-default", color: "var(--edge-required)" },
        { id: "warr-up", color: "var(--edge-upstream)" },
        { id: "warr-down", color: "var(--edge-downstream)" },
        { id: "warr-cp", color: "var(--edge-blast)" },
      ])
    );

    const edgeEntries = [];
    for (const edge of visibleEdges) {
      const a = workRects.get(edge.from);
      const b = workRects.get(edge.to);
      if (!a || !b) continue;

      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x - 2;
      const y2 = b.y + b.h / 2;
      const dx = Math.max(36, Math.abs(x2 - x1) * 0.45);
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

      const pathEl = doc.createElementNS(SVG_NS, "path");
      pathEl.setAttribute("d", d);
      pathEl.setAttribute("data-from", edge.from);
      pathEl.setAttribute("data-to", edge.to);
      els.dagEdges.appendChild(pathEl);
      edgeEntries.push({ el: pathEl, edge });
    }

    els.dagNodes.textContent = "";
    sortedTiers.forEach((tierNum, colIdx) => {
      const x = W_PAD_X + colIdx * (W_NODE_W + W_COL_GAP);
      const hdr = createEl(doc, "div", "tier-header", `Tier ${tierNum}`);
      hdr.style.left = `${x}px`;
      els.dagNodes.appendChild(hdr);
    });

    const cpNodeSet = scopedCp?.nodeSet || new Set();
    const cpEdgeSet = scopedCp?.edgeSet || new Set();
    const nodeEls = new Map();

    for (const item of visibleItems) {
      const r = workRects.get(item.id);
      const card = createEl(doc, "div", `dag-node work-node wstatus-${item.tech_status}`);
      card.style.left = `${r.x}px`;
      card.style.top = `${r.y}px`;
      card.setAttribute("tabindex", "0");
      card.setAttribute("role", "button");
      card.setAttribute("data-work-id", item.id);
      card.setAttribute("aria-label", `${item.id}: ${item.title} (${item.tech_status})`);

      const proj = item.project_id ? projectById.get(item.project_id) : null;
      if (proj && proj.color && /^#[0-9a-fA-F]{3,8}$/.test(proj.color)) {
        card.style.borderLeftColor = proj.color;
      }

      const head = createEl(doc, "div", "node-head");
      head.appendChild(createEl(doc, "span", "node-stage-tag", item.id));
      const rightMeta = createEl(doc, "div", "node-badges");
      if (item.estimate !== null && item.estimate !== undefined) {
        rightMeta.appendChild(createEl(doc, "span", "badge badge-neutral", `${item.estimate} pts`));
      }
      if (item.prs && item.prs.length > 0) {
        rightMeta.appendChild(
          createEl(doc, "span", "badge badge-unreviewed", `PR${item.prs.length > 1 ? ` ×${item.prs.length}` : ""}`)
        );
      }
      if (cpNodeSet.has(item.id)) {
        rightMeta.appendChild(createEl(doc, "span", "badge badge-stale", "CP"));
      }
      head.appendChild(rightMeta);
      card.appendChild(head);

      card.appendChild(createEl(doc, "div", "work-title", item.title));

      const ms = item.milestone_id ? milestoneById.get(item.milestone_id) : null;
      const scopeTag = ms ? ms.name : proj ? proj.name : "";
      if (scopeTag) {
        card.appendChild(createEl(doc, "div", "node-file", scopeTag));
      }

      const badges = createEl(doc, "div", "node-badges");
      const wb = workBadgeForStatus(item.tech_status);
      badges.appendChild(createEl(doc, "span", `badge ${wb.cls}`, wb.text));
      card.appendChild(badges);

      card.addEventListener("mouseenter", () => onHoverWorkChange(item.id));
      card.addEventListener("mouseleave", () => onHoverWorkChange(null));
      card.addEventListener("click", () => onSelectWorkItem(item.id));
      card.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          onSelectWorkItem(item.id);
        }
      });

      els.dagNodes.appendChild(card);
      nodeEls.set(item.id, card);
    }

    workCache = {
      visibleIds,
      visibleEdges,
      cpNodeSet,
      cpEdgeSet,
      nodeEls,
      edgeEntries,
    };

    applyWorkHighlight({ selectedWorkId, hoveredWorkId, highlightCriticalPath });
    return workRects;
  }

  function applyPipelineHighlight({ selectedPhase, hoveredPhase, highlightBlast }) {
    if (!pipelineCache) return;
    const { nodes, edges, nodeEls, edgeEntries } = pipelineCache;
    const focusPhase = hoveredPhase || selectedPhase;
    const { up, down } = computeAncestorsAndDescendants(focusPhase, edges);
    const { blastNodes, blastEdges } = highlightBlast
      ? computePipelineBlastSet(nodes, edges)
      : { blastNodes: new Set(), blastEdges: new Set() };

    for (const entry of edgeEntries) {
      const { el: pathEl, edge, idx, isSkip } = entry;
      const classes = ["dag-edge", `kind-${edge.kind}`];
      if (isSkip) classes.push("edge-skip");

      let markerId = "arr-default";
      if (highlightBlast) {
        if (blastEdges.has(idx)) {
          classes.push("edge-blast");
          markerId = "arr-blast";
        } else {
          classes.push("dimmed");
        }
      } else if (focusPhase) {
        const isUpEdge =
          (edge.to === focusPhase || up.has(edge.to)) &&
          (up.has(edge.from) || edge.from === focusPhase) &&
          edge.from !== focusPhase;
        const isDownEdge =
          (edge.from === focusPhase || down.has(edge.from)) &&
          (down.has(edge.to) || edge.to === focusPhase) &&
          edge.to !== focusPhase;
        if (isUpEdge) {
          classes.push("edge-upstream");
          markerId = "arr-up";
        } else if (isDownEdge) {
          classes.push("edge-downstream");
          markerId = "arr-down";
        } else {
          classes.push("dimmed");
        }
      }

      pathEl.setAttribute("class", classes.join(" "));
      pathEl.setAttribute("marker-end", `url(#${markerId})`);
    }

    for (const [phase, card] of nodeEls.entries()) {
      card.classList.toggle("selected", phase === selectedPhase);
      let isBlast = false;
      let isUp = false;
      let isDown = false;
      let isDim = false;

      if (highlightBlast) {
        if (blastNodes.has(phase)) isBlast = true;
        else isDim = true;
      } else if (focusPhase && focusPhase !== phase) {
        if (up.has(phase)) isUp = true;
        else if (down.has(phase)) isDown = true;
        else isDim = true;
      }

      card.classList.toggle("node-blast", isBlast);
      card.classList.toggle("node-upstream", isUp);
      card.classList.toggle("node-downstream", isDown);
      card.classList.toggle("dimmed", isDim);
    }
  }

  function renderPipelineDag({
    graph,
    nodes,
    edges,
    selectedPhase,
    hoveredPhase,
    highlightBlast,
    zoom,
  }) {
    workCache = null;
    if (!graph || nodes.length === 0) return;

    const maxCol = Math.max(...nodes.map((n) => PIPELINE_LAYOUT[n.phase]?.col ?? 0));
    const maxRow = Math.max(...nodes.map((n) => PIPELINE_LAYOUT[n.phase]?.row ?? 0));
    const stageW = P_PAD_X * 2 + (maxCol + 1) * P_NODE_W + maxCol * P_COL_GAP;
    const stageH = P_PAD_Y + (maxRow + 1) * P_NODE_H + maxRow * P_ROW_GAP + 68;

    els.dagStage.style.width = `${stageW}px`;
    els.dagStage.style.height = `${stageH}px`;
    els.dagStage.style.transform = `scale(${zoom})`;

    els.dagEdges.setAttribute("width", String(stageW));
    els.dagEdges.setAttribute("height", String(stageH));
    els.dagEdges.setAttribute("viewBox", `0 0 ${stageW} ${stageH}`);
    els.dagEdges.textContent = "";

    els.dagEdges.appendChild(
      buildArrowMarkers(doc, [
        { id: "arr-default", color: "var(--edge-required)" },
        { id: "arr-up", color: "var(--edge-upstream)" },
        { id: "arr-down", color: "var(--edge-downstream)" },
        { id: "arr-blast", color: "var(--edge-blast)" },
      ])
    );

    const edgeEntries = [];
    edges.forEach((edge, idx) => {
      const a = pipelineNodeRect(edge.from);
      const b = pipelineNodeRect(edge.to);
      const colSpan = b.col - a.col;
      let d;
      const isSkip = colSpan > 1;

      if (colSpan === 1 && a.row === b.row) {
        const x1 = a.x + a.w;
        const y1 = a.y + a.h / 2;
        const x2 = b.x - 2;
        const y2 = b.y + b.h / 2;
        const cx = (x1 + x2) / 2;
        d = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
      } else if (edge.to === "mockery" && edge.from === "ui") {
        d = `M ${a.x + a.w / 2} ${a.y + a.h} L ${b.x + b.w / 2} ${b.y - 2}`;
      } else if (edge.to === "mockery" || edge.from === "mockery") {
        const x1 = a.x + a.w;
        const y1 = a.y + a.h / 2 + (edge.to === "mockery" ? 18 : 0);
        const x2 = b.x - 2;
        const y2 = b.y + b.h / 2 + (edge.from === "mockery" ? 20 : 0);
        const dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
        d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      } else {
        const lane = Math.min(5, colSpan);
        const arcLift = 20 + lane * 11;
        const x1 = a.x + a.w * 0.72;
        const y1 = a.y;
        const x2 = b.x + b.w * 0.28;
        const y2 = b.y - 2;
        const topY = Math.max(8, Math.min(y1, y2) - arcLift);
        d = `M ${x1} ${y1} C ${x1} ${topY}, ${x2} ${topY}, ${x2} ${y2}`;
      }

      const pathEl = doc.createElementNS(SVG_NS, "path");
      pathEl.setAttribute("d", d);
      pathEl.setAttribute("data-from", edge.from);
      pathEl.setAttribute("data-to", edge.to);
      els.dagEdges.appendChild(pathEl);
      edgeEntries.push({ el: pathEl, edge, idx, isSkip });
    });

    els.dagNodes.textContent = "";
    const nodeEls = new Map();

    for (const node of nodes) {
      const r = pipelineNodeRect(node.phase);
      const card = createEl(doc, "div", "dag-node");
      card.style.left = `${r.x}px`;
      card.style.top = `${r.y}px`;
      card.setAttribute("tabindex", "0");
      card.setAttribute("role", "button");
      card.setAttribute("data-phase", node.phase);
      card.setAttribute("aria-label", `Stage ${node.stage} ${node.label} (${node.status})`);

      card.classList.add(`status-${node.status}`);
      if (node.optional) card.classList.add("optional-node");
      if (node.is_stale) card.classList.add("is-stale");

      const head = createEl(doc, "div", "node-head");
      head.appendChild(createEl(doc, "span", "node-stage-tag", `Stage ${node.stage}`));
      head.appendChild(createEl(doc, "span", "node-skill", node.skill));
      card.appendChild(head);

      card.appendChild(createEl(doc, "div", "node-label", node.label));
      card.appendChild(createEl(doc, "div", "node-file", node.file.replace("docs/factory/", "")));

      const badges = createEl(doc, "div", "node-badges");
      const stBadge = badgeForPipelineStatus(node.status);
      badges.appendChild(createEl(doc, "span", `badge ${stBadge.cls}`, stBadge.text));
      if (node.is_stale) badges.appendChild(createEl(doc, "span", "badge badge-stale", "STALE"));
      if (
        node.status !== "review_stale" &&
        (node.review_stale || (node.reviews && node.reviews[0] && node.reviews[0].is_stale)) &&
        !node.is_stale
      ) {
        badges.appendChild(createEl(doc, "span", "badge badge-stale", "REV STALE"));
      }
      if (node.phase === "mockery" && graph.mockery && graph.mockery.fidelity) {
        badges.appendChild(createEl(doc, "span", "badge badge-neutral", graph.mockery.fidelity));
      }
      if (node.warnings && node.warnings.length > 0) {
        badges.appendChild(createEl(doc, "span", "badge badge-stale", `${node.warnings.length} warn`));
      }
      card.appendChild(badges);

      card.addEventListener("mouseenter", () => onHoverPipelineChange(node.phase));
      card.addEventListener("mouseleave", () => onHoverPipelineChange(null));
      card.addEventListener("click", () => onSelectPipelineNode(node.phase));
      card.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          onSelectPipelineNode(node.phase);
        }
      });

      els.dagNodes.appendChild(card);
      nodeEls.set(node.phase, card);
    }

    pipelineCache = {
      nodes,
      edges,
      nodeEls,
      edgeEntries,
    };

    applyPipelineHighlight({ selectedPhase, hoveredPhase, highlightBlast });
  }

  return {
    renderWorkDag,
    applyWorkHighlight,
    renderPipelineDag,
    applyPipelineHighlight,
  };
}
