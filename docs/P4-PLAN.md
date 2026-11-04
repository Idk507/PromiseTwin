# P4 plan (draft for operator approval, 2026-11-03): product UX and judges' path

Gate (plans/P4-PRODUCT-UI.md): "User unfamiliar with code can execute sample scenario; proper mobile width and keyboard accessibility; no dead controls."
Status: NOT STARTED. Nothing below is implemented. Facts marked (docs) come from the Forge docs read this session; (live) from the demo site; (code) from the current repo.

## Where the UI stands (code) and what P4 must change
- One module only: `jira:issuePanel`, one `index.jsx`. Every promise is shown as a stack of cards inside the issue panel of the issue it is attached to. There is no cross-issue view, so the portfolio screen in docs/06-UI-UX.md does not exist yet.
- Raw codes still reach the user: audit lines (`CONFIRM · DRAFT to CONFIRMED`), blockers (`CRITERION_stale:c1, ACK_MISSING`), refusals (`UNAUTHORIZED_ACTOR: SELF_REVIEW`, `PRECONDITION_FAILED: ...`), lifecycle names, timestamps without relative time.
- All promises of one issue render expanded at once, with every control; long and hard to scan (seen live: ITS-6264 with 4 promises).
- No loading skeleton, no empty state beyond the create form, no onboarding, no "what do I do next" guidance; controls that the viewer's roles do not allow are hidden or refused only after clicking (live: B saw Verify and Reopen, refusal came after the click).
- Several status colours carry the meaning alone (Lozenge appearance). Needs a text/icon marker.
- Verified live so far: the panel works in the pane at ~730 px wide. Keyboard order, focus handling and a real phone width are untested.

## Design
### 1. Portfolio (new module `jira:projectPage`, UI Kit)
(docs) `jira:projectPage` supports UI Kit with `render: native`, `resource`, `resolver`, `title`; works for Jira and JSM (appears in the JSM project left navigation); subpages `pages`/`sections` are Custom UI only, so P4 uses ONE page with in-page tabs/filters (UI Kit `Tabs`), not routes.
Content: list of this project's promises with customer, promise text, state, owner, "next step" and gap summary ("needs customer label", "waiting for acknowledgement", "review required"), source request key as a link, last change time. Filters: state, "needs my action", "review required / at risk". Sort: needs-action first. No fake counters: counts shown are computed from the rows actually listed, and say "showing N of M" when capped.
Data: new resolver `listProjectContracts` using the existing `ContractRepository.listPage` (code: tenant prefix + cursor). Server-side rules (security-critical):
- Per-contract access is re-checked as the viewer: the viewer must be able to browse the contract's source issue (existing `getIssueMeta` as user), results redacted with the same per-viewer rules as the panel. Rows the viewer cannot read are omitted and only counted as "N hidden" (as for linked work).
- Hard caps (page size 25, max 100 contracts and a bounded number of Jira reads per request; cursor continues). Cost and quota stated in the evidence, not assumed.
- Project scoping: only contracts of the project the page is opened in (project key from the module context, validated against the stored source project); never list across projects.
Open question for you: whether the portfolio shows the viewer's own role as a banner. Recommended yes (reuses `getRoles`).

### 2. Promise detail (issue panel, redesigned)
- Collapsed by default: one row per promise (state lozenge + text label, customer, next step). Expand to see the detail. A single promise expands automatically.
- Side-by-side "engineering says / promise says": linked work status next to proof status (docs/06-UI-UX.md "engineering Done / promise Unverified"). This is the product's central idea and must be visible in one glance.
- Five-stage timeline instead of the raw audit list (Confirmed, In progress, Delivered, Verified, Acknowledged/Fulfilled), with the audit trail behind a "History" disclosure, each line in plain language and relative + absolute time.
- Human text for every code: a single `messages` module maps blocker/refusal/audit codes to sentences (extends PREDICATE_TEXT/STATUS_TEXT). Unknown codes show a generic sentence and the code in a disclosure, never a blank.
- Evidence list: issue key as a link to the source issue, observed revision time, review state, who reviewed (account display via `User`), freshness reason.
- Controls: show only actions the viewer's roles allow (`availableCommands` already computed server-side); disabled ones that matter show why in a tooltip-style helper line. Authorization stays server-side; this is guidance only.

### 3. Reviewer flow
A "Needs my action" list (portfolio filter) driven by roles: REVIEWER sees promises with PENDING evidence; ACKNOWLEDGER sees VERIFIED promises; owners see DRAFT/CONFIRMED. Each row opens the detail with the action focused. Review/acknowledge buttons get an inline confirmation sentence ("You are marking ITS-6262 as valid proof for SYNTHETIC-DELTA") because they are irreversible audit events.

### 4. Onboarding and operational states
- First-run guide on the portfolio when there are no promises: three steps with the exact fields, a button that opens the create form.
- Role-aware hint: "You have no PromiseTwin role in ITS. Ask a project admin to assign one" (default deny is live; today a new user just sees refusals).
- Error states: access denied, project without roles, storage/Jira temporarily unavailable (retry button), conflict (reload prompt, existing `CONFLICT`), stale view. Messages never expose internals; the resolver still logs codes only.
- Loading: skeletons (UI Kit `Skeleton` if present in the version; to be checked with the component reference before use, otherwise `Spinner`).
- Create form: customer label preview ("evidence must carry label customer-synthetic-delta") live as the user types, so the minimum-proof rule (ADR-024) is explained before it refuses.

### 5. Accessibility and layout (verifiable items only)
Labelled form fields (`label`, not only placeholder: today placeholders only), meaningful heading order, every status with text + icon not colour alone, visible focus, logical tab order, no keyboard traps, `aria`-style descriptions via component props where UI Kit supports them. Narrow width (375 px emulated, then the real pane), 1280x720 for the video. Measured with browser pane emulation and keyboard-only runs; automated a11y tooling only if it can run in this environment (Playwright is permitted only if the environment allows; unverified). Claims will be limited to what was actually run.

## Slices (each ends green before the next; cut line after slice 3)
1. `messages` module + tests (every code in the domain maps to text; a test enumerates all refusal/blocker/audit codes so a new code cannot ship unmapped). Pure, no Forge.
2. Detail redesign in the issue panel: collapsed rows, side-by-side, timeline, labelled form, role-aware controls, relative times.
3. Portfolio: `listProjectContracts` resolver + service method with per-viewer filtering and caps (tests: cross-tenant, cross-project, unreadable source, cap/cursor, role redaction, mocks mirror Forge limits), `jira:projectPage` module, filters, needs-my-action.
4. Onboarding, empty/error/loading states.
5. Accessibility and keyboard/mobile pass with recorded measurements.
6. Judges' path rehearsal (below), no deploy to production.

## Manifest, scopes, storage
- Manifest: add ONE module `jira:projectPage` (+ its resolver reuse); existing functions reused. No new scopes expected (same `read:jira-work`, `storage:app`); `forge lint` will confirm. No new entity declarations (they are permanent once deployed); portfolio paging uses the existing `by-key` prefix queries. Adding a module needs `forge deploy` + site upgrade; I will request approval before each.
- Display condition for the page (e.g. admin only) NOT used: viewers need it. Roles/permissions are still enforced in the resolver.

## Security constraints
Portfolio is the first cross-issue read, so it is the main new boundary: tenant from installation context only, project key re-validated server-side, per-contract source access checked as the viewer, hidden rows never leak counts beyond "N hidden", caps on rows and Jira reads (a flood cannot cause unbounded reads), no logging of promise text, no AI. The UI hides disallowed actions but the server already refuses them (unchanged). `/security-gate` and `/forge-evidence` will be run on the new boundary and module.

## Judges' path (what P7 depends on; planned here, executed with approval)
(docs) Sharing requires deploying to **production** first (`forge deploy -e production`), then the developer console Distribution page: "Sharing" (anyone with the link) or "Sharing within organization" (installers must belong to an organization of the app owner). Installing users must be admins of their site; apps that are **Not sharing** can be installed only by contributors. Judges are outside the owner's organization, so "Sharing" is the likely option. Unverified: whether a personal (non-organization) app can use Sharing; to be checked in the console before relying on it.
P4 deliverables toward it (no production action without your approval): a one-page judge guide (what to install, which roles are needed, how to create the first promise in under 2 minutes, a synthetic scenario they can run alone because default deny means a fresh install has no reviewer/acknowledger roles), a seed-free "single admin" path (admin can hold AGENT + REVIEWER + ACKNOWLEDGER but separation of duties still forbids self-review and self-acknowledge, so the guide must explain that a second user is needed, or offer a documented demo-mode alternative; this is an OPEN product decision below).

## Evidence plan (live steps need your approval and manual sign-ins as before)
- Local: tests for messages, portfolio service and resolver security; typecheck, ESLint, `forge lint`; mutation checks on the portfolio filter (cross-project/unreadable/cap); no fabricated metrics.
- Live on development: portfolio with the existing synthetic promises as A, B, C: each sees only what they may; "needs my action" differs per role; unreadable-source row hidden; error states by forcing a conflict; 375 px width and keyboard-only walk-through with screenshots/text captured; a person unfamiliar with the code (you) runs the sample scenario from the guide, and any friction is recorded as findings, not smoothed over.
- Not claimed: usability results beyond what was observed; screen-reader behaviour (not tested here).

## Decisions needed from you
1. Approve the plan and slices (cut line after slice 3 if time-boxed).
2. Judges and separation of duties: should a fresh install let a single admin complete the whole flow? Options: (a) keep strict separation and document that judges need a second account (honest, but friction for judges); (b) add an explicit, clearly labelled **demo mode** that relaxes self-review/self-acknowledge only inside a project flag set by an admin, recorded in every audit event and visible as a banner (easier for judges, weakens the invariant "approval authorization is independently checked" only when the admin opts in). Recommended: (a) as default plus (b) only if you approve it as a documented ADR; the invariant in CLAUDE.md argues against silently relaxing it.
3. Portfolio placement: project page (recommended, works in JSM) vs global page. Recommended: project page.
4. Whether to use the remaining time on P4 polish or move straight to P5 (Rovo) after slice 3. Rovo/MCP entitlement on the free dev site is still unverified.

## Risks
- Schedule: 49 days left at P3 start; roughly 7 weeks remain after this draft with P5-P7 still to do.
- UI Kit component availability (Tabs, Skeleton, DynamicTable behaviour inside a narrow panel) must be confirmed with the component reference before use; unsupported assumptions will be listed as I find them.
- The pane renders slowly and cannot prove real-device behaviour; mobile claims will say "emulated 375 px".
- Portfolio cost: one user-scoped Jira read per listed contract could be heavy on large projects; caps and memoization are in the design, measured on the demo site only.
- Residual P3 items stay open: dependency advisories, owner self-acknowledge not run live, FSRT not run on P2/P3 code, predicates are editor-settable facts.
