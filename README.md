# PromiseTwin

**Evidence-gated, customer-specific promise fulfilment for Jira Service Management.** An Atlassian Forge app built for Codegeist 2026.

A customer promise is **not** fulfilled when a Jira ticket is closed. In PromiseTwin it is fulfilled only when (1) the evidence issue carries that customer's own label, is linked to the customer's request, and is Done with a resolution, (2) a different person has reviewed that evidence as valid, and (3) someone other than the promise owner has recorded the customer's acknowledgement. If the evidence changes later, the promise shows **Review required**; the fulfilment stays on record and nothing changes silently.

## Scope

**In scope (built)**
- A promise record per customer on a Jira or Jira Service Management request, with the lifecycle Draft, Confirmed, In progress, Delivered, Verified, Acknowledged, Fulfilled and a plain-language audit history.
- A deterministic evidence verifier: customer label, link to the request, status Done, resolution present. Unknown facts count as failures (fail closed).
- Separation of duties: the person who added evidence cannot review it; the owner cannot acknowledge their own promise.
- Default-deny app roles per project (support owner, contributor, reviewer, acknowledger). Jira project administrators assign them.
- Per-viewer redaction: a viewer who cannot open a linked issue sees only a count, never its key or title.
- Idempotent event handling (an issue-updated trigger) and an hourly sweep that recovers missed events.
- A project **Promises** page with filters (needs my action, review required, at risk).
- An optional **read-only Rovo agent** with three read-only actions that explains why a promise is or is not fulfilled. It cannot change anything.

**Out of scope (not built, on purpose)**
- Sending any message to a customer.
- Any AI decision. Decisions come only from the deterministic checks; the agent only narrates the same facts.
- Writing to Jira. The app requests no write scopes.
- External services. The app calls only Atlassian platform APIs.
- Other Atlassian products and Jira project types beyond Jira Service Management (not tested).
- Marketplace listing and licensing, MCP exposure and Teamwork Graph connectors.

## How it is built
- **Forge** (Node 24, UI Kit / React): `jira:issuePanel`, `jira:projectPage`, `rovo:agent` with three `action` modules, an `avi:jira:updated:issue` trigger and an hourly `scheduledTrigger`. Storage is Forge-hosted key-value storage.
- **Permissions (scopes):** `read:jira-work`, `read:servicedesk-request`, `storage:app`. User actions read Jira **as the signed-in user**; the trigger and sweep read as the app for issues a user linked.
- **Rovo identity:** who is asking comes from the platform context, never from anything the model supplies.
- **TypeScript** in strict mode, Zod for request parsing, Vitest for tests.

```
app/        Forge app (manifest.yml, src/, tests/)
  src/domain      lifecycle and verifier rules
  src/service     orchestration, authorization, redaction
  src/adapters    Jira and storage adapters
  src/events      trigger and sweep
  src/rovo        agent actions and explanation
  src/frontend    UI Kit panel and Promises page
contracts/  data and status rules
docs/       architecture, security, decisions, evidence per phase
plans/      phase plans with gates
security-audit-artifacts/   security gate notes
scripts/    developer helpers
.claude/    bounded agent instructions, skills and hooks used while building
```

## Build and test
Requires Node 22 or newer and the Forge CLI.

```bash
cd app
npm ci
npm run check     # strict tsc + frontend lint + unit tests
forge lint
```

The manifest carries the author's Forge `app.id`. To run your own copy you would register your own app (`forge register`), which changes that id, then `forge deploy` and `forge install`; this path has not been tested by anyone other than the author. Installing the author's published build is done from a Forge sharing link given in the Codegeist submission, not from this repository.

## Verification status (what has and has not been checked)
- **Automated:** 489 tests passed at tag `rc1`, including generated tests that fed random commands to the real service code with in-memory stores and a simulated Jira (0 invariant violations) and hostile inputs (0 crashes or leaks). These are measured in tests, not in production.
- **Live:** the flow (draft to fulfilled, the refused "valid but not Done" verification, "evidence changed", "Review required") was run on a development and a staging install on a demo site, and again on the production install on a separate new site, by the author with two of their own accounts. Some Jira-side setup there used REST calls.
- **Not verified:** use by anyone who did not build the app; Jira project types other than Jira Service Management; phones, screen readers and non-Chromium browsers; the Rovo agent on the production install (it was verified on development and staging only).
- **Security review:** manual, by the author, plus one run of the Forge static analyzer. No independent reviewer. Dependency advisories inherited from the Forge SDK packages exist (see `docs/DECISIONS.md`, ADR-027).

## Known limits
- The checks read facts that Jira editors can change (labels, links, status). They are observable and recorded, not cryptographic proof. The control is the checks plus an independent reviewer plus an independent acknowledger.
- The app stores Atlassian account IDs. It does **not** yet use Atlassian's personal data reporting API or erase closed accounts automatically, and it has no delete-a-person function (`docs/DECISIONS.md`, ADR-031).
- Role assignments and audit entries are logged but are not tamper-proof storage.

## Documentation
- Current state and open items: [`docs/STATUS.md`](docs/STATUS.md)
- Design decisions: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- Product, architecture, security: [`docs/01-PRODUCT-PRD.md`](docs/01-PRODUCT-PRD.md), [`docs/02-ARCHITECTURE.md`](docs/02-ARCHITECTURE.md), [`docs/04-SECURITY.md`](docs/04-SECURITY.md)
- Evidence for each phase: `docs/P0-EVIDENCE.md` to `docs/P7-EVIDENCE.md`
- Source links: [`docs/REFERENCES.md`](docs/REFERENCES.md)

## Licence
No licence file is included in this repository.

## Competition
Built for [Atlassian Codegeist 2026](https://codegeist2026.devpost.com/), category Apps for Business Teams.
