import process from "node:process";
import {
  analyzeWorkGraph,
  sanitizeHttpUrl,
  WORK_GRAPH_SCHEMA_VERSION,
  WORK_GRAPH_TYPE,
} from "./work-analyzer.mjs";

export const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 60000;
const MAX_GRAPHQL_PAGES = 20;
const DEFAULT_PAGE_SIZE = 100;
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });

/**
 * Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) into delay milliseconds.
 * Returns null if missing or unparseable.
 */
export function parseRetryAfterMs(headerValue, nowMs = Date.now()) {
  if (headerValue === null || headerValue === undefined) return null;
  const trimmed = String(headerValue).trim();
  if (!trimmed) return null;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const secs = Number(trimmed);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(MAX_BACKOFF_MS, Math.round(secs * 1000));
    }
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.min(MAX_BACKOFF_MS, Math.max(0, dateMs - nowMs));
  }

  return null;
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return null;
}

function extractPrAttachments(attachments) {
  const list = Array.isArray(attachments)
    ? attachments
    : Array.isArray(attachments?.nodes)
      ? attachments.nodes
      : [];
  const seen = new Set();
  const prs = [];
  for (const att of list) {
    if (!att || typeof att !== "object") continue;
    const url = sanitizeHttpUrl(att.url);
    if (!url || seen.has(url)) continue;
    // Include GitHub/GitLab/Bitbucket PRs & MRs or explicitly titled PR links
    const lower = url.toLowerCase();
    const title =
      typeof att.title === "string" && att.title.trim() ? att.title.trim() : url;
    const isPr =
      lower.includes("/pull/") ||
      lower.includes("/merge_requests/") ||
      lower.includes("/pull-requests/") ||
      /\bpr\s*#?\d+/i.test(title);
    if (!isPr) continue;
    seen.add(url);
    prs.push({ title, url });
  }
  return prs;
}

function extractLabels(rawLabels) {
  const list = Array.isArray(rawLabels)
    ? rawLabels
    : Array.isArray(rawLabels?.nodes)
      ? rawLabels.nodes
      : [];
  const out = [];
  for (const lbl of list) {
    if (typeof lbl === "string" && lbl.trim()) {
      out.push(lbl.trim());
    } else if (lbl && typeof lbl === "object" && typeof lbl.name === "string" && lbl.name.trim()) {
      out.push(lbl.name.trim());
    }
  }
  return out;
}

function extractRelationIds(rawList) {
  if (!Array.isArray(rawList)) return [];
  const ids = [];
  for (const entry of rawList) {
    if (typeof entry === "string" && entry.trim()) {
      ids.push(entry.trim());
    } else if (entry && typeof entry === "object") {
      const id = entry.identifier || entry.id;
      if (typeof id === "string" && id.trim()) {
        ids.push(id.trim());
      }
    }
  }
  return ids;
}

/**
 * Normalize raw Linear MCP payloads (projects, milestones, issues with relations/attachments)
 * into a fully analyzed canonical work-graph v1 payload.
 */
export function normalizeLinearMcpPayload(
  payload,
  {
    workspace,
    team,
    sourceKind = "linear_mcp",
    liveRefreshSupported = false,
    refreshedAt = new Date().toISOString(),
  } = {}
) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid Linear MCP payload: expected an object");
  }

  const rawProjects = Array.isArray(payload.projects) ? payload.projects : [];
  const rawMilestones = Array.isArray(payload.milestones) ? payload.milestones : [];
  const rawIssues = Array.isArray(payload.issues)
    ? payload.issues
    : Array.isArray(payload.items)
      ? payload.items
      : [];

  // Map project uuid / slugId / name / id -> canonical project id
  const projectKeyToId = new Map();
  const projects = [];
  const milestones = [];
  const seenMilestones = new Set();

  for (const p of rawProjects) {
    if (!p || typeof p !== "object") continue;
    const canonicalId =
      (typeof p.id === "string" && p.id.trim()) ||
      (typeof p.slugId === "string" && p.slugId.trim()) ||
      (typeof p.uuid === "string" && p.uuid.trim()) ||
      "";
    if (!canonicalId) continue;

    const statusStr =
      typeof p.status === "string"
        ? p.status
        : typeof p.status?.name === "string"
          ? p.status.name
          : typeof p.state === "string"
            ? p.state
            : "Unknown";

    projects.push({
      id: canonicalId,
      name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : canonicalId,
      status: statusStr,
      color: typeof p.color === "string" && p.color.trim() ? p.color.trim() : "#3B82F6",
      url: sanitizeHttpUrl(p.url),
    });

    projectKeyToId.set(canonicalId, canonicalId);
    if (typeof p.uuid === "string" && p.uuid.trim()) {
      projectKeyToId.set(p.uuid.trim(), canonicalId);
    }
    if (typeof p.slugId === "string" && p.slugId.trim()) {
      projectKeyToId.set(p.slugId.trim(), canonicalId);
    }
    if (typeof p.name === "string" && p.name.trim()) {
      projectKeyToId.set(p.name.trim(), canonicalId);
    }

    const nestedMs = Array.isArray(p.milestones)
      ? p.milestones
      : Array.isArray(p.projectMilestones?.nodes)
        ? p.projectMilestones.nodes
        : [];
    nestedMs.forEach((m, idx) => {
      if (!m || typeof m !== "object" || !m.id || seenMilestones.has(m.id)) return;
      seenMilestones.add(m.id);
      milestones.push({
        id: String(m.id),
        project_id: canonicalId,
        name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : String(m.id),
        sort_order:
          typeof m.sortOrder === "number"
            ? m.sortOrder
            : typeof m.sort_order === "number"
              ? m.sort_order
              : idx + 1,
      });
    });
  }

  rawMilestones.forEach((m, idx) => {
    if (!m || typeof m !== "object" || !m.id || seenMilestones.has(m.id)) return;
    seenMilestones.add(m.id);
    const rawProjKey = m.project_id || m.projectId || m.project?.id || m.project?.name || null;
    const resolvedProj = rawProjKey ? projectKeyToId.get(rawProjKey) || rawProjKey : null;
    milestones.push({
      id: String(m.id),
      project_id: resolvedProj,
      name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : String(m.id),
      sort_order:
        typeof m.sortOrder === "number"
          ? m.sortOrder
          : typeof m.sort_order === "number"
            ? m.sort_order
            : idx + 1,
    });
  });

  const items = [];
  for (const iss of rawIssues) {
    if (!iss || typeof iss !== "object") continue;
    const id =
      (typeof iss.identifier === "string" && iss.identifier.trim()) ||
      (typeof iss.id === "string" && iss.id.trim()) ||
      "";
    if (!id) continue;

    const statusName =
      (typeof iss.status === "string" && iss.status) ||
      (typeof iss.status_name === "string" && iss.status_name) ||
      (typeof iss.state?.name === "string" && iss.state.name) ||
      "Todo";
    const statusType =
      iss.statusType || iss.status_type || iss.state?.type || undefined;

    const rawProjKey =
      iss.project_id ||
      iss.projectId ||
      (typeof iss.project === "string" ? iss.project : iss.project?.id || iss.project?.name) ||
      null;
    const projectId = rawProjKey ? projectKeyToId.get(rawProjKey) || rawProjKey : null;

    const milestoneObj = iss.projectMilestone || iss.milestone || null;
    const milestoneId =
      iss.milestone_id ||
      iss.milestoneId ||
      (typeof milestoneObj === "object" && milestoneObj ? milestoneObj.id : null) ||
      null;
    if (
      milestoneObj &&
      typeof milestoneObj === "object" &&
      milestoneObj.id &&
      !seenMilestones.has(milestoneObj.id)
    ) {
      seenMilestones.add(milestoneObj.id);
      milestones.push({
        id: String(milestoneObj.id),
        project_id: projectId,
        name: milestoneObj.name || String(milestoneObj.id),
        sort_order:
          typeof milestoneObj.sortOrder === "number"
            ? milestoneObj.sortOrder
            : milestones.length + 1,
      });
    }

    const assignee =
      typeof iss.assignee === "string"
        ? iss.assignee
        : typeof iss.assignee?.name === "string"
          ? iss.assignee.name
          : null;

    const blockedBy = new Set([
      ...extractRelationIds(iss.blocked_by),
      ...extractRelationIds(iss.blockedBy),
      ...extractRelationIds(iss.relations?.blockedBy),
    ]);
    const blocks = new Set([
      ...extractRelationIds(iss.blocks),
      ...extractRelationIds(iss.relations?.blocks),
    ]);

    // GraphQL-shaped relations.nodes & inverseRelations.nodes
    if (Array.isArray(iss.relations?.nodes)) {
      for (const rel of iss.relations.nodes) {
        const target = rel?.relatedIssue?.identifier;
        if (!target) continue;
        if (rel.type === "blocks") blocks.add(target);
        if (rel.type === "blocked") blockedBy.add(target);
      }
    }
    if (Array.isArray(iss.inverseRelations?.nodes)) {
      for (const rel of iss.inverseRelations.nodes) {
        const source = rel?.issue?.identifier;
        if (!source) continue;
        if (rel.type === "blocks") blockedBy.add(source);
        if (rel.type === "blocked") blocks.add(source);
      }
    }

    items.push({
      id,
      title: iss.title || id,
      description: typeof iss.description === "string" ? iss.description : "",
      status_name: statusName,
      status_type: statusType,
      priority: iss.priority,
      estimate: iss.estimate,
      project_id: projectId,
      milestone_id: milestoneId,
      assignee,
      labels: extractLabels(iss.labels),
      git_branch: iss.git_branch || iss.gitBranchName || iss.branchName || null,
      url: sanitizeHttpUrl(iss.url),
      prs: Array.isArray(iss.prs) ? iss.prs : extractPrAttachments(iss.attachments),
      blocked_by: [...blockedBy],
      blocks: [...blocks],
    });
  }

  const resolvedWorkspace =
    workspace ||
    payload.workspace ||
    payload.source?.workspace ||
    "linear";
  const resolvedTeam =
    team ||
    payload.team ||
    payload.source?.team ||
    "";

  return analyzeWorkGraph(
    {
      schema_version: WORK_GRAPH_SCHEMA_VERSION,
      graph_type: WORK_GRAPH_TYPE,
      source: {
        kind: sourceKind,
        workspace: resolvedWorkspace,
        team: resolvedTeam,
        refreshed_at: refreshedAt,
        live_refresh_supported: liveRefreshSupported,
      },
      projects,
      milestones,
      items,
      edges: Array.isArray(payload.edges) ? payload.edges : [],
    },
    { defaultSourceKind: sourceKind }
  );
}

function redactSecret(message, secret) {
  const text = String(message || "Unknown error");
  if (!secret) return text;
  return text.split(secret).join("[REDACTED]");
}

async function runLinearGraphQL({
  query,
  variables,
  apiKey,
  endpoint,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  sleepImpl = defaultSleep,
}) {
  const effectiveRetries =
    typeof maxRetries === "number" && Number.isInteger(maxRetries) && maxRetries >= 0
      ? maxRetries
      : DEFAULT_MAX_RETRIES;
  const effectiveTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const effectiveBaseBackoff =
    typeof baseBackoffMs === "number" && Number.isFinite(baseBackoffMs) && baseBackoffMs >= 0
      ? baseBackoffMs
      : DEFAULT_BASE_BACKOFF_MS;

  let resp = null;
  for (let attempt = 0; attempt <= effectiveRetries; attempt += 1) {
    const signal = AbortSignal.timeout(effectiveTimeoutMs);
    let guardTimer = null;
    try {
      const fetchPromise = Promise.resolve().then(() =>
        fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: apiKey,
          },
          body: JSON.stringify({ query, variables }),
          signal,
        })
      );
      fetchPromise.catch(() => {});
      const timeoutPromise = new Promise((_resolve, reject) => {
        guardTimer = setTimeout(() => {
          const timeoutErr = new Error(
            `Linear GraphQL API request timed out after ${effectiveTimeoutMs}ms`
          );
          timeoutErr.name = "TimeoutError";
          reject(timeoutErr);
        }, effectiveTimeoutMs);
      });
      resp = await Promise.race([fetchPromise, timeoutPromise]);
    } catch (err) {
      if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new Error(
          `Linear GraphQL API request timed out after ${effectiveTimeoutMs}ms`
        );
      }
      throw new Error(
        `Failed to connect to Linear GraphQL API: ${redactSecret(err?.message, apiKey)}`
      );
    } finally {
      if (guardTimer) {
        clearTimeout(guardTimer);
        guardTimer = null;
      }
    }

    if (resp.status === 401 || resp.status === 403) {
      throw new Error(
        `Linear API authentication failed (HTTP ${resp.status}). Verify LINEAR_API_KEY is valid.`
      );
    }

    if (RETRYABLE_HTTP_STATUSES.has(resp.status) && attempt < effectiveRetries) {
      let delayMs = Math.min(
        MAX_BACKOFF_MS,
        Math.round(effectiveBaseBackoff * Math.pow(2, attempt))
      );
      if (resp.status === 429) {
        const retryAfterRaw = readHeader(resp.headers, "retry-after");
        const parsedRetryAfter = parseRetryAfterMs(retryAfterRaw);
        if (parsedRetryAfter !== null) {
          delayMs = parsedRetryAfter;
        }
      }
      await sleepImpl(delayMs);
      continue;
    }

    break;
  }

  if (!resp || !resp.ok) {
    throw new Error(`Linear GraphQL API returned HTTP ${resp ? resp.status : "unknown"}`);
  }

  let body;
  try {
    body = await resp.json();
  } catch (err) {
    throw new Error(`Invalid JSON response from Linear GraphQL API: ${err.message}`);
  }

  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const msgs = body.errors
      .map((e) => redactSecret(e?.message || "GraphQL error", apiKey))
      .join("; ");
    throw new Error(`Linear GraphQL error: ${msgs}`);
  }

  return body.data;
}

const METADATA_QUERY = `
  query SfTreeMetadata {
    organization {
      name
      urlKey
    }
    teams(first: 50) {
      pageInfo {
        hasNextPage
      }
      nodes {
        id
        key
        name
      }
    }
    projects(first: 100, includeArchived: false) {
      pageInfo {
        hasNextPage
      }
      nodes {
        id
        slugId
        name
        state
        color
        url
        teams {
          nodes {
            id
            key
            name
          }
        }
        projectMilestones(first: 50) {
          pageInfo {
            hasNextPage
          }
          nodes {
            id
            name
            sortOrder
          }
        }
      }
    }
  }
`;

const ISSUES_PAGE_QUERY = `
  query SfTreeIssues($filter: IssueFilter, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after, includeArchived: false) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        identifier
        title
        description
        priority
        estimate
        branchName
        url
        state {
          name
          type
        }
        project {
          id
          slugId
          name
        }
        projectMilestone {
          id
          name
          sortOrder
        }
        assignee {
          name
        }
        labels(first: 25) {
          nodes {
            name
          }
        }
        attachments(first: 25) {
          nodes {
            title
            url
          }
        }
        relations(first: 50) {
          pageInfo {
            hasNextPage
          }
          nodes {
            type
            relatedIssue {
              identifier
            }
          }
        }
        inverseRelations(first: 50) {
          pageInfo {
            hasNextPage
          }
          nodes {
            type
            issue {
              identifier
            }
          }
        }
      }
    }
  }
`;

function matchInsensitive(candidate, target) {
  if (!candidate || !target) return false;
  return String(candidate).trim().toLowerCase() === String(target).trim().toLowerCase();
}

/**
 * Fetch live project/team work-graph directly from Linear GraphQL API using LINEAR_API_KEY.
 * Strictly read-only; never logs, persists, or returns the API key.
 */
export async function fetchLinearGraph({
  project = null,
  team = null,
  apiKey = process.env.LINEAR_API_KEY,
  endpoint = LINEAR_GRAPHQL_ENDPOINT,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  sleepImpl = defaultSleep,
  maxPages = MAX_GRAPHQL_PAGES,
} = {}) {
  if (!project && !team) {
    throw new Error(
      "Direct Linear GraphQL mode requires --linear-project <id|slug|name> or --linear-team <key|name>"
    );
  }
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error(
      "LINEAR_API_KEY environment variable is required for direct Linear GraphQL mode. Export LINEAR_API_KEY or use --work-graph <path> with Linear MCP."
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Node.js 22+ native fetch is required for direct Linear GraphQL mode");
  }

  const cleanKey = apiKey.trim();
  const reqOpts = {
    apiKey: cleanKey,
    endpoint,
    fetchImpl,
    timeoutMs,
    maxRetries,
    baseBackoffMs,
    sleepImpl,
  };

  const meta = await runLinearGraphQL({
    query: METADATA_QUERY,
    variables: {},
    ...reqOpts,
  });

  const truncationWarnings = [];
  if (meta?.teams?.pageInfo?.hasNextPage === true) {
    truncationWarnings.push(
      "Linear teams metadata was truncated at 50 entries (hasNextPage=true)."
    );
  }
  if (meta?.projects?.pageInfo?.hasNextPage === true) {
    truncationWarnings.push(
      "Linear projects metadata was truncated at 100 entries (hasNextPage=true)."
    );
  }

  const orgName =
    meta?.organization?.urlKey || meta?.organization?.name || "linear";
  const allTeams = meta?.teams?.nodes || [];
  const allProjects = meta?.projects?.nodes || [];

  let matchedTeam = null;
  if (team) {
    matchedTeam =
      allTeams.find(
        (t) =>
          matchInsensitive(t.key, team) ||
          matchInsensitive(t.name, team) ||
          matchInsensitive(t.id, team)
      ) || null;
    if (!matchedTeam) {
      throw new Error(`Linear team not found: "${team}"`);
    }
  }

  let selectedProjects = allProjects;
  if (matchedTeam) {
    selectedProjects = selectedProjects.filter((p) =>
      (p.teams?.nodes || []).some((t) => t.id === matchedTeam.id)
    );
  }

  let matchedProject = null;
  if (project) {
    matchedProject =
      selectedProjects.find(
        (p) =>
          matchInsensitive(p.id, project) ||
          matchInsensitive(p.slugId, project) ||
          matchInsensitive(p.name, project)
      ) || null;

    if (!matchedProject) {
      if (matchedTeam) {
        const otherTeamProject = allProjects.find(
          (p) =>
            matchInsensitive(p.id, project) ||
            matchInsensitive(p.slugId, project) ||
            matchInsensitive(p.name, project)
        );
        if (otherTeamProject) {
          throw new Error(
            `Conflicting Linear filters: project "${otherTeamProject.name || project}" does not belong to team "${matchedTeam.key || matchedTeam.name}"`
          );
        }
      }
      throw new Error(`Linear project not found: "${project}"`);
    }

    selectedProjects = [matchedProject];
    if (!matchedTeam && matchedProject.teams?.nodes?.[0]) {
      matchedTeam = matchedProject.teams.nodes[0];
    }
  }

  for (const p of selectedProjects) {
    if (p?.projectMilestones?.pageInfo?.hasNextPage === true) {
      truncationWarnings.push(
        `Linear milestones for project "${p.name || p.id}" were truncated at 50 entries (hasNextPage=true).`
      );
    }
  }

  // Build issue filter
  const issueFilter = {};
  if (matchedProject) {
    issueFilter.project = { id: { eq: matchedProject.id } };
  } else if (matchedTeam) {
    issueFilter.team = { id: { eq: matchedTeam.id } };
  }

  // Paginate issues
  const pageLimit =
    typeof maxPages === "number" && Number.isInteger(maxPages) && maxPages > 0
      ? maxPages
      : MAX_GRAPHQL_PAGES;
  const collectedIssues = [];
  let cursor = null;
  let lastHasNextPage = false;

  for (let page = 0; page < pageLimit; page += 1) {
    const data = await runLinearGraphQL({
      query: ISSUES_PAGE_QUERY,
      variables: {
        filter: issueFilter,
        first: DEFAULT_PAGE_SIZE,
        after: cursor,
      },
      ...reqOpts,
    });
    const conn = data?.issues;
    const nodes = Array.isArray(conn?.nodes) ? conn.nodes : [];
    collectedIssues.push(...nodes);
    lastHasNextPage = Boolean(conn?.pageInfo?.hasNextPage);
    if (!lastHasNextPage || !conn?.pageInfo?.endCursor) {
      break;
    }
    cursor = conn.pageInfo.endCursor;
  }

  if (lastHasNextPage) {
    truncationWarnings.push(
      `Linear issues pagination reached the ${pageLimit}-page cap (${collectedIssues.length} issues fetched); graph is truncated and dependencies/Critical Path may be incomplete.`
    );
  }

  for (const iss of collectedIssues) {
    const relTrunc = iss?.relations?.pageInfo?.hasNextPage === true;
    const invTrunc = iss?.inverseRelations?.pageInfo?.hasNextPage === true;
    if (relTrunc || invTrunc) {
      truncationWarnings.push(
        `Linear dependency relations for issue ${iss.identifier || iss.id || "unknown"} were truncated at 50 entries; blockers/unlocks may be incomplete.`
      );
    }
  }

  const graph = normalizeLinearMcpPayload(
    {
      projects: selectedProjects,
      issues: collectedIssues,
    },
    {
      workspace: orgName,
      team: matchedTeam?.key || team || "",
      sourceKind: "linear_api",
      liveRefreshSupported: true,
      refreshedAt: new Date().toISOString(),
    }
  );

  const truncated = truncationWarnings.length > 0;
  graph.truncated = truncated;
  if (graph.source) {
    graph.source.truncated = truncated;
  }
  if (graph.summary) {
    graph.summary.truncated = truncated;
  }
  if (truncationWarnings.length > 0) {
    const existingWarnings = Array.isArray(graph.warnings) ? graph.warnings : [];
    const mergedWarnings = [...existingWarnings];
    for (const w of truncationWarnings) {
      if (!mergedWarnings.includes(w)) mergedWarnings.push(w);
    }
    graph.warnings = mergedWarnings;
    if (graph.summary) {
      graph.summary.warnings = [...mergedWarnings];
    }
  }

  return graph;
}
