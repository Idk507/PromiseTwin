# P5-ROVO: Rovo, AI and optional Graph/MCP

## Objective
Add read-only Rovo actions and grounded analyst; optional extraction only after deterministic core passes; evaluate output. Gate optional graph/MCP independently on live tenant and permissions.

## Exact agent execution protocol
1. Review `CLAUDE.md`, `docs/STATUS.md`, `docs/DECISIONS.md`, the relevant product/architecture reference, and official current API docs via Forge MCP.
2. Write a bounded implementation plan listing files, target manifest modules, API scopes, security constraints, tests and evidence. Identify unsupported assumptions before coding.
3. Implement one vertical slice at a time. Keep pure domain logic independent from Forge infrastructure. Use fixtures from verified API shapes.
4. Write unit and negative tests with explicit assertions. Run typechecking, linting, tests and `forge lint` when project exists. Explain skips.
5. Test real dev environment only with operator approval; document commands, responses, screenshots or sanitized logs. Do not silently use production credentials.
6. Run `/security-gate` on changed boundaries and `/forge-evidence` for new Forge capabilities. Update `docs/STATUS.md` and `docs/DECISIONS.md`.
7. Stop and report gate outcome, risks, next minimal task; **do not** automatically advance to next phase.

## Gate / Definition of done
Rovo accurately answers why a promise is blocked with citations; AI cannot bypass verifier; optional APIs verified if included.

## Blockers and rollback
If required entitlement or API is missing: preserve functional core, document the constraint, choose a documented supported alternative, and request a human architecture decision. If tests fail: do not deploy; rollback only changes authored in this phase, not unrelated work. Persist results before session compaction.
