# Product requirements document

## Users, job and differentiator
B2B support lead promises a customer a fix, engineering resolves a Jira task, and customer success needs **proof** of the originally promised outcome. The product converts explicit commitments into reviewed, versioned contracts and holds fulfillment independently of development task status. Target persona: support agent / customer success owner; contributor: engineering; approver: authorized promise owner. Initial customer scenario: duplicate invoices for one customer billing workflow.

## Mandatory journeys
J1 Source JSM ticket -> explicit human-confirmed promise. J2 Link Jira issue -> mark Done -> promise stays non-fulfilled. J3 Evidence of customer-specific deployment + regression test -> pending customer acknowledgement. J4 authorized acknowledgement -> Fulfilled. J5 wrong/stale/untrusted evidence rejected with clear reason. J6 reopen or invalidate evidence -> review-required state with recorded history; never silently rewrite prior events. J7 Rovo asks why not fulfilled and cites references.

## Non-goals
Sales CRM, general product feedback, universal contract mining, automated contractual commitments, predictive SLA guarantees, global Teamwork Graph ingestion, chatbot-only UI, bulk writes, sending customer messages, third-party model hosting by default.

## Roles
Tenant admin: configuration and access policy. Support owner: create/confirm customer commitment and acknowledge when authorized. Engineering contributor: attach delivery evidence only. Auditor: view authorized history. Default deny unassigned rights; never trust client-declared roles.

## Success / acceptance
Every demo result comes from real Forge state and Jira/JSM records. `Done` alone never fulfills. Required proof absent => PENDING. Repeated event does not duplicate transition. Permission-denied users cannot view or edit a customer's commitment. Demo clean install works with documented scopes and seed script/manual fixture.

## Evaluation
Synthetic labeled scenarios with missing deployment, stale test, incorrect customer, unrelated issue, duplicate events, contradictory evidence, permitted completion. Report confusion matrix and misfulfillment count plus latency and cost; no fabricated metrics.
