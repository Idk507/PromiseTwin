# Judging-criteria map (reviewer-only; do NOT paste into Devpost)

Moved out of `submission/DEVPOST.md` after the critic review of 2026-11-06. It lists what we can point to per criterion, and what is weak or unverified.

| Criterion | What we can point to | Evidence | Weak or unverified |
|---|---|---|---|
| Technological implementation | Forge issue panel, project page, resolvers, trigger, scheduled sweep, Rovo agent and three read-only actions, storage; per-user Jira reads; 489 tests; generated tests (in-memory stores, simulated Jira) | docs/P6-EVIDENCE.md, security-audit-artifacts/ | The judge cannot reach the app until production + Sharing exist; security review is the builder's own |
| Design | Plain-language states and refusals, timeline, "Next:" line, filters, labelled inputs; wording and picker fixes found in a rehearsal | docs/P4-EVIDENCE.md (P4 NOT signed off), docs/P6-EVIDENCE.md, docs/P7-EVIDENCE.md | No stranger has followed the install guide; F1, O1, O2 open |
| Potential impact | A specific, checkable problem for support and success owners (PRD persona and scenario) | docs/01-PRODUCT-PRD.md | No customer or usage data exists; impact is argued |
| Innovation | Evidence-gated customer promises separate from issue status, plus a read-only agent that narrates verified facts | docs/P0-COMPETITOR-GAP.md | Competitor search was thin and sampled; "absence of a match is not proof" |
| Presentation | `submission/DEMO-SCRIPT.md` (3-minute core), install guide | submission/ | Video not recorded; install path not tested by a non-author |

Critic scores on the first drafts (1-5): Technology 4, Design 3, Impact 3, Innovation 3, Presentation 2. The first revision (this commit) fixes the overclaims it listed; the scores will be redone after slices 2-4.
