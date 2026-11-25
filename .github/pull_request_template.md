## Summary

- What changed and why:

## Verification Checklist

- [ ] `npm run version:check` (`node scripts/bump-version.mjs --check`) passes
- [ ] `npm run eval` (`node evals/run.mjs --ascii`) passes with 0 failures
- [ ] `npm test` (`node --test tests/*.test.mjs`) passes with 0 failures
- [ ] `agy plugin validate --strict .` passes (if `agy` CLI is available)
- [ ] Zero third-party npm dependencies added (Node.js 22+ built-ins only)
- [ ] Zero always-on rule/hook/MCP files added (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `rules/`, `hooks/`, `mcp_config.json`, `docs/factory/`)
