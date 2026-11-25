// sf-tree Live Tech-Tree Viewer application controller (state, SSE, Work/Pipeline views, drawers).
import { renderSafeMarkdown } from "./markdown.js";
import { computeScopedCriticalPath, createDagController } from "./dag.js";

export const DEFAULT_MOCKERY_PREVIEW_URL = "http://127.0.0.1:5180";

const PRIORITY_NAMES = Object.freeze({
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
});

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch {
    // ignore storage failures
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function sanitizeExternalHttpsUrl(urlStr) {
  if (typeof urlStr !== "string" || !urlStr.trim()) return null;
  try {
    const u = new URL(urlStr.trim());
    if (u.protocol === "https:") return u.href;
  } catch {
    // ignore invalid URL
  }
  return null;
}

function sanitizePreviewUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (
      (u.protocol === "http:" || u.protocol === "https:") &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost")
    ) {
      return u.href;
    }
  } catch {
    // ignore invalid URL
  }
  return null;
}

function workBadgeForStatus(techStatus) {
  switch (techStatus) {
    case "done":
      return { text: "DONE", cls: "badge-pass" };
    case "in_review":
      return { text: "IN REVIEW", cls: "badge-review" };
    case "in_progress":
      return { text: "IN PROGRESS", cls: "badge-unreviewed" };
    case "ready":
      return { text: "READY", cls: "badge-unlocked" };
    case "blocked":
      return { text: "BLOCKED", cls: "badge-stale" };
    case "canceled":
      return { text: "CANCELED", cls: "badge-locked" };
    default:
      return { text: String(techStatus || "OPEN").toUpperCase(), cls: "badge-neutral" };
  }
}

function workPromptLabel(item) {
  switch (item.tech_status) {
    case "ready":
      return "Start Ready Ticket";
    case "blocked":
      return "Unblock Prerequisites";
    case "in_review":
      return "Verify & Merge PR";
    case "in_progress":
      return "Continue Implementation";
    case "done":
      return "Downstream Next Work";
    default:
      return "Ticket Action Prompt";
  }
}

function badgeForPipelineStatus(status) {
  switch (status) {
    case "reviewed_pass":
      return { text: "PASS", cls: "badge-pass" };
    case "review_stale":
      return { text: "REVIEW STALE", cls: "badge-stale" };
    case "reviewed_fail":
      return { text: "FAIL", cls: "badge-fail" };
    case "unreviewed":
      return { text: "UNREVIEWED", cls: "badge-unreviewed" };
    case "unlocked":
      return { text: "UNLOCKED", cls: "badge-unlocked" };
    case "invalid":
      return { text: "INVALID", cls: "badge-invalid" };
    default:
      return { text: "LOCKED", cls: "badge-locked" };
  }
}

function promptActionLabel(node) {
  if (node.status === "invalid") return "Repair <system_state>";
  if (node.status === "reviewed_fail") return "Fix Blocking Review Issues";
  if (node.is_stale) return "Reconcile Stale Artifact";
  if (node.status === "review_stale") return "Re-run Stale sf-review";
  if (node.status === "unlocked") return "Run Unlocked Stage";
  if (node.status === "unreviewed") {
    return node.phase === "vision" ? "Next Stage Prompt" : "Run sf-review";
  }
  if (node.reviews && node.reviews[0] && node.reviews[0].is_stale) {
    return "Re-run Stale sf-review";
  }
  return "Next Step Prompt";
}

function initApp() {
  const state = {
    viewMode: "pipeline", // "work" | "pipeline"
    userPickedView: false,

    // Pipeline state
    graph: null,
    selectedPhase: null,
    hoveredPhase: null,
    activeTab: "overview",
    showMockery: true,
    highlightBlast: false,
    artifactCache: new Map(),
    reviewCache: new Map(),
    expandedReviews: new Set(),
    artifactFetchSeq: 0,
    reviewFetchSeq: 0,
    mockeryPreviewUrl:
      safeStorageGet("sf-tree-mockery-url") || DEFAULT_MOCKERY_PREVIEW_URL,

    // Work Tech-Tree state
    workEnvelope: null, // { available, default_view, graph, error? }
    selectedWorkId: null,
    hoveredWorkId: null,
    workScope: "all", // "all" | "project:<id>" | "milestone:<id>"
    workFilter: "all", // "all" | "ready" | "active" | "blocked"
    hideDone: false,
    highlightCriticalPath: false,
    workRects: new Map(),
    scopedCp: { ids: [], nodeSet: new Set(), edgeSet: new Set(), points: 0, weight: 0 },

    zoom: 1,
    receivedInitialPipeline: false,
    receivedInitialWork: false,
  };

  const els = {
    projectName: document.getElementById("project-name"),
    workspaceRoot: document.getElementById("workspace-root"),
    btnViewWork: document.getElementById("btn-view-work"),
    btnViewPipeline: document.getElementById("btn-view-pipeline"),

    pipelineMetrics: document.getElementById("pipeline-metrics"),
    metricCoreText: document.getElementById("metric-core-text"),
    metricCoreFill: document.getElementById("metric-core-fill"),
    metricUnlocked: document.getElementById("metric-unlocked"),
    metricStale: document.getElementById("metric-stale"),
    metricReviewStale: document.getElementById("metric-review-stale"),
    metricFail: document.getElementById("metric-fail"),
    metricInvalid: document.getElementById("metric-invalid"),

    workMetrics: document.getElementById("work-metrics"),
    wmetricDoneText: document.getElementById("wmetric-done-text"),
    wmetricDoneFill: document.getElementById("wmetric-done-fill"),
    wmetricReady: document.getElementById("wmetric-ready"),
    wmetricActive: document.getElementById("wmetric-active"),
    wmetricBlocked: document.getElementById("wmetric-blocked"),
    wmetricCp: document.getElementById("wmetric-cp"),

    btnMockery: document.getElementById("btn-toggle-mockery"),
    btnBlast: document.getElementById("btn-toggle-blast"),
    btnCp: document.getElementById("btn-toggle-cp"),
    btnWorkRefresh: document.getElementById("btn-work-refresh"),
    btnTheme: document.getElementById("btn-theme"),
    ssePill: document.getElementById("sse-pill"),
    sseLabel: document.getElementById("sse-label"),

    workSubbar: document.getElementById("work-subbar"),
    scopeSelect: document.getElementById("scope-select"),
    btnHideDone: document.getElementById("btn-hide-done"),
    workScopePoints: document.getElementById("work-scope-points"),

    canvasScroller: document.getElementById("canvas-scroller"),
    dagStage: document.getElementById("dag-stage"),
    dagEdges: document.getElementById("dag-edges"),
    dagNodes: document.getElementById("dag-nodes"),
    workEmptyHost: document.getElementById("work-empty-host"),
    legendItems: document.getElementById("legend-items"),

    inspectorHeader: document.getElementById("inspector-header"),
    pipelineTabBar: document.getElementById("pipeline-tab-bar"),
    inspectorBody: document.getElementById("inspector-body"),
    tabBtnReviews: document.getElementById("tab-btn-reviews"),
    toast: document.getElementById("toast"),
  };

  // Theme initialization (single :root[data-theme="dark"] block in styles.css)
  const darkMediaQuery =
    window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function applyEffectiveTheme() {
    const saved = safeStorageGet("sf-tree-theme");
    const theme =
      saved === "light" || saved === "dark"
        ? saved
        : darkMediaQuery && darkMediaQuery.matches
          ? "dark"
          : "light";
    document.documentElement.setAttribute("data-theme", theme);
    els.btnTheme.textContent = theme === "dark" ? "Light Mode" : "Dark Mode";
  }

  function initTheme() {
    applyEffectiveTheme();
    if (darkMediaQuery && typeof darkMediaQuery.addEventListener === "function") {
      darkMediaQuery.addEventListener("change", () => {
        if (!safeStorageGet("sf-tree-theme")) {
          applyEffectiveTheme();
        }
      });
    }
  }

  els.btnTheme.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    safeStorageSet("sf-tree-theme", next);
    applyEffectiveTheme();
  });

  // Toast & clipboard
  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove("visible");
    }, 2200);
  }

  async function copyText(text, label) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      showToast(label || "Copied to clipboard");
    } catch {
      showToast("Copy failed — select text manually");
    }
  }

  const dag = createDagController({
    els,
    doc: document,
    workBadgeForStatus,
    badgeForPipelineStatus,
    onSelectWorkItem: (id) => selectWorkItem(id),
    onSelectPipelineNode: (phase) => selectPipelineNode(phase),
    onHoverWorkChange: (id) => {
      if (state.hoveredWorkId === id) return;
      state.hoveredWorkId = id;
      dag.applyWorkHighlight({
        selectedWorkId: state.selectedWorkId,
        hoveredWorkId: state.hoveredWorkId,
        highlightCriticalPath: state.highlightCriticalPath,
      });
    },
    onHoverPipelineChange: (phase) => {
      if (state.hoveredPhase === phase) return;
      state.hoveredPhase = phase;
      dag.applyPipelineHighlight({
        selectedPhase: state.selectedPhase,
        hoveredPhase: state.hoveredPhase,
        highlightBlast: state.highlightBlast,
      });
    },
  });

  // View Switching
  function setViewMode(mode, { fromUser = false, autoFit = false } = {}) {
    if (fromUser) state.userPickedView = true;
    state.viewMode = mode === "work" ? "work" : "pipeline";

    const isWork = state.viewMode === "work";
    els.btnViewWork.classList.toggle("active", isWork);
    els.btnViewWork.setAttribute("aria-selected", String(isWork));
    els.btnViewPipeline.classList.toggle("active", !isWork);
    els.btnViewPipeline.setAttribute("aria-selected", String(!isWork));

    els.pipelineMetrics.classList.toggle("hidden", isWork);
    els.workMetrics.classList.toggle("hidden", !isWork);
    els.btnMockery.classList.toggle("hidden", isWork);
    els.btnBlast.classList.toggle("hidden", isWork);
    els.btnCp.classList.toggle("hidden", !isWork);
    els.workSubbar.classList.toggle("hidden", !isWork);
    els.pipelineTabBar.classList.toggle("hidden", isWork);

    updateWorkRefreshVisibility();
    renderLegend();
    renderActiveView({ preserveScroll: false });

    if (autoFit) {
      requestAnimationFrame(() => fitZoom());
    }
  }

  function updateWorkRefreshVisibility() {
    const liveSupported = Boolean(
      state.viewMode === "work" &&
        state.workEnvelope?.graph?.source?.live_refresh_supported
    );
    els.btnWorkRefresh.classList.toggle("hidden", !liveSupported);
  }

  function renderLegend() {
    els.legendItems.textContent = "";
    if (state.viewMode === "work") {
      const addLine = (cls, label) => {
        const item = el("span", "legend-item");
        item.appendChild(el("span", `legend-line ${cls}`));
        item.appendChild(document.createTextNode(label));
        els.legendItems.appendChild(item);
      };
      addLine("", "Blocks dependency");
      addLine("cp", "Critical Path");
      [
        ["badge-pass", "DONE"],
        ["badge-review", "IN REVIEW"],
        ["badge-unreviewed", "IN PROGRESS"],
        ["badge-unlocked", "READY"],
        ["badge-stale", "BLOCKED"],
      ].forEach(([cls, txt]) => {
        const item = el("span", "legend-item");
        item.appendChild(el("span", `badge ${cls}`, txt));
        els.legendItems.appendChild(item);
      });
      return;
    }

    const req = el("span", "legend-item");
    req.appendChild(el("span", "legend-line"));
    req.appendChild(document.createTextNode("Required edge"));
    els.legendItems.appendChild(req);

    const opt = el("span", "legend-item");
    opt.appendChild(el("span", "legend-line dashed"));
    opt.appendChild(document.createTextNode("Recommended / Optional"));
    els.legendItems.appendChild(opt);

    [
      ["badge-pass", "PASS"],
      ["badge-fail", "FAIL"],
      ["badge-stale", "STALE"],
      ["badge-unreviewed", "UNREVIEWED"],
      ["badge-unlocked", "UNLOCKED"],
      ["badge-locked", "LOCKED"],
    ].forEach(([cls, txt]) => {
      const item = el("span", "legend-item");
      item.appendChild(el("span", `badge ${cls}`, txt));
      els.legendItems.appendChild(item);
    });
  }

  function renderActiveView({ preserveScroll = true } = {}) {
    if (state.viewMode === "work") {
      renderWorkSummary();
      renderWorkViewDag();
      renderWorkInspector({ preserveScroll });
    } else {
      els.workEmptyHost.textContent = "";
      els.dagStage.classList.remove("hidden");
      renderPipelineSummary();
      renderPipelineViewDag();
      renderPipelineInspector({ preserveScroll });
    }
  }

  // =========================================================================
  // WORK TECH-TREE VIEW
  // =========================================================================
  function populateScopeDropdown(wg) {
    const prev = state.workScope;
    els.scopeSelect.textContent = "";
    const optAll = el("option", "", "All Active Projects");
    optAll.value = "all";
    els.scopeSelect.appendChild(optAll);

    const projects = wg.projects || [];
    const milestones = wg.milestones || [];
    const msByProj = new Map();
    for (const m of milestones) {
      const pid = m.project_id || "__none__";
      if (!msByProj.has(pid)) msByProj.set(pid, []);
      msByProj.get(pid).push(m);
    }

    const validValues = new Set(["all"]);
    for (const p of projects) {
      const pOpt = el("option", "", `Project: ${p.name}`);
      pOpt.value = `project:${p.id}`;
      validValues.add(pOpt.value);
      els.scopeSelect.appendChild(pOpt);

      const pMs = msByProj.get(p.id) || [];
      for (const m of pMs) {
        const mOpt = el("option", "", `  ↳ ${p.name} — ${m.name}`);
        mOpt.value = `milestone:${m.id}`;
        validValues.add(mOpt.value);
        els.scopeSelect.appendChild(mOpt);
      }
    }

    state.workScope = validValues.has(prev) ? prev : "all";
    els.scopeSelect.value = state.workScope;
  }

  function getScopedWorkItems() {
    const wg = state.workEnvelope?.graph;
    if (!wg) return [];
    return (wg.items || []).filter((item) => {
      if (state.workScope.startsWith("project:")) {
        return item.project_id === state.workScope.slice("project:".length);
      }
      if (state.workScope.startsWith("milestone:")) {
        return item.milestone_id === state.workScope.slice("milestone:".length);
      }
      return true;
    });
  }

  function getFilteredWorkItems() {
    return getScopedWorkItems().filter((item) => {
      if (state.hideDone && (item.tech_status === "done" || item.tech_status === "canceled")) {
        return false;
      }
      if (state.workFilter === "ready" && item.tech_status !== "ready") return false;
      if (
        state.workFilter === "active" &&
        item.tech_status !== "in_progress" &&
        item.tech_status !== "in_review"
      ) {
        return false;
      }
      if (state.workFilter === "blocked" && item.tech_status !== "blocked") return false;
      return true;
    });
  }

  function refreshScopedCriticalPath() {
    const wg = state.workEnvelope?.graph;
    if (!wg) {
      state.scopedCp = { ids: [], nodeSet: new Set(), edgeSet: new Set(), points: 0, weight: 0 };
      return state.scopedCp;
    }
    if (state.workScope === "all") {
      const ids = wg.summary?.critical_path_ids || [];
      const edgeSet = new Set();
      for (let i = 0; i < ids.length - 1; i += 1) {
        edgeSet.add(`${ids[i]}\u0000${ids[i + 1]}`);
      }
      state.scopedCp = {
        ids,
        nodeSet: new Set(ids),
        edgeSet,
        points: wg.summary?.critical_path_points ?? 0,
        weight: wg.summary?.critical_path_weight ?? 0,
      };
      return state.scopedCp;
    }
    state.scopedCp = computeScopedCriticalPath(getScopedWorkItems(), wg.edges || []);
    return state.scopedCp;
  }

  function renderWorkSummary() {
    const env = state.workEnvelope;
    const wg = env?.graph;
    if (!wg) {
      els.projectName.textContent = "Work Tech-Tree";
      els.workspaceRoot.textContent = env?.error ? "work-graph error" : "no work-graph configured";
      els.wmetricDoneText.textContent = "0/0 Done";
      els.wmetricDoneFill.style.width = "0%";
      els.wmetricReady.textContent = "Ready: 0";
      els.wmetricActive.textContent = "Active: 0";
      els.wmetricBlocked.textContent = "Blocked: 0";
      els.wmetricCp.textContent = "Critical Path: 0 pts";
      els.workScopePoints.textContent = "";
      return;
    }

    const src = wg.source || {};
    els.projectName.textContent = src.team
      ? `${src.workspace || "Linear"} (${src.team})`
      : src.workspace || "Work Tech-Tree";
    els.workspaceRoot.textContent = `source: ${src.kind || "local_file"}${wg.truncated ? " · truncated" : ""}`;
    els.workspaceRoot.title = src.refreshed_at ? `Refreshed: ${src.refreshed_at}` : "";

    const scopedAll = getScopedWorkItems();
    const scopedCp = refreshScopedCriticalPath();

    let done = 0;
    let ready = 0;
    let active = 0;
    let blocked = 0;
    let totalPts = 0;
    let donePts = 0;
    for (const it of scopedAll) {
      if (it.tech_status === "done") done += 1;
      else if (it.tech_status === "ready") ready += 1;
      else if (it.tech_status === "in_progress" || it.tech_status === "in_review") active += 1;
      else if (it.tech_status === "blocked") blocked += 1;
      if (it.tech_status !== "canceled" && typeof it.estimate === "number") {
        totalPts += it.estimate;
        if (it.tech_status === "done") donePts += it.estimate;
      }
    }
    const nonCanceled = scopedAll.filter((it) => it.tech_status !== "canceled").length;
    const pct = nonCanceled > 0 ? Math.round((done / nonCanceled) * 100) : 0;

    els.wmetricDoneText.textContent = `${done}/${nonCanceled} Done`;
    els.wmetricDoneFill.style.width = `${pct}%`;

    els.wmetricReady.textContent = `Ready: ${ready}`;
    els.wmetricReady.classList.toggle("has-unlocked", ready > 0);

    els.wmetricActive.textContent = `Active: ${active}`;
    els.wmetricActive.classList.toggle("has-active", active > 0);

    els.wmetricBlocked.textContent = `Blocked: ${blocked}`;
    els.wmetricBlocked.classList.toggle("has-stale", blocked > 0);

    const cpLabel = state.workScope === "all" ? "Critical Path" : "Scope Critical Path";
    els.wmetricCp.textContent = `${cpLabel}: ${scopedCp.points} pts`;
    els.wmetricCp.classList.toggle("has-stale", scopedCp.points > 0);

    els.workScopePoints.textContent = `Points: ${donePts}/${totalPts} completed (${Math.max(0, totalPts - donePts)} rem)`;
  }

  function renderWorkViewDag() {
    const env = state.workEnvelope;
    const wg = env?.graph;
    els.workEmptyHost.textContent = "";

    if (!wg) {
      els.dagStage.classList.add("hidden");
      const box = el("div", "work-empty-canvas");
      box.appendChild(el("h3", "", env?.error ? "Failed to Load Work-Graph" : "No Work-Graph Configured"));
      box.appendChild(
        el(
          "p",
          "",
          env?.error
            ? env.error
            : "Start sf-tree with --work-graph <snapshot.json> (via Linear MCP) or --linear-team / --linear-project (with LINEAR_API_KEY) to visualize ticket dependencies and Critical Path."
        )
      );
      const switchBtn = el("button", "btn btn-primary", "Switch to Pipeline Stages");
      switchBtn.type = "button";
      switchBtn.addEventListener("click", () => setViewMode("pipeline", { fromUser: true, autoFit: true }));
      box.appendChild(switchBtn);
      els.workEmptyHost.appendChild(box);
      return;
    }

    const visibleItems = getFilteredWorkItems();
    if (visibleItems.length === 0) {
      els.dagStage.classList.add("hidden");
      const box = el("div", "work-empty-canvas");
      box.appendChild(el("h3", "", "No matching tickets"));
      box.appendChild(el("p", "", "Adjust the Project/Milestone scope or Quick Filter pills above to see work items."));
      const resetBtn = el("button", "btn", "Reset Filters");
      resetBtn.type = "button";
      resetBtn.addEventListener("click", () => {
        state.workScope = "all";
        state.workFilter = "all";
        state.hideDone = false;
        els.scopeSelect.value = "all";
        syncWorkFilterButtons();
        renderActiveView({ preserveScroll: false });
        requestAnimationFrame(() => fitZoom());
      });
      box.appendChild(resetBtn);
      els.workEmptyHost.appendChild(box);
      return;
    }

    const scopedCp = refreshScopedCriticalPath();
    state.workRects = dag.renderWorkDag({
      wg,
      visibleItems,
      scopedCp,
      selectedWorkId: state.selectedWorkId,
      hoveredWorkId: state.hoveredWorkId,
      highlightCriticalPath: state.highlightCriticalPath,
      zoom: state.zoom,
    });
  }

  function selectWorkItem(itemId, { scrollIntoView = false } = {}) {
    const changed = state.selectedWorkId !== itemId;
    state.selectedWorkId = itemId;

    const visible = getFilteredWorkItems();
    if (!visible.some((it) => it.id === itemId)) {
      state.workScope = "all";
      state.workFilter = "all";
      state.hideDone = false;
      els.scopeSelect.value = "all";
      syncWorkFilterButtons();
      renderWorkSummary();
      renderWorkViewDag();
    } else {
      dag.applyWorkHighlight({
        selectedWorkId: state.selectedWorkId,
        hoveredWorkId: state.hoveredWorkId,
        highlightCriticalPath: state.highlightCriticalPath,
      });
    }

    renderWorkInspector({ preserveScroll: !changed });

    if (scrollIntoView) {
      const r = state.workRects.get(itemId);
      if (r) {
        els.canvasScroller.scrollTo({
          left: Math.max(0, r.x * state.zoom - 120),
          top: Math.max(0, r.y * state.zoom - 100),
          behavior: "smooth",
        });
      }
    }
  }

  function renderWorkInspector({ preserveScroll = true } = {}) {
    const wg = state.workEnvelope?.graph;
    const prevScroll = preserveScroll ? els.inspectorBody.scrollTop : 0;

    els.inspectorHeader.textContent = "";
    els.inspectorBody.textContent = "";

    if (!wg) {
      els.inspectorHeader.appendChild(el("h2", "inspector-title", "Work Ticket Inspector"));
      els.inspectorBody.appendChild(
        el("div", "empty-note", "Load a work-graph snapshot or configure Linear GraphQL to inspect tickets.")
      );
      return;
    }

    const itemById = new Map((wg.items || []).map((it) => [it.id, it]));
    const projectById = new Map((wg.projects || []).map((p) => [p.id, p]));
    const milestoneById = new Map((wg.milestones || []).map((m) => [m.id, m]));
    const item = state.selectedWorkId ? itemById.get(state.selectedWorkId) : null;

    if (!item) {
      els.inspectorHeader.appendChild(el("h2", "inspector-title", "Select a work item"));
      els.inspectorBody.appendChild(
        el("div", "empty-note", "Click any ticket node on the Work Tech-Tree canvas to inspect blockers, unlocks, PRs, description, and tailored prompt.")
      );
      return;
    }

    const titleRow = el("div", "inspector-title-row");
    const titleWrap = el("div");
    titleWrap.appendChild(el("div", "inspector-sub", `${item.id} · Tier ${item.tier}`));
    titleWrap.appendChild(el("h2", "inspector-title", item.title));
    titleRow.appendChild(titleWrap);

    const badgeWrap = el("div", "node-badges");
    const wb = workBadgeForStatus(item.tech_status);
    badgeWrap.appendChild(el("span", `badge ${wb.cls}`, wb.text));
    if (state.scopedCp.nodeSet.has(item.id)) {
      badgeWrap.appendChild(
        el("span", "badge badge-stale", state.workScope === "all" ? "CRITICAL PATH" : "SCOPE CP")
      );
    }
    titleRow.appendChild(badgeWrap);
    els.inspectorHeader.appendChild(titleRow);

    const actionsRow = el("div", "inspector-actions-row");
    const safeLinearUrl = sanitizeExternalHttpsUrl(item.url);
    if (safeLinearUrl) {
      const link = el("a", "btn", "Open in Linear ↗");
      link.href = safeLinearUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      actionsRow.appendChild(link);
    }
    if (item.git_branch) {
      const copyBranchBtn = el("button", "btn", "Copy Branch");
      copyBranchBtn.type = "button";
      copyBranchBtn.addEventListener("click", () =>
        copyText(item.git_branch, `Copied branch: ${item.git_branch}`)
      );
      actionsRow.appendChild(copyBranchBtn);
    }
    if (actionsRow.childNodes.length > 0) {
      els.inspectorHeader.appendChild(actionsRow);
    }

    const promptBox = el("div", "prompt-box");
    const pHead = el("div", "prompt-box-head");
    pHead.appendChild(el("span", "prompt-box-label", workPromptLabel(item)));
    const copyBtn = el("button", "btn btn-primary", "Copy Prompt");
    copyBtn.type = "button";
    copyBtn.addEventListener("click", () =>
      copyText(item.next_prompt || "", "Copied ticket prompt to clipboard")
    );
    pHead.appendChild(copyBtn);
    promptBox.appendChild(pHead);
    promptBox.appendChild(el("p", "prompt-text", item.next_prompt || ""));
    els.inspectorHeader.appendChild(promptBox);

    const allWarnings = Array.isArray(wg.warnings)
      ? wg.warnings
      : Array.isArray(wg.summary?.warnings)
        ? wg.summary.warnings
        : wg.summary?.cycle_warnings || [];
    if (allWarnings.length > 0) {
      const warnBox = el("div", "alert-card alert-warn");
      warnBox.appendChild(el("h4", "", "Work-Graph Warnings"));
      const ul = el("ul");
      allWarnings.forEach((w) => ul.appendChild(el("li", "", w)));
      warnBox.appendChild(ul);
      els.inspectorBody.appendChild(warnBox);
    }

    const proj = item.project_id ? projectById.get(item.project_id) : null;
    const ms = item.milestone_id ? milestoneById.get(item.milestone_id) : null;
    const metaGrid = el("div", "meta-grid");
    [
      ["Project", proj ? proj.name : "—"],
      ["Milestone", ms ? ms.name : "—"],
      ["Tracker Status", `${item.status_name} (${item.status_type})`],
      ["Estimate", item.estimate !== null && item.estimate !== undefined ? `${item.estimate} pts` : "Unestimated"],
      ["Priority", PRIORITY_NAMES[item.priority] || "None"],
      ["Assignee", item.assignee || "Unassigned"],
    ].forEach(([k, v]) => {
      const c = el("div", "kv-card");
      c.appendChild(el("div", "kv-key", k));
      c.appendChild(el("div", "kv-value", v));
      metaGrid.appendChild(c);
    });
    els.inspectorBody.appendChild(metaGrid);

    if (item.git_branch) {
      const branchCard = el("div", "kv-card");
      branchCard.appendChild(el("div", "kv-key", "Git Branch"));
      branchCard.appendChild(el("div", "kv-value inspector-sub", item.git_branch));
      els.inspectorBody.appendChild(branchCard);
    }

    if (item.labels && item.labels.length > 0) {
      const lblCard = el("div", "kv-card");
      lblCard.appendChild(el("div", "kv-key", "Labels"));
      const wrap = el("div", "node-badges");
      item.labels.forEach((lbl) => wrap.appendChild(el("span", "badge badge-neutral", lbl)));
      lblCard.appendChild(wrap);
      els.inspectorBody.appendChild(lblCard);
    }

    const blockersCard = el("div", "kv-card");
    blockersCard.appendChild(el("div", "kv-key", `Blockers / Prerequisites (${item.blocked_by.length})`));
    if (item.blocked_by.length === 0) {
      blockersCard.appendChild(el("div", "kv-value", "None — no upstream blockers."));
    } else {
      const list = el("div", "jump-list");
      for (const bid of item.blocked_by) {
        const bItem = itemById.get(bid);
        const btn = el("button", "jump-btn");
        btn.type = "button";
        btn.appendChild(el("strong", "inspector-sub", bid));
        btn.appendChild(el("span", "jump-btn-title", bItem ? bItem.title : bid));
        if (bItem) {
          const bb = workBadgeForStatus(bItem.tech_status);
          btn.appendChild(el("span", `badge ${bb.cls}`, bb.text));
        }
        btn.addEventListener("click", () => selectWorkItem(bid, { scrollIntoView: true }));
        list.appendChild(btn);
      }
      blockersCard.appendChild(list);
    }
    els.inspectorBody.appendChild(blockersCard);

    const unlocksCard = el("div", "kv-card");
    unlocksCard.appendChild(el("div", "kv-key", `Unlocks / Downstream (${item.blocks.length})`));
    if (item.blocks.length === 0) {
      unlocksCard.appendChild(el("div", "kv-value", "None — terminal item."));
    } else {
      const list = el("div", "jump-list");
      for (const uid of item.blocks) {
        const uItem = itemById.get(uid);
        const btn = el("button", "jump-btn");
        btn.type = "button";
        btn.appendChild(el("strong", "inspector-sub", uid));
        btn.appendChild(el("span", "jump-btn-title", uItem ? uItem.title : uid));
        if (uItem) {
          const ub = workBadgeForStatus(uItem.tech_status);
          btn.appendChild(el("span", `badge ${ub.cls}`, ub.text));
        }
        btn.addEventListener("click", () => selectWorkItem(uid, { scrollIntoView: true }));
        list.appendChild(btn);
      }
      unlocksCard.appendChild(list);
    }
    els.inspectorBody.appendChild(unlocksCard);

    if (item.prs && item.prs.length > 0) {
      const prCard = el("div", "kv-card");
      prCard.appendChild(el("div", "kv-key", `Linked PRs (${item.prs.length})`));
      const list = el("div", "jump-list");
      for (const pr of item.prs) {
        const safePrUrl = sanitizeExternalHttpsUrl(pr.url);
        if (!safePrUrl) continue;
        const a = el("a", "btn", `${pr.title} ↗`);
        a.href = safePrUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        list.appendChild(a);
      }
      prCard.appendChild(list);
      els.inspectorBody.appendChild(prCard);
    }

    const descCard = el("div", "kv-card");
    descCard.appendChild(el("div", "kv-key", "Description"));
    if (item.description && item.description.trim()) {
      descCard.appendChild(renderSafeMarkdown(item.description, document));
    } else {
      descCard.appendChild(el("div", "kv-value", "(No description)"));
    }
    els.inspectorBody.appendChild(descCard);

    els.inspectorBody.scrollTop = preserveScroll ? prevScroll : 0;
  }

  function applyWorkEnvelope(envelope) {
    const wasNull = !state.workEnvelope;
    state.receivedInitialWork = true;
    state.workEnvelope = envelope;
    const wg = envelope?.graph || null;

    if (wg) {
      populateScopeDropdown(wg);
      const itemIds = new Set((wg.items || []).map((it) => it.id));
      if (!state.selectedWorkId || !itemIds.has(state.selectedWorkId)) {
        const pick =
          wg.items.find((it) => it.tech_status === "ready" && it.on_critical_path) ||
          wg.items.find((it) => it.tech_status === "ready") ||
          wg.items.find((it) => it.tech_status === "in_progress" || it.tech_status === "in_review") ||
          wg.items[0];
        state.selectedWorkId = pick ? pick.id : null;
      }
    }

    if (wasNull && !state.userPickedView && envelope?.default_view === "work") {
      setViewMode("work", { fromUser: false, autoFit: true });
      return;
    }

    updateWorkRefreshVisibility();
    if (state.viewMode === "work") {
      renderWorkSummary();
      renderWorkViewDag();
      renderWorkInspector({ preserveScroll: !wasNull });
      if (wasNull) {
        requestAnimationFrame(() => fitZoom());
      }
    }
  }

  // =========================================================================
  // PIPELINE STAGES VIEW
  // =========================================================================
  function getVisiblePipelineNodes() {
    if (!state.graph) return [];
    return state.graph.nodes.filter((n) => state.showMockery || !n.optional);
  }

  function getVisiblePipelineEdges() {
    if (!state.graph) return [];
    const visiblePhases = new Set(getVisiblePipelineNodes().map((n) => n.phase));
    return state.graph.edges.filter(
      (e) => visiblePhases.has(e.from) && visiblePhases.has(e.to)
    );
  }

  function renderPipelineSummary() {
    const g = state.graph;
    if (!g) return;
    const s = g.summary;
    els.projectName.textContent = g.project_name || "Software Factory";
    els.workspaceRoot.textContent = g.workspace_root || "docs/factory";
    els.workspaceRoot.title = g.workspace_root || "";

    const pct = s.core_total > 0 ? Math.round((s.core_completed / s.core_total) * 100) : 0;
    els.metricCoreText.textContent = `${s.core_completed}/${s.core_total} Core`;
    els.metricCoreFill.style.width = `${pct}%`;

    els.metricUnlocked.textContent = `Unlocked: ${s.unlocked_phases.length}`;
    els.metricUnlocked.classList.toggle("has-unlocked", s.unlocked_phases.length > 0);

    els.metricStale.textContent = `Stale: ${s.stale_phases.length}`;
    els.metricStale.classList.toggle("has-stale", s.stale_phases.length > 0);

    const staleRevCount = Array.isArray(s.stale_review_phases) ? s.stale_review_phases.length : 0;
    els.metricReviewStale.classList.toggle("hidden", staleRevCount === 0);
    els.metricReviewStale.classList.toggle("has-stale", staleRevCount > 0);
    els.metricReviewStale.textContent = `Stale Reviews: ${staleRevCount}`;

    els.metricFail.textContent = `Failing: ${s.failing_review_phases.length}`;
    els.metricFail.classList.toggle("has-fail", s.failing_review_phases.length > 0);

    els.metricInvalid.classList.toggle("hidden", s.invalid_phases.length === 0);
    els.metricInvalid.classList.toggle("has-invalid", s.invalid_phases.length > 0);
    els.metricInvalid.textContent = `Invalid: ${s.invalid_phases.length}`;
  }

  function renderPipelineViewDag() {
    const g = state.graph;
    if (!g) return;
    dag.renderPipelineDag({
      graph: g,
      nodes: getVisiblePipelineNodes(),
      edges: getVisiblePipelineEdges(),
      selectedPhase: state.selectedPhase,
      hoveredPhase: state.hoveredPhase,
      highlightBlast: state.highlightBlast,
      zoom: state.zoom,
    });
  }

  function selectPipelineNode(phase) {
    const changed = state.selectedPhase !== phase;
    state.selectedPhase = phase;
    dag.applyPipelineHighlight({
      selectedPhase: state.selectedPhase,
      hoveredPhase: state.hoveredPhase,
      highlightBlast: state.highlightBlast,
    });
    renderPipelineInspector({ preserveScroll: !changed });
  }

  function getSelectedPipelineNode() {
    if (!state.graph || !state.selectedPhase) return null;
    return state.graph.nodes.find((n) => n.phase === state.selectedPhase) || null;
  }

  function renderPipelineInspector({ preserveScroll = true } = {}) {
    const node = getSelectedPipelineNode();
    const prevScroll = preserveScroll ? els.inspectorBody.scrollTop : 0;

    els.inspectorHeader.textContent = "";
    els.inspectorBody.textContent = "";

    if (!node) {
      els.inspectorHeader.appendChild(el("h2", "inspector-title", "Select a stage"));
      els.inspectorBody.appendChild(
        el("div", "empty-note", "Click any node in the pipeline DAG to inspect its <system_state>, narrative, reviews, and next prompt.")
      );
      return;
    }

    els.tabBtnReviews.textContent = `Reviews (${node.reviews.length})`;

    const titleRow = el("div", "inspector-title-row");
    const titleWrap = el("div");
    titleWrap.appendChild(el("h2", "inspector-title", `${node.stage}. ${node.label}`));
    titleWrap.appendChild(el("div", "inspector-sub", `${node.skill} · ${node.file}`));
    titleRow.appendChild(titleWrap);

    const badgeWrap = el("div", "node-badges");
    const stBadge = badgeForPipelineStatus(node.status);
    badgeWrap.appendChild(el("span", `badge ${stBadge.cls}`, stBadge.text));
    if (node.is_stale) badgeWrap.appendChild(el("span", "badge badge-stale", "STALE"));
    titleRow.appendChild(badgeWrap);
    els.inspectorHeader.appendChild(titleRow);

    const promptBox = el("div", "prompt-box");
    const pHead = el("div", "prompt-box-head");
    pHead.appendChild(el("span", "prompt-box-label", promptActionLabel(node)));
    const copyBtn = el("button", "btn btn-primary", "Copy Prompt");
    copyBtn.type = "button";
    copyBtn.addEventListener("click", () =>
      copyText(node.next_prompt || "", "Copied prompt to clipboard")
    );
    pHead.appendChild(copyBtn);
    promptBox.appendChild(pHead);
    promptBox.appendChild(el("p", "prompt-text", node.next_prompt || ""));
    els.inspectorHeader.appendChild(promptBox);

    if (state.activeTab === "overview") renderOverviewTab(node);
    else if (state.activeTab === "narrative") renderNarrativeTab(node);
    else if (state.activeTab === "reviews") renderReviewsTab(node);

    els.inspectorBody.scrollTop = preserveScroll ? prevScroll : 0;
  }

  function renderMockeryExtras(mockery) {
    const card = el("div", "mockery-card");
    const head = el("div", "prompt-box-head");
    head.appendChild(el("span", "prompt-box-label", "Stage 6b Mockery Canvas"));
    const pills = el("div", "node-badges");
    pills.appendChild(
      el("span", `badge ${mockery.fidelity === "styled" ? "badge-pass" : "badge-neutral"}`, mockery.fidelity || "not generated")
    );
    if (mockery.tokens_synced_from_ui !== null) {
      pills.appendChild(
        el("span", `badge ${mockery.tokens_synced_from_ui ? "badge-pass" : "badge-stale"}`, mockery.tokens_synced_from_ui ? "tokens synced" : "tokens unsynced")
      );
    }
    pills.appendChild(
      el("span", `badge ${mockery.flow_json_valid ? "badge-pass" : mockery.flow_json_exists ? "badge-fail" : "badge-locked"}`, mockery.flow_json_valid ? "flow.json ok" : mockery.flow_json_exists ? "flow.json invalid" : "no flow.json")
    );
    head.appendChild(pills);
    card.appendChild(head);

    const stats = el("div", "mockery-stats");
    [
      ["Screens", mockery.screens_count],
      ["Components", mockery.components_count],
      ["Edges", mockery.edges_count],
    ].forEach(([lbl, val]) => {
      const box = el("div", "mockery-stat");
      box.appendChild(el("div", "mockery-stat-val", String(val ?? 0)));
      box.appendChild(el("div", "mockery-stat-lbl", lbl));
      stats.appendChild(box);
    });
    card.appendChild(stats);

    [
      ["Copy Viewer", mockery.viewer_command],
      ["Copy Check", mockery.check_command],
      ...(mockery.export_command ? [["Copy Export", mockery.export_command]] : []),
    ].forEach(([btnText, cmd]) => {
      const row = el("div", "cmd-row");
      row.appendChild(el("code", "cmd-code", cmd));
      const btn = el("button", "btn", btnText);
      btn.type = "button";
      btn.addEventListener("click", () => copyText(cmd, `Copied: ${cmd}`));
      row.appendChild(btn);
      card.appendChild(row);
    });

    const prevRow = el("div", "cmd-row");
    const input = el("input", "preview-input");
    input.type = "url";
    input.value = state.mockeryPreviewUrl;
    input.setAttribute("aria-label", "Mockery localhost preview URL");
    input.addEventListener("input", () => {
      state.mockeryPreviewUrl = input.value.trim();
      safeStorageSet("sf-tree-mockery-url", state.mockeryPreviewUrl);
      updateOpenLink();
    });
    const openLink = el("a", "btn", "Open Preview");
    openLink.target = "_blank";
    openLink.rel = "noopener noreferrer";
    function updateOpenLink() {
      const safe = sanitizePreviewUrl(state.mockeryPreviewUrl);
      if (safe) {
        openLink.href = safe;
        openLink.classList.remove("is-disabled-link");
      } else {
        openLink.removeAttribute("href");
        openLink.classList.add("is-disabled-link");
      }
    }
    updateOpenLink();
    prevRow.appendChild(input);
    prevRow.appendChild(openLink);
    card.appendChild(prevRow);
    return card;
  }

  function renderOverviewTab(node) {
    if (node.phase === "mockery" && state.graph.mockery) {
      els.inspectorBody.appendChild(renderMockeryExtras(state.graph.mockery));
    }

    const topWarnings = Array.isArray(state.graph?.warnings) ? state.graph.warnings : [];
    if (topWarnings.length > 0) {
      const box = el("div", "alert-card alert-warn");
      box.appendChild(el("h4", "", "Workspace / Review Warnings"));
      const ul = el("ul");
      topWarnings.forEach((w) => ul.appendChild(el("li", "", w)));
      box.appendChild(ul);
      els.inspectorBody.appendChild(box);
    }

    if (node.state_errors && node.state_errors.length > 0) {
      const box = el("div", "alert-card alert-error");
      box.appendChild(el("h4", "", "<system_state> Validation Errors"));
      const ul = el("ul");
      node.state_errors.forEach((err) => ul.appendChild(el("li", "", err)));
      box.appendChild(ul);
      els.inspectorBody.appendChild(box);
    }

    if (node.is_stale && node.stale_reasons && node.stale_reasons.length > 0) {
      const box = el("div", "alert-card alert-stale");
      box.appendChild(el("h4", "", "Staleness / Blast-Radius Reasons"));
      const ul = el("ul");
      node.stale_reasons.forEach((r) => ul.appendChild(el("li", "", r)));
      box.appendChild(ul);
      els.inspectorBody.appendChild(box);
    }

    if (node.warnings && node.warnings.length > 0) {
      const box = el("div", "alert-card alert-warn");
      box.appendChild(el("h4", "", "Semantic Warnings"));
      const ul = el("ul");
      node.warnings.forEach((w) => ul.appendChild(el("li", "", w)));
      box.appendChild(ul);
      els.inspectorBody.appendChild(box);
    }

    if (!node.exists) {
      els.inspectorBody.appendChild(
        el("div", "empty-note", `${node.file} does not exist yet (${node.status}). Use the Copy Prompt bar above to generate it when ready.`)
      );
      return;
    }

    if (!node.system_state) {
      els.inspectorBody.appendChild(
        el("div", "empty-note", "No valid <system_state> JSON object could be parsed from this file.")
      );
      return;
    }

    const metaCard = el("div", "kv-card");
    metaCard.appendChild(el("div", "kv-key", "freshness_metadata"));
    const ts = node.effective_time_ms ? new Date(node.effective_time_ms).toISOString() : "n/a";
    metaCard.appendChild(el("div", "kv-value", `Resolved timestamp: ${ts} (source: ${node.time_source || "n/a"})`));
    els.inspectorBody.appendChild(metaCard);

    const kvList = el("div", "kv-list");
    for (const [key, val] of Object.entries(node.system_state)) {
      const card = el("div", "kv-card");
      card.appendChild(el("div", "kv-key", key));
      const valWrap = el("div", "kv-value");

      if (Array.isArray(val)) {
        if (val.length === 0) {
          valWrap.textContent = "(empty)";
        } else {
          const ul = el("ul");
          val.forEach((item) => {
            const li = el("li");
            li.textContent = typeof item === "object" && item !== null ? JSON.stringify(item) : String(item);
            ul.appendChild(li);
          });
          valWrap.appendChild(ul);
        }
      } else if (typeof val === "object" && val !== null) {
        valWrap.appendChild(el("pre", "kv-pre", JSON.stringify(val, null, 2)));
      } else {
        valWrap.textContent = String(val);
      }

      card.appendChild(valWrap);
      kvList.appendChild(card);
    }
    els.inspectorBody.appendChild(kvList);

    const details = el("details", "raw-json-details");
    details.appendChild(el("summary", "", "Raw <system_state> JSON"));
    const rawStr = JSON.stringify(node.system_state, null, 2);
    const copyJsonBtn = el("button", "btn btn-copy-json", "Copy JSON");
    copyJsonBtn.type = "button";
    copyJsonBtn.addEventListener("click", () => copyText(rawStr, "Copied <system_state> JSON"));
    details.appendChild(copyJsonBtn);
    details.appendChild(el("pre", "kv-pre", rawStr));
    els.inspectorBody.appendChild(details);
  }

  async function renderNarrativeTab(node) {
    if (!node.exists) {
      els.inspectorBody.appendChild(el("div", "empty-note", `${node.file} does not exist yet.`));
      return;
    }
    const cached = state.artifactCache.get(node.phase);
    if (cached && cached.mtimeMs === node.mtime_ms) {
      if (!cached.data.narrative_markdown) {
        els.inspectorBody.appendChild(el("div", "empty-note", "No narrative markdown content found."));
      } else {
        els.inspectorBody.appendChild(renderSafeMarkdown(cached.data.narrative_markdown, document));
      }
      return;
    }

    const seq = ++state.artifactFetchSeq;
    els.inspectorBody.appendChild(el("div", "empty-note", `Loading ${node.file}…`));
    try {
      const resp = await fetch(`/api/artifact/${encodeURIComponent(node.phase)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      state.artifactCache.set(node.phase, { mtimeMs: node.mtime_ms, data });
      if (
        state.artifactFetchSeq !== seq ||
        state.viewMode !== "pipeline" ||
        state.selectedPhase !== node.phase ||
        state.activeTab !== "narrative"
      ) {
        return;
      }
      const prevScroll = els.inspectorBody.scrollTop;
      els.inspectorBody.textContent = "";
      if (!data.narrative_markdown) {
        els.inspectorBody.appendChild(el("div", "empty-note", "No narrative markdown content found."));
      } else {
        els.inspectorBody.appendChild(renderSafeMarkdown(data.narrative_markdown, document));
      }
      els.inspectorBody.scrollTop = prevScroll;
    } catch (err) {
      if (
        state.artifactFetchSeq !== seq ||
        state.viewMode !== "pipeline" ||
        state.selectedPhase !== node.phase ||
        state.activeTab !== "narrative"
      ) {
        return;
      }
      els.inspectorBody.textContent = "";
      els.inspectorBody.appendChild(
        el("div", "alert-card alert-error", `Failed to load artifact narrative: ${err.message}`)
      );
    }
  }

  function renderReviewsTab(node) {
    if (!node.reviews || node.reviews.length === 0) {
      els.inspectorBody.appendChild(
        el("div", "empty-note", `No sf-review audit files found targeting "${node.phase}" under docs/factory/reviews/.`)
      );
      return;
    }

    for (const rev of node.reviews) {
      const card = el("div", "review-card");
      const head = el("div", "review-card-head");
      const filename = rev.file.split("/").pop();
      head.appendChild(el("strong", "inspector-sub", filename));

      const badges = el("div", "node-badges");
      badges.appendChild(el("span", `badge ${rev.verdict === "PASS" ? "badge-pass" : "badge-fail"}`, rev.verdict));
      badges.appendChild(el("span", `badge ${rev.is_stale ? "badge-stale" : "badge-neutral"}`, rev.is_stale ? "STALE REVIEW" : "FRESH"));
      head.appendChild(badges);
      card.appendChild(head);

      const meta = el("div", "review-meta-row");
      meta.appendChild(el("span", "", `Sources: ${rev.source_phases.join(", ") || "none"}`));
      meta.appendChild(el("span", "", `Critical: ${rev.critical_violations_count}`));
      meta.appendChild(el("span", "", `Scope warnings: ${rev.scope_creep_warnings_count}`));
      card.appendChild(meta);

      if (rev.is_stale && rev.stale_reasons.length > 0) {
        const staleBox = el("div", "alert-card alert-stale");
        const ul = el("ul");
        rev.stale_reasons.forEach((r) => ul.appendChild(el("li", "", r)));
        staleBox.appendChild(ul);
        card.appendChild(staleBox);
      }

      if (rev.blocking_issues && rev.blocking_issues.length > 0) {
        const blkBox = el("div", "alert-card alert-error");
        blkBox.appendChild(el("h4", "", "Blocking Issues"));
        const ul = el("ul");
        rev.blocking_issues.forEach((b) => ul.appendChild(el("li", "", b)));
        blkBox.appendChild(ul);
        card.appendChild(blkBox);
      }

      const isExpanded = state.expandedReviews.has(filename);
      const toggleBtn = el("button", "btn", isExpanded ? "Hide Audit Narrative" : "View Audit Narrative");
      toggleBtn.type = "button";
      const narrativeHost = el("div");

      toggleBtn.addEventListener("click", async () => {
        if (state.expandedReviews.has(filename)) {
          state.expandedReviews.delete(filename);
          delete narrativeHost.dataset.fetchSeq;
          toggleBtn.textContent = "View Audit Narrative";
          narrativeHost.textContent = "";
          return;
        }
        state.expandedReviews.add(filename);
        toggleBtn.textContent = "Hide Audit Narrative";
        await loadReviewNarrative(filename, rev.mtime_ms, narrativeHost);
      });

      card.appendChild(toggleBtn);
      card.appendChild(narrativeHost);
      els.inspectorBody.appendChild(card);

      if (isExpanded) {
        loadReviewNarrative(filename, rev.mtime_ms, narrativeHost);
      }
    }
  }

  async function loadReviewNarrative(filename, mtimeMs, host) {
    const seq = String(++state.reviewFetchSeq);
    host.dataset.fetchSeq = seq;

    const cached = state.reviewCache.get(filename);
    if (cached && cached.mtimeMs === mtimeMs) {
      if (!host.isConnected || host.dataset.fetchSeq !== seq || !state.expandedReviews.has(filename)) {
        return;
      }
      host.textContent = "";
      host.appendChild(renderSafeMarkdown(cached.data.narrative_markdown, document));
      return;
    }

    host.textContent = "";
    host.appendChild(el("div", "empty-note", "Loading review…"));
    try {
      const resp = await fetch(`/api/review/${encodeURIComponent(filename)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      state.reviewCache.set(filename, { mtimeMs, data });
      if (!host.isConnected || host.dataset.fetchSeq !== seq || !state.expandedReviews.has(filename)) {
        return;
      }
      host.textContent = "";
      host.appendChild(renderSafeMarkdown(data.narrative_markdown, document));
    } catch (err) {
      if (!host.isConnected || host.dataset.fetchSeq !== seq || !state.expandedReviews.has(filename)) {
        return;
      }
      host.textContent = "";
      host.appendChild(el("div", "alert-card alert-error", `Failed to load review: ${err.message}`));
    }
  }

  function applyPipelineGraph(nextGraph) {
    const isFirst = !state.graph;
    state.receivedInitialPipeline = true;
    state.graph = nextGraph;

    if (!state.selectedPhase) {
      const pick =
        nextGraph.nodes.find((n) => n.status === "invalid" || n.status === "reviewed_fail") ||
        nextGraph.nodes.find((n) => n.is_stale || n.status === "review_stale") ||
        nextGraph.nodes.find((n) => n.status === "unlocked") ||
        nextGraph.nodes[0];
      state.selectedPhase = pick ? pick.phase : null;
    }

    if (state.viewMode === "pipeline") {
      renderPipelineSummary();
      renderPipelineViewDag();
      renderPipelineInspector({ preserveScroll: !isFirst });
      if (isFirst) requestAnimationFrame(() => fitZoom());
    }
  }

  // =========================================================================
  // SHARED CONTROLS & SSE (Single-analysis bootstrap via SSE with REST fallback)
  // =========================================================================
  function fitZoom() {
    const stageW = parseFloat(els.dagStage.style.width) || 1200;
    const availW = els.canvasScroller.clientWidth - 48;
    if (availW > 0 && stageW > 0) {
      const ratio = Math.min(1, Math.max(0.28, availW / stageW));
      state.zoom = Math.round(ratio * 100) / 100;
      els.dagStage.style.transform = `scale(${state.zoom})`;
    }
  }

  function syncWorkFilterButtons() {
    document.querySelectorAll("[data-wfilter]").forEach((btn) => {
      const active = btn.getAttribute("data-wfilter") === state.workFilter;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    els.btnHideDone.classList.toggle("active", state.hideDone);
    els.btnHideDone.setAttribute("aria-pressed", String(state.hideDone));
  }

  els.btnViewWork.addEventListener("click", () =>
    setViewMode("work", { fromUser: true, autoFit: true })
  );
  els.btnViewPipeline.addEventListener("click", () =>
    setViewMode("pipeline", { fromUser: true, autoFit: true })
  );

  els.scopeSelect.addEventListener("change", () => {
    state.workScope = els.scopeSelect.value;
    renderWorkSummary();
    renderWorkViewDag();
    renderWorkInspector({ preserveScroll: true });
    requestAnimationFrame(() => fitZoom());
  });

  document.querySelectorAll("[data-wfilter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.workFilter = btn.getAttribute("data-wfilter") || "all";
      syncWorkFilterButtons();
      renderWorkViewDag();
      requestAnimationFrame(() => fitZoom());
    });
  });

  els.btnHideDone.addEventListener("click", () => {
    state.hideDone = !state.hideDone;
    syncWorkFilterButtons();
    renderWorkViewDag();
    requestAnimationFrame(() => fitZoom());
  });

  els.btnCp.addEventListener("click", () => {
    state.highlightCriticalPath = !state.highlightCriticalPath;
    els.btnCp.setAttribute("aria-pressed", String(state.highlightCriticalPath));
    els.btnCp.classList.toggle("active-blast", state.highlightCriticalPath);
    dag.applyWorkHighlight({
      selectedWorkId: state.selectedWorkId,
      hoveredWorkId: state.hoveredWorkId,
      highlightCriticalPath: state.highlightCriticalPath,
    });
  });

  els.btnWorkRefresh.addEventListener("click", async () => {
    els.btnWorkRefresh.disabled = true;
    els.btnWorkRefresh.textContent = "Refreshing…";
    try {
      const resp = await fetch("/api/work-graph/refresh", {
        method: "POST",
        headers: { "X-SF-Tree-Refresh": "1" },
      });
      const data = await resp.json();
      if (resp.ok) {
        applyWorkEnvelope(data);
        showToast("Refreshed work-graph from Linear");
      } else {
        showToast(data.error || "Refresh failed");
      }
    } catch {
      showToast("Refresh request failed");
    } finally {
      els.btnWorkRefresh.disabled = false;
      els.btnWorkRefresh.textContent = "Refresh";
    }
  });

  els.btnMockery.addEventListener("click", () => {
    state.showMockery = !state.showMockery;
    els.btnMockery.setAttribute("aria-pressed", String(state.showMockery));
    els.btnMockery.classList.toggle("active-toggle", state.showMockery);
    if (!state.showMockery && state.selectedPhase === "mockery") {
      state.selectedPhase = "ui";
    }
    renderPipelineViewDag();
    renderPipelineInspector({ preserveScroll: false });
  });

  els.btnBlast.addEventListener("click", () => {
    state.highlightBlast = !state.highlightBlast;
    els.btnBlast.setAttribute("aria-pressed", String(state.highlightBlast));
    els.btnBlast.classList.toggle("active-blast", state.highlightBlast);
    dag.applyPipelineHighlight({
      selectedPhase: state.selectedPhase,
      hoveredPhase: state.hoveredPhase,
      highlightBlast: state.highlightBlast,
    });
  });

  document.getElementById("btn-zoom-in").addEventListener("click", () => {
    state.zoom = Math.min(1.4, Math.round((state.zoom + 0.1) * 100) / 100);
    els.dagStage.style.transform = `scale(${state.zoom})`;
  });
  document.getElementById("btn-zoom-out").addEventListener("click", () => {
    state.zoom = Math.max(0.35, Math.round((state.zoom - 0.1) * 100) / 100);
    els.dagStage.style.transform = `scale(${state.zoom})`;
  });
  document.getElementById("btn-zoom-reset").addEventListener("click", () => {
    state.zoom = 1;
    els.dagStage.style.transform = "scale(1)";
  });
  document.getElementById("btn-zoom-fit").addEventListener("click", fitZoom);

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.getAttribute("data-tab");
      document.querySelectorAll(".tab-btn").forEach((b) => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", String(active));
      });
      renderPipelineInspector({ preserveScroll: false });
    });
  });

  function setSseStatus(status, label) {
    els.ssePill.setAttribute("data-state", status);
    els.sseLabel.textContent = label;
  }

  let restFallbackTriggered = false;
  async function loadInitialRestFallback() {
    if (restFallbackTriggered) return;
    restFallbackTriggered = true;
    try {
      const tasks = [];
      if (!state.receivedInitialPipeline) {
        tasks.push(
          fetch("/api/graph").then(async (r) => {
            if (r.ok && !state.receivedInitialPipeline) {
              applyPipelineGraph(await r.json());
            }
          })
        );
      }
      if (!state.receivedInitialWork) {
        tasks.push(
          fetch("/api/work-graph").then(async (r) => {
            if (r.ok && !state.receivedInitialWork) {
              applyWorkEnvelope(await r.json());
            }
          })
        );
      }
      await Promise.all(tasks);
    } catch {
      // ignore fallback errors; SSE will continue retrying
    }
  }

  function connectSse() {
    if (typeof EventSource === "undefined") {
      setSseStatus("reconnecting", "Offline");
      loadInitialRestFallback();
      return;
    }

    const es = new EventSource("/events");
    es.onopen = () => setSseStatus("connected", "Live");
    es.addEventListener("graph", (ev) => {
      setSseStatus("connected", "Live");
      try {
        applyPipelineGraph(JSON.parse(ev.data));
      } catch {
        // ignore malformed payload
      }
    });
    es.addEventListener("work_graph", (ev) => {
      setSseStatus("connected", "Live");
      try {
        applyWorkEnvelope(JSON.parse(ev.data));
      } catch {
        // ignore malformed payload
      }
    });
    es.onerror = () => {
      setSseStatus("reconnecting", "Reconnecting…");
      if (!state.receivedInitialPipeline || !state.receivedInitialWork) {
        loadInitialRestFallback();
      }
    };
  }

  function bootstrap() {
    initTheme();
    renderLegend();
    // Connect directly to SSE, which pushes initial graph + work_graph from a single server analysis.
    // REST endpoints are only called as fallback if SSE fails before initial state arrives.
    connectSse();
  }

  bootstrap();
}

if (typeof document !== "undefined" && document.getElementById("dag-stage")) {
  initApp();
}
