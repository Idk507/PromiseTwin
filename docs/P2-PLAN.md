# P2 plan (draft for operator approval, 2026-11-02): linked work, events, reconciliation

Gate (plans/P2-INTEGRATIONS.md): "JSM request links Jira task and responds to task state changes without marking fulfilled; duplicate/missing events recovered."
Status: NOT STARTED. Nothing below is implemented or verified. Facts marked (docs) come from current Forge docs read this session; (SDK) from the installed `@forge/kvs` 2.1.1 types; everything else is an assumption to verify.

## Design
**What "link" means in P2.** A contract on a JSM request links to one or more Jira work items (tasks) as an **app-owned link** stored in Forge storage. No Jira issue-link write in P2: that needs `write:jira-work` (a broader scope and a Jira-side mutation). Alternative left for later with explicit approval.

**Domain (pure, no Forge imports).**
- Add `linkedWork[]` to the contract: `{issueId, issueKey, statusCategory, statusName, observedUpdated, linkedAt, linkedBy}`. Minimal data only: no summary, no description.
- New commands `LINK_WORK` / `UNLINK_WORK` (user roles AGENT) and one system-only command `OBSERVE_LINKED_WORK` (actor role `SYSTEM`, only this command allowed).
- `OBSERVE_LINKED_WORK` updates the stored snapshot when `observedUpdated` is newer (out-of-order and duplicate observations are no-ops), emits an audit event, may set the orthogonal `atRisk` flag when linked work regresses (done -> not done), and **never changes the lifecycle and never counts as evidence**. Task Done never implies fulfilled (core invariant).
- Evidence rules from P1 are unchanged: fulfilment still needs reviewed evidence + independent acknowledgement.

**Events (Forge, runs without a user).**
- `trigger` module on `avi:jira:updated:issue` (docs: payload has issue id/key and fields including `status` and `updated`; needs `read:jira-work`, already held; delivery can take up to 3 minutes).
- Handler is an untrusted-input boundary: treat the payload as a hint, re-read the issue with `asApp()` for authoritative `status`/`updated`, derive the tenant from Forge context (not payload), look up contracts through a link index, apply `OBSERVE_LINKED_WORK` through the same revision-checked repository.
- Idempotent inbox: dedupe key `inbox#tenant#issueId#updated` written with `keyPolicy: 'FAIL_IF_EXISTS'` and a TTL (SDK); a duplicate delivery fails the create-only write and is dropped. How a refusal surfaces (error code) is unverified.
- Link index: plain-KVS keys `link#tenant#issueId#contractId` found by key prefix. **No new entity declarations** (entity/attribute declarations are permanent once deployed; plain KVS needs none). Prefix queries are eventually consistent, so a brand-new link may be missed by an event; reconciliation covers that.

**Reconciliation (missing events).**
- `scheduledTrigger` interval `hour` (docs: limits 5 triggers, intervals fiveMinute/hour/day/week; errors are not retried; any change resets triggers).
- Bounded sweep: only contracts that are not FULFILLED/DRAFT, at most N contracts and M linked issues per run (batch via one JQL `key in (...)`), cursor kept in plain KVS; skips unreadable issues (fail closed, no deletion).
- Same `OBSERVE_LINKED_WORK` path, so recovered state is identical to event-driven state.
- Also a user-triggered **"Refresh linked work"** resolver using the same function, so recovery can be tested live without waiting for the schedule.

**UI (UI Kit panel).** "Link work item" field (issue key, validated), list of linked items with status and "observed at" time, at-risk badge, Refresh button. The panel keeps showing engineering status and promise status as separate things.

## Files (planned)
`src/domain/linked-work.ts` (+ extend `contract.ts`, `lifecycle.ts`), `src/service/linked-work-service.ts`, `src/service/ports.ts` (+inbox/index ports), `src/adapters/kvs-inbox-and-index.ts`, `src/events/jira-issue-updated.ts`, `src/events/reconcile.ts`, resolver additions, `src/frontend/index.jsx` additions, `manifest.yml` (`trigger`, `scheduledTrigger`, two function keys), tests under `tests/`.

## Scopes and manifest
- New scopes: **none expected** (`read:jira-work` and `storage:app` already granted). `forge lint` will confirm; any scope change needs explicit approval and a major-version deploy.
- New modules: `trigger` (events: `avi:jira:updated:issue`), `scheduledTrigger` (hour), 2 `function` entries.

## Security constraints
Tenant from verified Forge context; `asApp` only inside event/reconcile code and only for reading the issue named by a stored link; no `asApp` data is ever returned to a user without the user-level permission check (UI reads go through the existing `asUser` path); event payload never trusted for state; Zod parse at every boundary; no secrets/payloads in logs (codes and counts only); bounded work per invocation; no customer messages.

## Tests (planned, written with the code)
Pure: observe is monotonic (older/duplicate updates ignored), never changes lifecycle, never creates evidence, Done task != fulfilled, regression sets `atRisk`, SYSTEM role cannot run any other command, user roles cannot run OBSERVE. Service: duplicate delivery processed once, missing event recovered by reconcile, out-of-order, unlinked issue ignored, cross-tenant event ignored, burst bounded, unreadable issue fails closed, CAS conflict retried once then deferred to next sweep. Mutation checks on each guard as in P1.

## Live evidence plan (needs operator approval before any deploy)
Deploy to development only; link ITS-6263 to a contract; change ITS-6263 (label edit by an operator or an in-UI status change) and watch for the event within ~3 minutes; confirm the panel shows the new snapshot, lifecycle unchanged; confirm logs; test Refresh; confirm FULFILLED is not reachable from linked-work Done alone.

## Risks and open questions
1. **Cost/volume:** `avi:jira:updated:issue` fires for every issue update on the whole site; each fires an invocation even for unlinked issues (Forge consumption costs; free allowance unknown here). Mitigation: cheapest-possible early exit (single prefix lookup); consider trigger `filter` expressions. Unverified whether filters can scope to linked issues.
2. Event delivery is at-least-once and up to 3 minutes late (docs); no event id in payload (assumed from the docs excerpt read): dedupe key derives from `issueId + updated`.
3. `FAIL_IF_EXISTS` refusal behaviour and `trigger` context fields (`cloudId`) must be verified against docs/SDK at implementation time.
4. Eventually consistent prefix queries can miss new links (covered by reconcile, not by events).
5. Scheduled-trigger changes reset all triggers; first run ~5 min after deploy; no retries on error.
6. Carry-overs: interim role model (ADR-010) and unresolved dependency advisory re-acceptance.
7. Timeline: 49 days to the Codegeist deadline (22 Dec 2026, 12:00 PT) with P3-P7 remaining; P2 is sized to one vertical slice at a time and can be cut to "link + event + refresh" if time-boxed.
