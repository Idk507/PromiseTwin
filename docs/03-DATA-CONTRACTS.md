# Canonical domain contracts and state machine

Persist versioned records with namespaced tenant-scoped identifiers; treat fields as proposal schema pending implementation choices. Source IDs must use immutable issue ID where available, with issue key for display. `sourceRevision` or fingerprint must be computed only from relevant, normalized source state; do not invent an API revision property.

## Contract fields
`id`, `tenantId`, `customerReference` (access-restricted), `source{product,site,issueId,issueKey}`, `ownerAccountId`, `promiseText`, `acceptedAt`, `dueAt?`, `criteria[]`, `linkedWork[]`, `evidence[]`, `acknowledgement?`, `lifecycle`, `risk`, `version`, `createdAt`, `updatedAt`. Requirements must include a verifiable criterion ID, type, expected predicates, source type, and authorization policy. Evidence must retain provenance, subject binding, observedAt, expiresAt?, source revision and review status.

## Lifecycle
DRAFT -> CONFIRMED -> IN_PROGRESS -> DELIVERED -> VERIFIED -> ACKNOWLEDGED -> FULFILLED. `AT_RISK` is an orthogonal flag. Reject illegal skips. `FULFILLED` is recorded as historical event; post-fulfillment invalidation results in new corrective/reopen event rather than deletion. Every mutation has actor, authorization decision and event ID.

## Verification invariant
```
canFulfill = contract.confirmed
  && all(requiredCriterion evidence is VALID, CURRENT, same customer, authorized source)
  && acknowledgement.authorized
  && acknowledgement.appliesToCurrentContractVersion
```

Do not derive `deployed=true` from status Done. Do not use LLM scores as fulfillment ground truth. Return machine-readable `missing`, `stale`, `conflicting`, `unauthorized`, `satisfied` per criterion. Require separate approval for changes to accepted criteria; update version and invalidate old proof where relevant.

## Version conflict
Optimistic concurrency check on mutations. If storage lacks adequate compare-and-swap, use bounded serialization for selected key and explicitly document residual race risks. An audit event must never imply atomicity across Jira + Forge.
