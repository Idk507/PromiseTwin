# PromiseTwin — Claude Code build workspace

**Goal:** Build and submit an installable Atlassian Forge app that distinguishes engineering completion from independently verified customer promise fulfillment.

**Start here:** `docs/00-START-HERE.md`, then `CLAUDE.md`, `plans/00-MASTER-PLAN.md`. This repo contains **plans, contracts, agent instructions and automation**, not a completed Forge application. All CLI/Forge modules must be validated against live official documentation before implementation.

## Definition of the demo
A real JSM request creates a candidate promise; a human confirms; a real Jira task is linked and completed; the promise still remains UNVERIFIED; a separate trusted verification is recorded; customer-facing acknowledgement occurs; only then is fulfillment achieved. Negative path: wrong or stale evidence cannot fulfill.

## Documentation
`docs/` — architecture, setup, security, AI, APIs, UI, testing and observability. `plans/` — executable phases with gates. `contracts/` — data and status rules. `submission/` — judging and demo. `.claude/` — bounded skills, agents, rules and hooks. `scripts/` — safe developer helpers.

**Competition:** Deadline December 22, 2026 at 12pm PST. Video <5 minutes; judges may stop at 3. Installation link required. Read https://codegeist2026.devpost.com/rules .
