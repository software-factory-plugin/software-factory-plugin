import fs from "node:fs";
import path from "node:path";

export const WORK_GRAPH_SCHEMA_VERSION = "1.0";
export const WORK_GRAPH_TYPE = "work-graph";
export const DEFAULT_WORK_GRAPH_REL_PATH = path.posix.join(
  "docs",
  "factory",
  "work-graph.json"
);

const ALLOWED_STATUS_TYPES = new Set([
  "completed",
  "canceled",
  "started",
  "unstarted",
  "backlog",
  "triage",
]);

/**
 * Sanitize external URLs strictly to http: / https:.
 */
export function sanitizeHttpUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Natural alphanumeric comparator so SOF-8 sorts before SOF-26.
 */
export function compareNaturalId(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  const pa = sa.match(/^([A-Za-z_-]+?)(\d+)$/);
  const pb = sb.match(/^([A-Za-z_-]+?)(\d+)$/);
  if (pa && pb && pa[1].toLowerCase() === pb[1].toLowerCase()) {
    const diff = Number(pa[2]) - Number(pb[2]);
    if (diff !== 0) return diff;
  }
  return sa.localeCompare(sb, "en", { numeric: true, sensitivity: "base" });
}

function normalizeStatusType(rawType, statusName) {
  const lowered = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
  if (ALLOWED_STATUS_TYPES.has(lowered)) return lowered;
  const name = typeof statusName === "string" ? statusName.trim().toLowerCase() : "";
  if (name === "done" || name === "completed" || name === "closed") return "completed";
  if (name === "canceled" || name === "cancelled" || name === "duplicate") return "canceled";
  if (name.includes("progress") || name.includes("review") || name === "started") {
    return "started";
  }
  if (name === "backlog") return "backlog";
  if (name === "triage") return "triage";
  return "unstarted";
}

function normalizePriority(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const n = Math.trunc(raw);
    if (n >= 0 && n <= 4) return n;
  }
  if (raw && typeof raw === "object" && typeof raw.value === "number") {
    return normalizePriority(raw.value);
  }
  return 0;
}

function priorityRank(priority) {
  // 1=Urgent, 2=High, 3=Medium, 4=Low, 0=None (sorts after Low)
  return priority === 0 ? 99 : priority;
}

function normalizeEstimate(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  if (raw && typeof raw === "object" && typeof raw.value === "number") {
    return normalizeEstimate(raw.value);
  }
  return null;
}

function normalizePrList(rawPrs) {
  if (!Array.isArray(rawPrs)) return [];
  const seen = new Set();
  const out = [];
  for (const pr of rawPrs) {
    if (!pr || typeof pr !== "object") continue;
    const url = sanitizeHttpUrl(pr.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title:
        typeof pr.title === "string" && pr.title.trim()
          ? pr.title.trim()
          : url,
      url,
    });
  }
  return out;
}

function normalizeStringArray(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const val of raw) {
    if (typeof val !== "string") continue;
    const trimmed = val.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function buildNextPrompt(item, itemById) {
  const branchHint = item.git_branch ? ` on branch ${item.git_branch}` : "";
  switch (item.tech_status) {
    case "ready":
      return `Start ${item.id} (${item.title})${branchHint}: implement acceptance criteria, run verification tests, and open a PR with "Closes ${item.id}".`;
    case "blocked": {
      const openBlockers = item.blocked_by.filter((bid) => {
        const b = itemById.get(bid);
        return b && b.tech_status !== "done" && b.tech_status !== "canceled";
      });
      return `Unblock ${item.id} (${item.title}) by completing upstream prerequisite(s) first: ${openBlockers.join(", ")}.`;
    }
    case "in_review":
      return `Review, verify, and squash-merge the PR for ${item.id} (${item.title}), then post the closing Telemetry comment.`;
    case "in_progress":
      return `Continue ${item.id} (${item.title})${branchHint}: finish remaining scope, verify tests, and open a PR with "Closes ${item.id}".`;
    case "done": {
      const downstreamReady = item.blocks.filter((uid) => {
        const u = itemById.get(uid);
        return u && u.tech_status === "ready";
      });
      if (downstreamReady.length > 0) {
        return `${item.id} is Done. Next unlocked downstream work: ${downstreamReady.join(", ")}.`;
      }
      const downstreamOpen = item.blocks.filter((uid) => {
        const u = itemById.get(uid);
        return u && u.tech_status !== "done" && u.tech_status !== "canceled";
      });
      if (downstreamOpen.length > 0) {
        return `${item.id} is Done. Inspect downstream dependent item(s): ${downstreamOpen.join(", ")}.`;
      }
      return `${item.id} is Done; no downstream blockers remain.`;
    }
    case "canceled":
      return `${item.id} is Canceled; no action required.`;
    default:
      return `Inspect ${item.id} (${item.title}).`;
  }
}

/**
 * Find optional repo-local fallback docs/factory/work-graph.json if present.
 */
export function findDefaultWorkGraphPath(workspaceRoot) {
  const candidate = path.resolve(workspaceRoot, DEFAULT_WORK_GRAPH_REL_PATH);
  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Validate, normalize, and analyze a canonical work-graph v1 payload.
 * Computes derived tech_status, topological tiers (Kahn's algorithm with cycle guard),
 * estimate-weighted remaining Critical Path, summary stats, and state-aware next_prompt.
 */
export function analyzeWorkGraph(input, { defaultSourceKind = "local_file" } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid work-graph payload: expected a JSON object");
  }

  if (
    input.schema_version !== undefined &&
    input.schema_version !== WORK_GRAPH_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported work-graph schema_version "${String(input.schema_version)}" (expected "${WORK_GRAPH_SCHEMA_VERSION}")`
    );
  }

  if (
    input.graph_type !== undefined &&
    input.graph_type !== WORK_GRAPH_TYPE
  ) {
    throw new Error(
      `Unsupported work-graph graph_type "${String(input.graph_type)}" (expected "${WORK_GRAPH_TYPE}")`
    );
  }

  if (!Array.isArray(input.items)) {
    throw new Error("Invalid work-graph payload: expected an 'items' array");
  }

  const nowIso = new Date().toISOString();
  const rawSource =
    input.source && typeof input.source === "object" ? input.source : {};
  const source = {
    kind:
      typeof rawSource.kind === "string" && rawSource.kind.trim()
        ? rawSource.kind.trim()
        : defaultSourceKind,
    workspace:
      typeof rawSource.workspace === "string" && rawSource.workspace.trim()
        ? rawSource.workspace.trim()
        : "workspace",
    team:
      typeof rawSource.team === "string" && rawSource.team.trim()
        ? rawSource.team.trim()
        : "",
    refreshed_at:
      typeof rawSource.refreshed_at === "string" && rawSource.refreshed_at.trim()
        ? rawSource.refreshed_at.trim()
        : nowIso,
    live_refresh_supported: Boolean(rawSource.live_refresh_supported),
  };

  // Normalize projects
  const projectMap = new Map();
  if (Array.isArray(input.projects)) {
    for (const p of input.projects) {
      if (!p || typeof p !== "object") continue;
      const id = typeof p.id === "string" ? p.id.trim() : "";
      if (!id || projectMap.has(id)) continue;
      projectMap.set(id, {
        id,
        name:
          typeof p.name === "string" && p.name.trim() ? p.name.trim() : id,
        status:
          typeof p.status === "string" && p.status.trim()
            ? p.status.trim()
            : "Unknown",
        color:
          typeof p.color === "string" && p.color.trim()
            ? p.color.trim()
            : "#3B82F6",
        url: sanitizeHttpUrl(p.url),
      });
    }
  }

  // Normalize milestones
  const milestoneMap = new Map();
  if (Array.isArray(input.milestones)) {
    for (let idx = 0; idx < input.milestones.length; idx += 1) {
      const m = input.milestones[idx];
      if (!m || typeof m !== "object") continue;
      const id = typeof m.id === "string" ? m.id.trim() : "";
      if (!id || milestoneMap.has(id)) continue;
      const sortOrder =
        typeof m.sort_order === "number" && Number.isFinite(m.sort_order)
          ? m.sort_order
          : idx + 1;
      milestoneMap.set(id, {
        id,
        project_id:
          typeof m.project_id === "string" && m.project_id.trim()
            ? m.project_id.trim()
            : null,
        name:
          typeof m.name === "string" && m.name.trim() ? m.name.trim() : id,
        sort_order: sortOrder,
      });
    }
  }

  // Normalize items
  const itemById = new Map();
  const rawBlockedByMap = new Map();
  const rawBlocksMap = new Map();

  for (const raw of input.items) {
    if (!raw || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) continue;

    const statusName =
      typeof raw.status_name === "string" && raw.status_name.trim()
        ? raw.status_name.trim()
        : typeof raw.status === "string" && raw.status.trim()
          ? raw.status.trim()
          : "Todo";
    const statusType = normalizeStatusType(
      raw.status_type ?? raw.statusType,
      statusName
    );

    const item = {
      id,
      title:
        typeof raw.title === "string" && raw.title.trim()
          ? raw.title.trim()
          : id,
      description:
        typeof raw.description === "string" ? raw.description : "",
      status_name: statusName,
      status_type: statusType,
      tech_status: "ready",
      priority: normalizePriority(raw.priority),
      estimate: normalizeEstimate(raw.estimate),
      project_id:
        typeof raw.project_id === "string" && raw.project_id.trim()
          ? raw.project_id.trim()
          : null,
      milestone_id:
        typeof raw.milestone_id === "string" && raw.milestone_id.trim()
          ? raw.milestone_id.trim()
          : null,
      assignee:
        typeof raw.assignee === "string" && raw.assignee.trim()
          ? raw.assignee.trim()
          : null,
      labels: normalizeStringArray(raw.labels),
      git_branch:
        typeof raw.git_branch === "string" && raw.git_branch.trim()
          ? raw.git_branch.trim()
          : typeof raw.gitBranchName === "string" && raw.gitBranchName.trim()
            ? raw.gitBranchName.trim()
            : null,
      url: sanitizeHttpUrl(raw.url),
      prs: normalizePrList(raw.prs),
      blocked_by: [],
      blocks: [],
      tier: 0,
      on_critical_path: false,
      next_prompt: "",
    };

    itemById.set(id, item);
    rawBlockedByMap.set(id, normalizeStringArray(raw.blocked_by));
    rawBlocksMap.set(id, normalizeStringArray(raw.blocks));
  }

  // Merge edges from input.edges + item.blocked_by + item.blocks
  const cycleWarnings = [];
  const edgeSet = new Set();
  const edges = [];

  function addEdge(fromId, toId) {
    if (!itemById.has(fromId) || !itemById.has(toId)) return;
    if (fromId === toId) {
      const msg = `Self-dependency cycle ignored on ${fromId} -> ${toId}`;
      if (!cycleWarnings.includes(msg)) cycleWarnings.push(msg);
      return;
    }
    const key = `${fromId}\u0000${toId}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ from: fromId, to: toId, kind: "blocks" });
  }

  if (Array.isArray(input.edges)) {
    for (const e of input.edges) {
      if (!e || typeof e !== "object") continue;
      if (e.kind && e.kind !== "blocks") continue;
      const fromId = typeof e.from === "string" ? e.from.trim() : "";
      const toId = typeof e.to === "string" ? e.to.trim() : "";
      if (fromId && toId) addEdge(fromId, toId);
    }
  }

  for (const [id, blockers] of rawBlockedByMap.entries()) {
    for (const blockerId of blockers) {
      addEdge(blockerId, id);
    }
  }
  for (const [id, blocked] of rawBlocksMap.entries()) {
    for (const targetId of blocked) {
      addEdge(id, targetId);
    }
  }

  edges.sort((a, b) => {
    const c = compareNaturalId(a.from, b.from);
    return c !== 0 ? c : compareNaturalId(a.to, b.to);
  });

  // Populate item.blocked_by and item.blocks deterministically
  const parentsMap = new Map();
  const childrenMap = new Map();
  for (const id of itemById.keys()) {
    parentsMap.set(id, []);
    childrenMap.set(id, []);
  }
  for (const e of edges) {
    childrenMap.get(e.from).push(e.to);
    parentsMap.get(e.to).push(e.from);
  }
  for (const [id, item] of itemById.entries()) {
    item.blocked_by = [...parentsMap.get(id)].sort(compareNaturalId);
    item.blocks = [...childrenMap.get(id)].sort(compareNaturalId);
  }

  // Deterministic tie-break comparator for ordering items
  function compareItemsDeterministic(a, b) {
    const projA = a.project_id ? projectMap.get(a.project_id)?.name || a.project_id : "~";
    const projB = b.project_id ? projectMap.get(b.project_id)?.name || b.project_id : "~";
    const pCmp = projA.localeCompare(projB, "en", { sensitivity: "base" });
    if (pCmp !== 0) return pCmp;

    const msA = a.milestone_id ? milestoneMap.get(a.milestone_id)?.sort_order ?? 9999 : 9999;
    const msB = b.milestone_id ? milestoneMap.get(b.milestone_id)?.sort_order ?? 9999 : 9999;
    if (msA !== msB) return msA - msB;

    const prDiff = priorityRank(a.priority) - priorityRank(b.priority);
    if (prDiff !== 0) return prDiff;

    return compareNaturalId(a.id, b.id);
  }

  const allItems = [...itemById.values()].sort(compareItemsDeterministic);
  const detRank = new Map(allItems.map((it, idx) => [it.id, idx]));

  // Derive tech_status
  for (const item of allItems) {
    if (item.status_type === "completed") {
      item.tech_status = "done";
    } else if (item.status_type === "canceled") {
      item.tech_status = "canceled";
    } else if (item.status_type === "started") {
      item.tech_status = /review/i.test(item.status_name)
        ? "in_review"
        : "in_progress";
    } else {
      // Unstarted / backlog / triage — check upstream blockers
      const hasOpenBlocker = item.blocked_by.some((bid) => {
        const blocker = itemById.get(bid);
        return (
          blocker &&
          blocker.status_type !== "completed" &&
          blocker.status_type !== "canceled"
        );
      });
      item.tech_status = hasOpenBlocker ? "blocked" : "ready";
    }
  }

  // Kahn's topological sort with deterministic cycle breaking
  const inDegree = new Map();
  for (const item of allItems) {
    inDegree.set(item.id, item.blocked_by.length);
  }

  const placed = new Set();
  const topoOrder = [];
  const brokenEdgeKeys = new Set();
  const tierMap = new Map();

  function getReadyQueue() {
    const ready = [];
    for (const item of allItems) {
      if (!placed.has(item.id) && inDegree.get(item.id) === 0) {
        ready.push(item.id);
      }
    }
    return ready;
  }

  while (placed.size < allItems.length) {
    let queue = getReadyQueue();

    if (queue.length === 0) {
      // Dependency cycle detected: choose remaining node with lowest in-degree (tie-break deterministically)
      const remaining = allItems.filter((it) => !placed.has(it.id));
      remaining.sort((a, b) => {
        const dDiff = inDegree.get(a.id) - inDegree.get(b.id);
        return dDiff !== 0 ? dDiff : detRank.get(a.id) - detRank.get(b.id);
      });
      const chosen = remaining[0];
      const unplacedBlockers = chosen.blocked_by.filter((bid) => !placed.has(bid));
      for (const bid of unplacedBlockers) {
        brokenEdgeKeys.add(`${bid}\u0000${chosen.id}`);
        cycleWarnings.push(
          `Dependency cycle detected: broke back-edge ${bid} -> ${chosen.id} for topological layout`
        );
      }
      inDegree.set(chosen.id, 0);
      queue = [chosen.id];
    }

    // Pop first item in deterministic rank order
    queue.sort((a, b) => detRank.get(a) - detRank.get(b));
    const currentId = queue[0];
    placed.add(currentId);
    topoOrder.push(currentId);

    const currentItem = itemById.get(currentId);
    let maxParentTier = -1;
    for (const parentId of currentItem.blocked_by) {
      if (brokenEdgeKeys.has(`${parentId}\u0000${currentId}`)) continue;
      const pTier = tierMap.get(parentId);
      if (pTier !== undefined && pTier > maxParentTier) {
        maxParentTier = pTier;
      }
    }
    const assignedTier = maxParentTier + 1;
    tierMap.set(currentId, assignedTier);
    currentItem.tier = assignedTier;

    for (const childId of currentItem.blocks) {
      if (placed.has(childId)) continue;
      if (brokenEdgeKeys.has(`${currentId}\u0000${childId}`)) continue;
      inDegree.set(childId, Math.max(0, inDegree.get(childId) - 1));
    }
  }

  // Remaining-work Critical Path (estimate-weighted; defaults to 1 when unestimated)
  const isRemaining = (item) =>
    item.tech_status !== "done" && item.tech_status !== "canceled";
  const weightOf = (item) =>
    typeof item.estimate === "number" && Number.isFinite(item.estimate) && item.estimate > 0
      ? item.estimate
      : 1;

  const bestWeight = new Map();
  const bestLen = new Map();
  const bestPrev = new Map();

  for (const id of topoOrder) {
    const item = itemById.get(id);
    if (!isRemaining(item)) continue;
    const w = weightOf(item);
    let bestPWeight = 0;
    let bestPLen = 0;
    let chosenParent = null;

    for (const parentId of item.blocked_by) {
      if (brokenEdgeKeys.has(`${parentId}\u0000${id}`)) continue;
      const parent = itemById.get(parentId);
      if (!parent || !isRemaining(parent)) continue;
      const pw = bestWeight.get(parentId) ?? 0;
      const pl = bestLen.get(parentId) ?? 0;
      if (
        pw > bestPWeight ||
        (pw === bestPWeight && pl > bestPLen) ||
        (pw === bestPWeight &&
          pl === bestPLen &&
          chosenParent !== null &&
          detRank.get(parentId) < detRank.get(chosenParent))
      ) {
        bestPWeight = pw;
        bestPLen = pl;
        chosenParent = parentId;
      }
    }

    bestWeight.set(id, w + bestPWeight);
    bestLen.set(id, 1 + bestPLen);
    bestPrev.set(id, chosenParent);
  }

  let bestEndId = null;
  let maxCpWeight = 0;
  let maxCpLen = 0;

  for (const id of topoOrder) {
    if (!bestWeight.has(id)) continue;
    const w = bestWeight.get(id);
    const l = bestLen.get(id);
    if (
      w > maxCpWeight ||
      (w === maxCpWeight && l > maxCpLen) ||
      (w === maxCpWeight &&
        l === maxCpLen &&
        bestEndId !== null &&
        detRank.get(id) < detRank.get(bestEndId))
    ) {
      maxCpWeight = w;
      maxCpLen = l;
      bestEndId = id;
    }
  }

  const criticalPathIds = [];
  let cursor = bestEndId;
  while (cursor) {
    criticalPathIds.push(cursor);
    cursor = bestPrev.get(cursor) || null;
  }
  criticalPathIds.reverse();
  const cpSet = new Set(criticalPathIds);

  for (const item of allItems) {
    item.on_critical_path = cpSet.has(item.id);
    item.next_prompt = buildNextPrompt(item, itemById);
  }

  // Final item sort: tier asc, then deterministic ordering
  const sortedItems = [...allItems].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return detRank.get(a.id) - detRank.get(b.id);
  });

  // Sort projects and milestones deterministically
  const projects = [...projectMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );
  const milestones = [...milestoneMap.values()].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    const nameCmp = a.name.localeCompare(b.name, "en", { sensitivity: "base" });
    return nameCmp !== 0 ? nameCmp : compareNaturalId(a.id, b.id);
  });

  // Summary counts & points
  const summary = {
    total: sortedItems.length,
    done: 0,
    in_progress: 0,
    in_review: 0,
    ready: 0,
    blocked: 0,
    canceled: 0,
    total_points: 0,
    completed_points: 0,
    remaining_points: 0,
    ready_ids: [],
    critical_path_ids: criticalPathIds,
    critical_path_points: maxCpWeight,
    cycle_warnings: cycleWarnings,
  };

  for (const item of sortedItems) {
    if (item.tech_status in summary) {
      summary[item.tech_status] += 1;
    }
    const pts = typeof item.estimate === "number" ? item.estimate : 0;
    if (item.tech_status !== "canceled") {
      summary.total_points += pts;
    }
    if (item.tech_status === "done") {
      summary.completed_points += pts;
    } else if (item.tech_status !== "canceled") {
      summary.remaining_points += pts;
    }
    if (item.tech_status === "ready") {
      summary.ready_ids.push(item.id);
    }
  }

  return {
    schema_version: WORK_GRAPH_SCHEMA_VERSION,
    graph_type: WORK_GRAPH_TYPE,
    generated_at: nowIso,
    source,
    projects,
    milestones,
    summary,
    items: sortedItems,
    edges,
  };
}

/**
 * Load and analyze a work-graph JSON file from disk.
 */
export function loadWorkGraphFile(filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Work-graph file not found: ${absPath}`);
  }
  const raw = fs.readFileSync(absPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in work-graph file (${absPath}): ${err.message}`);
  }
  return analyzeWorkGraph(parsed, { defaultSourceKind: "local_file" });
}
