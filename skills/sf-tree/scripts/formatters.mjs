const MERMAID_IDS = Object.freeze({
  vision: "V",
  "market-research": "MR",
  brd: "BRD",
  prd: "PRD",
  ux: "UX",
  ui: "UI",
  mockery: "MOCK",
  architecture: "ARCH",
  specs: "SPECS",
});

function statusTag(node) {
  const tags = [];
  switch (node.status) {
    case "reviewed_pass":
      tags.push("PASS");
      break;
    case "reviewed_fail":
      tags.push("FAIL");
      break;
    case "unreviewed":
      tags.push("UNREVIEWED");
      break;
    case "unlocked":
      tags.push("UNLOCKED");
      break;
    case "invalid":
      tags.push("INVALID");
      break;
    default:
      tags.push("LOCKED");
      break;
  }
  if (node.is_stale) {
    tags.push("STALE");
  }
  const latestReview = node.reviews && node.reviews[0];
  if (latestReview && latestReview.is_stale && !node.is_stale) {
    tags.push("REVIEW STALE");
  }
  return tags.join(" · ");
}

function mermaidClassForNode(node) {
  if (node.status === "invalid") return "invalid";
  if (node.status === "reviewed_fail") return "fail";
  if (node.is_stale) return "stale";
  switch (node.status) {
    case "reviewed_pass":
      return "pass";
    case "unreviewed":
      return "unreviewed";
    case "unlocked":
      return "unlocked";
    default:
      return "locked";
  }
}

function escapeMermaidLabel(text) {
  return String(text).replaceAll('"', "'");
}

/**
 * Render a deterministic color-coded Mermaid flowchart LR diagram.
 */
export function formatMermaid(graph) {
  const lines = ["flowchart LR"];
  const nodeByPhase = new Map(graph.nodes.map((n) => [n.phase, n]));

  for (const node of graph.nodes) {
    const id = MERMAID_IDS[node.phase] || node.phase.toUpperCase();
    const optionalTag = node.optional ? " (Optional)" : "";
    const fidelityTag =
      node.phase === "mockery" && graph.mockery?.fidelity
        ? ` [${graph.mockery.fidelity}]`
        : "";
    const label = escapeMermaidLabel(
      `${node.stage}. ${node.skill}${optionalTag}${fidelityTag}\\n[${statusTag(node)}]`
    );
    lines.push(`    ${id}["${label}"]`);
  }

  for (const edge of graph.edges) {
    const fromId = MERMAID_IDS[edge.from] || edge.from.toUpperCase();
    const toId = MERMAID_IDS[edge.to] || edge.to.toUpperCase();
    if (edge.kind === "required") {
      lines.push(`    ${fromId} --> ${toId}`);
    } else if (edge.kind === "recommended") {
      lines.push(`    ${fromId} -. "recommended" .-> ${toId}`);
    } else {
      let edgeLabel = "optional";
      if (edge.to === "mockery" && edge.from === "ux") {
        edgeLabel = "optional wireframe";
      } else if (edge.to === "mockery" && edge.from === "ui") {
        edgeLabel = "optional styled";
      }
      if (edge.from === "vision" && edge.to === "mockery") {
        lines.push(`    ${fromId} -.-> ${toId}`);
      } else {
        lines.push(`    ${fromId} -. "${edgeLabel}" .-> ${toId}`);
      }
    }
  }

  lines.push("");
  lines.push("    classDef pass fill:#14532d,stroke:#22c55e,color:#f0fdf4,stroke-width:2px");
  lines.push("    classDef fail fill:#7f1d1d,stroke:#ef4444,color:#fef2f2,stroke-width:2px");
  lines.push("    classDef stale fill:#78350f,stroke:#f59e0b,color:#fffbeb,stroke-width:2px,stroke-dasharray: 5 3");
  lines.push("    classDef unreviewed fill:#1e3a8a,stroke:#60a5fa,color:#eff6ff,stroke-width:2px");
  lines.push("    classDef unlocked fill:#0f766e,stroke:#2dd4bf,color:#f0fdfa,stroke-width:2px,stroke-dasharray: 4 2");
  lines.push("    classDef locked fill:#1f2937,stroke:#6b7280,color:#d1d5db,stroke-width:1px");
  lines.push("    classDef invalid fill:#701a75,stroke:#e879f9,color:#fdf4ff,stroke-width:2px");

  for (const node of graph.nodes) {
    const id = MERMAID_IDS[node.phase] || node.phase.toUpperCase();
    const cls = mermaidClassForNode(node);
    if (nodeByPhase.has(node.phase)) {
      lines.push(`    class ${id} ${cls}`);
    }
  }

  return lines.join("\n");
}

function asciiBadge(node) {
  let base;
  switch (node.status) {
    case "reviewed_pass":
      base = "PASS";
      break;
    case "reviewed_fail":
      base = "FAIL";
      break;
    case "unreviewed":
      base = "UNREV";
      break;
    case "unlocked":
      base = "OPEN";
      break;
    case "invalid":
      base = "ERR";
      break;
    default:
      base = "LOCK";
      break;
  }
  return node.is_stale ? `${base}+STALE` : base;
}

function padRight(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

/**
 * Render a deterministic terminal-friendly ASCII pipeline tech-tree view.
 */
export function formatAscii(graph) {
  const lines = [];
  const s = graph.summary;

  lines.push(`Software Factory Tech-Tree — ${graph.project_name}`);
  lines.push(`Workspace: ${graph.workspace_root}`);
  lines.push(
    `Core: ${s.core_completed}/${s.core_total} | Optional: ${s.optional_completed}/1 | Unlocked: ${s.unlocked_phases.length} | Stale: ${s.stale_phases.length} | Failing Reviews: ${s.failing_review_phases.length} | Invalid: ${s.invalid_phases.length}`
  );
  lines.push("=".repeat(88));

  for (const node of graph.nodes) {
    const stageCol = padRight(`${node.stage}.`, 4);
    const skillCol = padRight(
      `${node.skill}${node.optional ? " (opt)" : ""}`,
      24
    );
    const statusCol = padRight(`[${asciiBadge(node)}]`, 14);
    const latestReview = node.reviews[0] || null;
    const reviewCol = latestReview
      ? `review:${latestReview.verdict}${latestReview.is_stale ? "(stale)" : ""}`
      : node.exists
        ? "review:none"
        : "";
    lines.push(`${stageCol}${skillCol}${statusCol}${padRight(node.file, 34)}${reviewCol}`);

    if (node.state_errors.length > 0) {
      for (const err of node.state_errors) {
        lines.push(`      ! error: ${err}`);
      }
    }
    if (node.stale_reasons.length > 0) {
      for (const reason of node.stale_reasons) {
        lines.push(`      ~ stale: ${reason}`);
      }
    }
    if (node.warnings.length > 0) {
      for (const warn of node.warnings) {
        lines.push(`      * warn:  ${warn}`);
      }
    }
    if (latestReview && latestReview.verdict === "FAIL" && latestReview.blocking_issues.length > 0) {
      for (const issue of latestReview.blocking_issues) {
        lines.push(`      x block: ${issue}`);
      }
    }
  }

  if (graph.mockery && (graph.mockery.manifest_exists || graph.mockery.flow_json_exists)) {
    const m = graph.mockery;
    lines.push("-".repeat(88));
    lines.push(
      `Mockery (6b): fidelity=${m.fidelity || "unknown"} | tokens_synced=${String(m.tokens_synced_from_ui)} | screens=${m.screens_count} | components=${m.components_count} | edges=${m.edges_count}`
    );
    lines.push(`  viewer: ${m.viewer_command}`);
    lines.push(`  check:  ${m.check_command}`);
  }

  const actionable = graph.nodes.filter(
    (n) =>
      n.status === "invalid" ||
      n.status === "reviewed_fail" ||
      n.is_stale ||
      n.status === "unlocked" ||
      (n.status === "unreviewed" && n.phase !== "vision") ||
      (n.reviews[0] && n.reviews[0].is_stale)
  );

  if (actionable.length > 0) {
    lines.push("-".repeat(88));
    lines.push("Recommended Next Steps:");
    for (const node of actionable) {
      lines.push(`  - [${node.stage} ${node.skill}] ${node.next_prompt}`);
    }
  }

  return lines.join("\n");
}

function workMermaidId(id) {
  return "W_" + String(id).replace(/[^A-Za-z0-9_]/g, "_");
}

function truncateLabel(text, maxLen = 42) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

function workStatusLabel(techStatus) {
  switch (techStatus) {
    case "done":
      return "DONE";
    case "in_review":
      return "IN REVIEW";
    case "in_progress":
      return "IN PROGRESS";
    case "ready":
      return "READY";
    case "blocked":
      return "BLOCKED";
    case "canceled":
      return "CANCELED";
    default:
      return String(techStatus || "UNKNOWN").toUpperCase();
  }
}

/**
 * Render a deterministic color-coded Mermaid flowchart LR diagram for a work-graph v1 payload.
 */
export function formatWorkMermaid(workGraph) {
  const lines = ["flowchart LR"];
  const items = Array.isArray(workGraph.items) ? workGraph.items : [];
  const edges = Array.isArray(workGraph.edges) ? workGraph.edges : [];
  const cpIds = workGraph.summary?.critical_path_ids || [];

  const cpEdgeSet = new Set();
  for (let i = 0; i < cpIds.length - 1; i += 1) {
    cpEdgeSet.add(`${cpIds[i]}\u0000${cpIds[i + 1]}`);
  }

  for (const item of items) {
    const mid = workMermaidId(item.id);
    const pts = item.estimate !== null && item.estimate !== undefined ? `${item.estimate} pts` : "unest";
    const cpMark = item.on_critical_path ? " · CP" : "";
    const label = escapeMermaidLabel(
      `${item.id}: ${truncateLabel(item.title, 38)}\\n[${workStatusLabel(item.tech_status)} · ${pts}${cpMark}]`
    );
    lines.push(`    ${mid}["${label}"]`);
  }

  for (const edge of edges) {
    const fromId = workMermaidId(edge.from);
    const toId = workMermaidId(edge.to);
    if (cpEdgeSet.has(`${edge.from}\u0000${edge.to}`)) {
      lines.push(`    ${fromId} ==> ${toId}`);
    } else {
      lines.push(`    ${fromId} --> ${toId}`);
    }
  }

  lines.push("");
  lines.push("    classDef done fill:#14532d,stroke:#22c55e,color:#f0fdf4,stroke-width:2px");
  lines.push("    classDef in_review fill:#3b0764,stroke:#a855f7,color:#faf5ff,stroke-width:2px");
  lines.push("    classDef in_progress fill:#1e3a8a,stroke:#60a5fa,color:#eff6ff,stroke-width:2px");
  lines.push("    classDef ready fill:#0f766e,stroke:#2dd4bf,color:#f0fdfa,stroke-width:2px,stroke-dasharray: 4 2");
  lines.push("    classDef blocked fill:#78350f,stroke:#f59e0b,color:#fffbeb,stroke-width:2px");
  lines.push("    classDef canceled fill:#1f2937,stroke:#6b7280,color:#9ca3af,stroke-width:1px");

  for (const item of items) {
    const mid = workMermaidId(item.id);
    const cls =
      item.tech_status === "done" ||
      item.tech_status === "in_review" ||
      item.tech_status === "in_progress" ||
      item.tech_status === "ready" ||
      item.tech_status === "blocked" ||
      item.tech_status === "canceled"
        ? item.tech_status
        : "ready";
    lines.push(`    class ${mid} ${cls}`);
  }

  return lines.join("\n");
}

function workAsciiBadge(techStatus) {
  switch (techStatus) {
    case "done":
      return "DONE";
    case "in_review":
      return "REVIEW";
    case "in_progress":
      return "ACTIVE";
    case "ready":
      return "READY";
    case "blocked":
      return "BLOCKED";
    case "canceled":
      return "CANCEL";
    default:
      return "OPEN";
  }
}

/**
 * Render a deterministic terminal-friendly ASCII Work-Item Tech-Tree.
 */
export function formatWorkAscii(workGraph) {
  const lines = [];
  const src = workGraph.source || {};
  const s = workGraph.summary || {};
  const items = Array.isArray(workGraph.items) ? workGraph.items : [];
  const projectById = new Map((workGraph.projects || []).map((p) => [p.id, p]));
  const milestoneById = new Map((workGraph.milestones || []).map((m) => [m.id, m]));

  const scopeLabel = src.team
    ? `${src.workspace || "workspace"} (${src.team})`
    : src.workspace || "workspace";
  lines.push(`Work-Item Tech-Tree — ${scopeLabel} [${src.kind || "local_file"}]`);
  lines.push(
    `Items: ${s.total ?? 0} (Done: ${s.done ?? 0} | Review: ${s.in_review ?? 0} | Active: ${s.in_progress ?? 0} | Ready: ${s.ready ?? 0} | Blocked: ${s.blocked ?? 0}) | Points: ${s.completed_points ?? 0}/${s.total_points ?? 0} (${s.remaining_points ?? 0} rem)`
  );
  if (Array.isArray(s.critical_path_ids) && s.critical_path_ids.length > 0) {
    lines.push(
      `Critical Path (${s.critical_path_points ?? 0} pts): ${s.critical_path_ids.join(" -> ")}`
    );
  } else {
    lines.push("Critical Path: none (no remaining uncompleted items)");
  }

  if (Array.isArray(s.cycle_warnings) && s.cycle_warnings.length > 0) {
    for (const warn of s.cycle_warnings) {
      lines.push(`! cycle warning: ${warn}`);
    }
  }

  lines.push("=".repeat(96));

  if (items.length === 0) {
    lines.push("(No work items found)");
    return lines.join("\n");
  }

  // Group by topological tier
  const tiers = new Map();
  for (const item of items) {
    const t = typeof item.tier === "number" ? item.tier : 0;
    if (!tiers.has(t)) tiers.set(t, []);
    tiers.get(t).push(item);
  }

  const sortedTierKeys = [...tiers.keys()].sort((a, b) => a - b);
  for (const tier of sortedTierKeys) {
    lines.push(`Tier ${tier}`);
    for (const item of tiers.get(tier)) {
      const idCol = padRight(item.id, 10);
      const badgeCol = padRight(`[${workAsciiBadge(item.tech_status)}]`, 11);
      const ptsCol = padRight(
        item.estimate !== null && item.estimate !== undefined ? `${item.estimate}p` : "-",
        4
      );
      const cpCol = item.on_critical_path ? "*CP " : "    ";
      const proj = item.project_id ? projectById.get(item.project_id)?.name : null;
      const ms = item.milestone_id ? milestoneById.get(item.milestone_id)?.name : null;
      const scopeHint = [proj, ms].filter(Boolean).join(" / ");
      lines.push(
        `  ${idCol}${badgeCol}${ptsCol}${cpCol}${truncateLabel(item.title, 62)}`
      );
      if (scopeHint) {
        lines.push(`      scope:   ${scopeHint}`);
      }
      if (item.blocked_by && item.blocked_by.length > 0) {
        lines.push(`      blocked: <- ${item.blocked_by.join(", ")}`);
      }
      if (item.blocks && item.blocks.length > 0) {
        lines.push(`      unlocks: -> ${item.blocks.join(", ")}`);
      }
    }
  }

  const readyItems = items.filter((it) => it.tech_status === "ready");
  if (readyItems.length > 0) {
    lines.push("-".repeat(96));
    lines.push("Ready / Unlocked Next Work:");
    for (const item of readyItems) {
      lines.push(`  - [${item.id}] ${item.next_prompt}`);
    }
  }

  return lines.join("\n");
}
