# P0-FEASIBILITY: Feasibility and novelty

## Objective
Verify eligibility and site access; compare current Product Collection/JSM features; establish Forge CLI and official plugin; scaffold app; validate live JSM read and Jira work linking; record exact permission scopes; verify Rovo/Graph/MCP separately without blocking core.

## Exact agent execution protocol
1. Review `CLAUDE.md`, `docs/STATUS.md`, `docs/DECISIONS.md`, the relevant product/architecture reference, and official current API docs via Forge MCP.
2. Write a bounded implementation plan listing files, target manifest modules, API scopes, security constraints, tests and evidence. Identify unsupported assumptions before coding.
3. Implement one vertical slice at a time. Keep pure domain logic independent from Forge infrastructure. Use fixtures from verified API shapes.
4. Write unit and negative tests with explicit assertions. Run typechecking, linting, tests and `forge lint` when project exists. Explain skips.
5. Test real dev environment only with operator approval; document commands, responses, screenshots or sanitized logs. Do not silently use production credentials.
6. Run `/security-gate` on changed boundaries and `/forge-evidence` for new Forge capabilities. Update `docs/STATUS.md` and `docs/DECISIONS.md`.
7. Stop and report gate outcome, risks, next minimal task; **do not** automatically advance to next phase.

## Gate / Definition of done
Working dev Forge app with real request read, consented scopes, reproduction commands, competitor-gap one-pager, signed go/no-go.

## Blockers and rollback
If required entitlement or API is missing: preserve functional core, document the constraint, choose a documented supported alternative, and request a human architecture decision. If tests fail: do not deploy; rollback only changes authored in this phase, not unrelated work. Persist results before session compaction.
