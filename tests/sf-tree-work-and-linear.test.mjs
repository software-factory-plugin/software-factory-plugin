import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeWorkGraph,
  compareNaturalId,
  loadWorkGraphFile,
  sanitizeHttpUrl,
} from "../skills/sf-tree/scripts/work-analyzer.mjs";
import {
  escapeMermaidLabel,
  formatAscii,
  formatMermaid,
  formatWorkAscii,
  formatWorkMermaid,
  workMermaidId,
} from "../skills/sf-tree/scripts/formatters.mjs";
import {
  fetchLinearGraph,
  normalizeLinearMcpPayload,
  parseRetryAfterMs,
} from "../skills/sf-tree/scripts/linear-adapter.mjs";
import { analyzeWorkspace } from "../skills/sf-tree/scripts/analyzer.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PULSEBOARD_DIR = path.join(REPO_ROOT, "evals", "fixtures", "pulseboard");

function makeTempDir(prefix = "sf-tree-work-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeJsonRes(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("work-analyzer: diamond DAG tiers, derived tech_status, and remaining Critical Path weighting", () => {
  const wg = analyzeWorkGraph({
    projects: [{ id: "p1", name: "Core", url: "https://linear.app/team/project/core" }],
    milestones: [{ id: "m1", project_id: "p1", name: "M1", sort_order: 1 }],
    items: [
      { id: "ENG-1", title: "Root done", status: "Done", status_type: "completed", project_id: "p1", estimate: 2 },
      { id: "ENG-2", title: "Light branch", status: "Todo", project_id: "p1", estimate: 2, blocked_by: ["ENG-1"] },
      { id: "ENG-10", title: "Heavy branch", status: "In Progress", status_type: "started", project_id: "p1", estimate: 5, blocked_by: ["ENG-1"] },
      { id: "ENG-11", title: "Diamond join", status: "Todo", project_id: "p1", estimate: 3, blocked_by: ["ENG-2", "ENG-10"] },
      { id: "ENG-12", title: "In review standalone", status: "In Review", status_type: "started", project_id: "p1", estimate: 1 },
    ],
  });

  const byId = new Map(wg.items.map((i) => [i.id, i]));
  assert.equal(byId.get("ENG-1").tier, 0);
  assert.equal(byId.get("ENG-2").tier, 1);
  assert.equal(byId.get("ENG-10").tier, 1);
  assert.equal(byId.get("ENG-11").tier, 2);

  // Derived statuses
  assert.equal(byId.get("ENG-1").tech_status, "done");
  assert.equal(byId.get("ENG-2").tech_status, "ready");
  assert.equal(byId.get("ENG-10").tech_status, "in_progress");
  assert.equal(byId.get("ENG-11").tech_status, "blocked");
  assert.equal(byId.get("ENG-12").tech_status, "in_review");

  // Critical path excludes completed ENG-1 and chooses heavy branch ENG-10 (5) -> ENG-11 (3) = 8 pts
  assert.deepEqual(wg.summary.critical_path_ids, ["ENG-10", "ENG-11"]);
  assert.equal(wg.summary.critical_path_points, 8);
  assert.equal(wg.summary.critical_path_weight, 8);
  assert.equal(wg.summary.completed_points, 2);
  assert.equal(wg.summary.remaining_points, 11);

  // Natural ID sorting: ENG-2 strictly before ENG-10
  assert.ok(compareNaturalId("ENG-2", "ENG-10") < 0);
  const tier1Ids = wg.items.filter((i) => i.tier === 1).map((i) => i.id);
  assert.deepEqual(tier1Ids, ["ENG-2", "ENG-10"]);
});

test("work-analyzer: Tarjan SCC cycle-breaking preserves non-cycle downstream edges, handles multi-SCC & self-loops", () => {
  // Single cycle A<->B plus downstream C (A->C must never be broken)
  const wg = analyzeWorkGraph({
    items: [
      { id: "A", title: "Cycle A", status: "todo", priority: 3, estimate: 2, blocked_by: ["B"] },
      { id: "B", title: "Cycle B", status: "todo", priority: 3, estimate: 2, blocked_by: ["A"] },
      { id: "C", title: "High-prio downstream", status: "todo", priority: 1, estimate: 5, blocked_by: ["A"] },
    ],
  });

  const byId = new Map(wg.items.map((i) => [i.id, i]));
  assert.ok(byId.get("C").tier > byId.get("A").tier, "C must remain strictly downstream of A");
  assert.ok(wg.summary.critical_path_ids.includes("C"), "C must stay on the Critical Path");
  assert.ok(wg.summary.critical_path_ids.includes("A"), "A must stay on the Critical Path");
  assert.equal(
    wg.summary.cycle_warnings.some((w) => w.includes("A -> C")),
    false,
    "Valid edge A -> C must never be broken"
  );

  // Multi-SCC (A<->B feeding C<->D) + self-loop (X->X)
  const multi = analyzeWorkGraph({
    items: [
      { id: "A", title: "SCC1 A", status: "todo", blocked_by: ["B"] },
      { id: "B", title: "SCC1 B", status: "todo", blocked_by: ["A"] },
      { id: "C", title: "SCC2 C", status: "todo", blocked_by: ["B", "D"] },
      { id: "D", title: "SCC2 D", status: "todo", blocked_by: ["C"] },
      { id: "X", title: "Self loop", status: "todo", blocked_by: ["X"] },
    ],
  });
  const mById = new Map(multi.items.map((i) => [i.id, i]));
  assert.equal(multi.items.length, 5);
  assert.ok(mById.get("C").tier > mById.get("B").tier, "Inter-SCC edge B -> C must remain intact");
  assert.ok(multi.summary.cycle_warnings.some((w) => /Self-dependency.*X -> X/.test(w)));
  assert.equal(
    multi.summary.cycle_warnings.some((w) => w.includes("B -> C")),
    false,
    "Inter-SCC edge B -> C must never be severed"
  );
});

test("work-analyzer: duplicate IDs warn, critical_path_weight vs critical_path_points separation, https-only URLs, projectless sort, and file loader", () => {
  assert.equal(sanitizeHttpUrl("https://linear.app/a"), "https://linear.app/a");
  assert.equal(sanitizeHttpUrl("http://insecure.example/a"), null);
  assert.equal(sanitizeHttpUrl("javascript:alert(1)"), null);
  assert.equal(sanitizeHttpUrl("data:text/html,hi"), null);

  const wg = analyzeWorkGraph({
    projects: [{ id: "p1", name: "Alpha" }],
    items: [
      {
        id: "SOF-1",
        title: "First",
        status: "todo",
        project_id: "p1",
        estimate: null,
        url: "http://insecure.example/1",
        prs: [
          { title: "Unsafe", url: "http://insecure.example/pr/1" },
          { title: "JS", url: "javascript:alert(1)" },
          { title: "Safe", url: "https://github.com/org/repo/pull/1" },
        ],
      },
      { id: "SOF-1", title: "Duplicate should warn", status: "todo", project_id: "p1", estimate: 5 },
      { id: "SOF-2", title: "No project", status: "todo", project_id: null, estimate: null, blocked_by: ["SOF-1"] },
    ],
  });

  assert.equal(wg.items.length, 2);
  const warnings = wg.warnings || wg.summary.warnings || [];
  assert.ok(warnings.some((w) => /duplicate/i.test(w)));
  assert.equal(wg.summary.remaining_points, 0);
  assert.equal(wg.summary.critical_path_points, 0);
  assert.ok(wg.summary.critical_path_points <= wg.summary.remaining_points);
  assert.equal(wg.summary.critical_path_weight, 2);

  const sof1 = wg.items.find((i) => i.id === "SOF-1");
  assert.equal(sof1.title, "First");
  assert.equal(sof1.url, null);
  assert.equal(sof1.prs.length, 1);
  assert.equal(sof1.prs[0].url, "https://github.com/org/repo/pull/1");

  // Projectless item sorts strictly after items with a project (even named "~")
  const wgSort = analyzeWorkGraph({
    projects: [
      { id: "A", name: "Alpha" },
      { id: "T", name: "~TildeProject" },
    ],
    items: [
      { id: "X-3", title: "No proj", status: "todo", project_id: null },
      { id: "X-2", title: "Tilde proj", status: "todo", project_id: "T" },
      { id: "X-1", title: "Alpha proj", status: "todo", project_id: "A" },
    ],
  });
  assert.equal(wgSort.items[2].id, "X-3");
  assert.equal(wgSort.items[0].project_id !== null && wgSort.items[1].project_id !== null, true);

  // loadWorkGraphFile round-trip + error on missing/invalid JSON
  const tmp = makeTempDir();
  try {
    const validPath = path.join(tmp, "work-graph.json");
    fs.writeFileSync(validPath, JSON.stringify({ items: [{ id: "T-1", title: "One", status: "todo" }] }));
    const loaded = loadWorkGraphFile(validPath);
    assert.equal(loaded.items.length, 1);

    const badPath = path.join(tmp, "bad.json");
    fs.writeFileSync(badPath, "{invalid");
    assert.throws(() => loadWorkGraphFile(badPath), /Invalid JSON/);
    assert.throws(() => loadWorkGraphFile(path.join(tmp, "missing.json")), /not found/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("formatters: Mermaid label escaping, collision-free workMermaidId, and ASCII/Mermaid rendering for work and pipeline graphs", () => {
  assert.notEqual(workMermaidId("ENG-1"), workMermaidId("ENG_1"));
  assert.match(workMermaidId("ENG-1"), /^W_[A-Za-z0-9_]+$/);

  const safe = escapeMermaidLabel('Fix <img src=x onerror="1"> & #quot; ; `tick`\nraw\\nline2');
  assert.equal(safe.includes("\n"), false);
  assert.equal(safe.includes("<"), false);
  assert.equal(safe.includes(">"), false);
  assert.equal(safe.includes('"'), false);
  assert.equal(safe.includes("`"), false);
  assert.equal(safe.includes("&"), false);
  assert.equal(safe.includes("#"), false);
  assert.equal(safe.includes(";"), false);
  assert.ok(safe.includes("\\n"));

  const wg = analyzeWorkGraph({
    projects: [{ id: "p1", name: "Core" }],
    items: [
      { id: "ENG-1", title: "One", status: "todo", project_id: "p1", estimate: 2 },
      { id: "ENG_1", title: "Two", status: "todo", project_id: "p1", estimate: 3, blocked_by: ["ENG-1"] },
    ],
  });
  const mmd = formatWorkMermaid(wg);
  assert.ok(mmd.startsWith("flowchart LR"));
  assert.ok(mmd.includes(workMermaidId("ENG-1")));
  assert.ok(mmd.includes(workMermaidId("ENG_1")));
  assert.ok(mmd.includes("==>"), "Critical path edge uses thick ==> arrow");

  const workAscii = formatWorkAscii(wg);
  assert.match(workAscii, /Work-Item Tech-Tree/);
  assert.match(workAscii, /Critical Path \(5 pts\): ENG-1 -> ENG_1/);
  assert.match(workAscii, /Ready \/ Unlocked Next Work:/);

  // Pipeline formatters on real PulseBoard fixture (copied under docs/factory)
  const tmp = makeTempDir("sf-fmt-pipe-");
  try {
    fs.cpSync(PULSEBOARD_DIR, path.join(tmp, "docs", "factory"), { recursive: true });
    const pipeGraph = analyzeWorkspace(tmp);
    const pipeMmd = formatMermaid(pipeGraph);
    assert.ok(pipeMmd.startsWith("flowchart LR"));
    assert.ok(pipeMmd.includes("V --> MR"));
    const pipeAscii = formatAscii(pipeGraph);
    assert.match(pipeAscii, /Software Factory Tech-Tree/);
    assert.match(pipeAscii, /Mockery \(6b\):/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("linear-adapter: pagination, truncation flags, AbortSignal timeout, 429/502/503/504 retries, team/project conflict, and secret redaction", async () => {
  assert.equal(parseRetryAfterMs("2"), 2000);
  const futureDate = new Date(1_700_000_010_000).toUTCString();
  assert.equal(parseRetryAfterMs(futureDate, 1_700_000_000_000), 10000);

  // 1. Timeout aborts hung fetchImpl
  await assert.rejects(
    () =>
      fetchLinearGraph({
        apiKey: "lin_test_secret_1",
        project: "Demo",
        timeoutMs: 40,
        maxRetries: 0,
        fetchImpl: (_url, opts) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () => reject(new Error("Aborted by timeout")));
          }),
      }),
    /timed out|Aborted/i
  );

  // 2. Secret redaction: LINEAR_API_KEY must never leak in connection or GraphQL error messages
  const secretKey = "lin_api_SUPER_SECRET_DO_NOT_LEAK_999";
  await assert.rejects(
    () =>
      fetchLinearGraph({
        apiKey: secretKey,
        team: "SOF",
        maxRetries: 0,
        fetchImpl: async () => {
          throw new Error(`network failure using token ${secretKey}`);
        },
      }),
    (err) => {
      assert.equal(err.message.includes(secretKey), false, "API key must be redacted from error");
      assert.ok(err.message.includes("[REDACTED]"));
      return true;
    }
  );
  await assert.rejects(
    () =>
      fetchLinearGraph({
        apiKey: secretKey,
        team: "SOF",
        maxRetries: 0,
        fetchImpl: async () =>
          makeJsonRes(200, { errors: [{ message: `Bad auth header ${secretKey}` }] }),
      }),
    (err) => {
      assert.equal(err.message.includes(secretKey), false, "API key must be redacted from GraphQL errors");
      assert.ok(err.message.includes("[REDACTED]"));
      return true;
    }
  );

  // 3. HTTP 429 (Retry-After) + 502 + 503 + 504 retries + multi-page pagination + relation/milestone truncation warnings
  let callCount = 0;
  const sleeps = [];
  const cursorsSeen = [];

  const result = await fetchLinearGraph({
    apiKey: "lin_test",
    team: "SOF",
    maxPages: 2,
    maxRetries: 4,
    baseBackoffMs: 10,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async (_url, opts) => {
      callCount += 1;
      const body = JSON.parse(opts.body);
      if (callCount === 1) {
        return makeJsonRes(429, { errors: [{ message: "Rate limited" }] }, { "retry-after": "1" });
      }
      if (callCount === 2) {
        return makeJsonRes(502, { errors: [{ message: "Bad gateway" }] });
      }
      if (callCount === 3) {
        return makeJsonRes(503, { errors: [{ message: "Unavailable" }] });
      }
      if (callCount === 4) {
        return makeJsonRes(504, { errors: [{ message: "Gateway timeout" }] });
      }
      if (body.query.includes("teams(")) {
        return makeJsonRes(200, {
          data: {
            organization: { name: "Org" },
            teams: {
              pageInfo: { hasNextPage: false },
              nodes: [{ id: "t1", key: "SOF", name: "Software Factory" }],
            },
            projects: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  id: "p1",
                  name: "Hardening",
                  state: "started",
                  teams: { nodes: [{ id: "t1", key: "SOF", name: "Software Factory" }] },
                  projectMilestones: { pageInfo: { hasNextPage: true }, nodes: [] },
                },
              ],
            },
          },
        });
      }
      cursorsSeen.push(body.variables.after);
      if (body.variables.after === null) {
        return makeJsonRes(200, {
          data: {
            issues: {
              pageInfo: { hasNextPage: true, endCursor: "cursor-page-2" },
              nodes: [
                {
                  id: "iss-1",
                  identifier: "SOF-1",
                  title: "Issue 1",
                  state: { name: "Todo", type: "unstarted" },
                  project: { id: "p1", name: "Hardening" },
                  relations: { pageInfo: { hasNextPage: true }, nodes: [{ type: "blocks", relatedIssue: { identifier: "SOF-2" } }] },
                  inverseRelations: { pageInfo: { hasNextPage: false }, nodes: [] },
                  labels: { nodes: [{ name: "security" }] },
                  attachments: { nodes: [{ title: "PR #1", url: "https://github.com/org/repo/pull/1" }] },
                },
              ],
            },
          },
        });
      }
      // Page 2 still has hasNextPage: true at maxPages: 2 -> triggers page-cap truncation warning
      return makeJsonRes(200, {
        data: {
          issues: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-page-3" },
            nodes: [
              {
                id: "iss-2",
                identifier: "SOF-2",
                title: "Issue 2",
                state: { name: "Todo", type: "unstarted" },
                project: { id: "p1", name: "Hardening" },
                relations: { pageInfo: { hasNextPage: false }, nodes: [] },
                inverseRelations: { pageInfo: { hasNextPage: false }, nodes: [] },
                labels: { nodes: [] },
                attachments: { nodes: [] },
              },
            ],
          },
        },
      });
    },
  });

  // Backoff delays: attempt 0 -> Retry-After 1000ms; attempt 1 -> 20ms; attempt 2 -> 40ms; attempt 3 -> 80ms
  assert.deepEqual(sleeps, [1000, 20, 40, 80]);
  assert.deepEqual(cursorsSeen, [null, "cursor-page-2"]);
  assert.equal(result.items.length, 2);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.some((w) => /milestones.*truncated/i.test(w)));
  assert.ok(result.warnings.some((w) => /2-page cap/i.test(w)));
  assert.ok(result.warnings.some((w) => /relations for issue SOF-1.*truncated/i.test(w)));

  // 4. Team/project conflict fails explicitly (no silent allProjects fallback)
  await assert.rejects(
    () =>
      fetchLinearGraph({
        apiKey: "lin_test",
        team: "SOF",
        project: "OtherTeamProj",
        maxRetries: 0,
        fetchImpl: async () =>
          makeJsonRes(200, {
            data: {
              organization: { name: "Org" },
              teams: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { id: "t1", key: "SOF", name: "SOF" },
                  { id: "t2", key: "OPS", name: "OPS" },
                ],
              },
              projects: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    id: "p2",
                    name: "OtherTeamProj",
                    state: "started",
                    teams: { nodes: [{ id: "t2", key: "OPS", name: "OPS" }] },
                    projectMilestones: { pageInfo: { hasNextPage: false }, nodes: [] },
                  },
                ],
              },
            },
          }),
      }),
    /does not belong to team|Conflicting Linear filters/i
  );

  // 5. normalizeLinearMcpPayload normalizes GraphQL relations and PR attachments
  const normalized = normalizeLinearMcpPayload({
    projects: [{ id: "p-1", slugId: "core", name: "Core", state: "started" }],
    issues: [
      {
        identifier: "SOF-10",
        title: "Parent",
        project: "Core",
        state: { name: "Todo", type: "unstarted" },
        relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "SOF-11" } }] },
        attachments: {
          nodes: [
            { title: "Spec Doc", url: "https://notion.so/doc" },
            { title: "Fix PR", url: "https://github.com/org/repo/pull/42" },
          ],
        },
      },
      {
        identifier: "SOF-11",
        title: "Child",
        project: "core",
        state: { name: "Todo", type: "unstarted" },
      },
    ],
  });
  assert.equal(normalized.items.find((i) => i.id === "SOF-10").prs.length, 1);
  assert.equal(normalized.items.find((i) => i.id === "SOF-11").tech_status, "blocked");
});
