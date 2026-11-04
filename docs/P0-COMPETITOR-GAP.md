# P0 competitor-gap one-pager (2026-11-01)

Method: 5 web searches + direct reads of two Marketplace listings and the official Codegeist 2026 rules page. **Absence of a match is not proof no such product exists**; Marketplace and Atlassian release notes were sampled, not exhaustively crawled.

## Codegeist 2026 facts (from the official rules page, read in the built-in browser)
- Submission period ends **Tue 22 Dec 2026, 12:00 pm PT** (51 days from today). Judging 5 Jan – 3 Feb 2027; winners ~15 Feb 2027.
- Open to individuals (age of majority), teams, organizations; excluded countries/regions incl. Brazil, Quebec, Russia, Belarus, Crimea, Cuba, Iran, North Korea, Syria, Sudan, Myanmar. **Eligibility for the operator's country is not checked here; the operator must confirm.**
- Must be built on Forge and integrate with at least one of Jira, Confluence, JSM, Bitbucket, Teamwork Graph, Rovo. Categories: Software Teams / Business Teams / Specialized Industries. Bonus ($1,500 each): Best Agents (`rovo:agent` etc.), Best MCP app (`rovo:mcp`), Best Teamwork Graph integration, Best Marketplace published app (listing or review ticket).
- Judging: Stage 1 pass/fail viability; Stage 2 five **equally weighted** criteria: Technological Implementation, Design, Potential Impact, Innovation/Idea, Presentation.
- Required: public YouTube demo video < 5 min (judges need not watch past 3), **installation link** for judges (via Forge "start sharing your app"), configuration instructions, text description, category selection. English materials.
- Implication: the installation link means distribution/sharing must be set up before submission. Per CLAUDE.md that needs explicit operator approval, and whether a *personal* app can be shared this way is **unverified** (ADR-007).

## Closest products found
| Product | What it does (per its listing) | Overlap with PromiseTwin |
|---|---|---|
| JSM native SLAs | Time-based goals per request (first response, resolution); agent-visible; customer visibility limited | Time targets only; no customer-specific promises, no evidence |
| CustomerChase (TechnofyStore, Forge, paid, v2.0.0 released 1 Sep 2026, no reviews) | Auto-reminds customers on waiting requests, stops on reply, auto-closes inactive tickets; audit of cycles | Adjacent. Follow-up automation and auto-**close**; does not track promises or verify fulfillment; no AI/Rovo mentioned |
| SLA Customer – SLAs in the Customer Portal (Digital I, Forge, free, 6 installs) | Shows SLA targets/status in portal request | Display only |
| SLA Time and Report for Jira (Rovo agent) | Rovo agent answering SLA status questions; vendor warns AI answers need verification | SLA reporting, not promise fulfillment |
| Atlassian roadmap (CSM/JSM/Rovo items) | Rovo service-desk agent templates (incl. reopened-ticket check) planned Q1 2027 per roadmap snippet | Possible future overlap; roadmap dates are unreliable |

## Wider sweep (2 further searches, 2026-11-02)
Adjacent Forge/Marketplace apps surfaced: Business Sign-off & Approval for Jira (Forge; approval history, audit log), Noted (Forge; acknowledgements/sign-offs, timestamped audit trail), SignOff provable approval workflow for Jira, eSign for Jira (customer signatures in JSM portal; Forge version Early Access per its changelog), Actions for JSM (require details at portal transitions), Feature Bundle Self-Service Extension (customer-visible progress). These are **approval/acknowledgement/progress** tools: they record that someone signed or a status changed. None found models a customer-specific promise with evidence-gated FULFILLED, but "provable approval" and sign-off apps are the nearest prior art for the audit-trail angle; the demo must show evidence verification (not just a signature) as the differentiator. Listings not read in depth; claims above are from search snippets.

## Gap (hypothesis, not proven)
No found product models a **customer-specific promise** ("we will deliver X to customer Y by Z") and decides FULFILLED only from **verified evidence**, separate from issue status (done ≠ fulfilled). CustomerChase's auto-close behavior is the opposite philosophy (closes on inactivity), which helps differentiation. P0 evidence that the separation is feasible on real data: panel showed a Closed JSM request as `Engineering done` / `Promise fulfillment: UNKNOWN` (docs/P0-EVIDENCE.md).

## Risks to the claim
- Search coverage is thin; Marketplace likely has more SLA/commitment apps than the few surfaced. Do a further Marketplace keyword sweep (e.g. "commitment", "promise", "customer success", "deliverable", "acceptance") before claiming novelty in the video.
- Atlassian may ship a similar Rovo template; "reopened ticket checking" is adjacent.
- Rovo chat/agents reportedly unavailable on free developer sites (single community-forum report; **unverified** here) — Rovo bonus prizes may not be demonstrable; keep Rovo as enhancement (ADR-005).
- P0 only proves read access; the promise/evidence model is entirely unbuilt (P1+).

## Recommendation for the go/no-go (operator signs; this is not a signature)
GO to P1, conditional on: (1) operator confirms Codegeist eligibility; (2) a further Marketplace sweep before any novelty claim; (3) installation link: docs check DONE (see below); (4) FSRT/forbidden-user security evidence gaps tracked to P6. Timeline risk: 51 days to submission with a 5-minute end-to-end demo requirement.

## Installation-link feasibility (docs check, 2026-11-02; nothing executed)
Per the Forge distribution docs: deploy to the **production** environment via CLI, then in the developer console open Distribution > Edit > choose **Sharing** (anyone with the link; needed for judges outside the owner's organization) > fill app details > copy the link. Not-sharing apps are installable only by contributors. Apps with a manifest license or submitted for Marketplace listing cannot use installation links. The docs do not mention a personal-app restriction, but this was not tested. Needs operator approval: production deploy, enabling sharing, and publishing the link. Judges install as a site admin, so the app must work on a fresh site (first-run/empty-state instructions required).
