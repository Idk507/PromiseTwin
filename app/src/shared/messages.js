// Plain-language text for every code the server can return. Pure: no imports, no Forge, no I/O,
// so the UI bundle and the unit tests can both use it. This module only EXPLAINS decisions; it
// never decides anything. Output never includes user-supplied free text.

/** Refusal / error codes returned by the domain, service and resolvers. */
export const REFUSAL_TEXT = {
  TENANT_MISMATCH: 'This promise belongs to a different site.',
  VERSION_CONFLICT: 'Someone else changed this promise a moment ago. The view was reloaded; please try again.',
  UNAUTHORIZED_ACTOR: 'You do not have the role needed for this action.',
  ILLEGAL_TRANSITION: 'This step is not available in the promise\'s current state.',
  PRECONDITION_FAILED: 'A required condition is not met yet.',
  INVALID_INPUT: 'Some of the input is not valid.',
  ISSUE_NOT_ACCESSIBLE: 'You cannot open this request, so PromiseTwin cannot show its promises.',
  SOURCE_NOT_ACCESSIBLE: 'You cannot open the referenced issue, so it cannot be used.',
  NOT_FOUND: 'That promise was not found.',
  FORBIDDEN: 'Only a project administrator can do this.',
};

/** Extra detail tokens attached to a refusal. */
export const DETAIL_TEXT = {
  SELF_REVIEW: 'You added this evidence, so someone else must review it.',
  SELF_ACKNOWLEDGE: 'The promise owner cannot acknowledge their own promise.',
  NO_REQUIRED_CRITERIA: 'The promise needs at least one required criterion.',
  EVIDENCE_LIMIT: 'This promise already has the maximum number of evidence items.',
  SELF_LINK: 'A request cannot be linked to itself.',
  ALREADY_LINKED: 'That work item is already linked.',
  LINK_LIMIT: 'This promise already has the maximum number of linked work items.',
  NOT_LINKED: 'That work item is not linked to this promise.',
  CONTRACT_LIMIT: 'This request already has the maximum number of promises.',
  ROLE_ASSIGNMENT_LIMIT: 'This project already has the maximum number of role assignments.',
  POST_STATE_INVALID: 'The change would leave the promise in an invalid state, so it was not applied.',
  // Field paths named by input validation.
  customerReference: 'Check the customer reference.',
  promiseText: 'Check the promise text.',
  criteria: 'Check the acceptance criteria.',
  reason: 'A reason is required.',
  'criteria/reason': 'Criteria and a reason are required.',
  criterionId: 'Choose a criterion that exists on this promise.',
  evidenceId: 'That evidence item does not exist.',
  issueId: 'That linked item does not exist.',
  issueKey: 'Check the issue key.',
  observedUpdated: 'The issue\'s update time could not be read.',
  updated: 'The issue\'s update time could not be read.',
  contractId: 'Check the promise id.',
  cursor: 'The list position is no longer valid. Reload the list.',
  sourceRef: 'Enter only the issue key, for example ITS-6267: letters, a dash and digits, with no spaces, title or link.',
  id: 'That identifier is already used.',
};

export const PREDICATE_TEXT = {
  STATUS_CATEGORY_IS: 'the evidence issue is not Done',
  RESOLUTION_SET: 'the evidence issue has no resolution',
  HAS_LABEL: 'the evidence issue is missing a required label',
  CUSTOMER_LABEL: 'the evidence issue does not carry this customer\'s label',
  LINKED_TO_SOURCE: 'the evidence issue is not linked to this request',
};

export const CRITERION_STATUS_TEXT = {
  satisfied: 'satisfied',
  missing: 'no reviewed evidence yet',
  stale: 'evidence changed or expired since it was reviewed',
  conflicting: 'contradicted or invalid evidence',
  unauthorized: 'you cannot read the evidence issue',
  unmet: 'evidence does not meet the checks',
};

export const LIFECYCLE_TEXT = {
  DRAFT: 'Draft',
  CONFIRMED: 'Confirmed',
  IN_PROGRESS: 'In progress',
  DELIVERED: 'Delivered',
  VERIFIED: 'Verified',
  ACKNOWLEDGED: 'Acknowledged',
  FULFILLED: 'Fulfilled',
};

/** Audit event types, as a past-tense sentence fragment. */
export const AUDIT_TEXT = {
  CREATED: 'Promise drafted',
  CONFIRM: 'Promise confirmed',
  START: 'Work started',
  MARK_DELIVERED: 'Marked delivered',
  VERIFY: 'Evidence verified',
  ACKNOWLEDGE: 'Customer acknowledgement recorded',
  FULFILL: 'Marked fulfilled',
  REOPEN: 'Reopened',
  AMEND_CRITERIA: 'Criteria amended',
  ADD_EVIDENCE: 'Evidence added',
  REVIEW_EVIDENCE: 'Evidence reviewed',
  SET_AT_RISK: 'Risk flag changed',
  LINK_WORK: 'Work linked',
  UNLINK_WORK: 'Work unlinked',
  OBSERVE_LINKED_WORK: 'Linked work observed',
};

/**
 * The Jira label an evidence issue must carry for a customer: `customer-` plus the lowercased
 * reference with runs of other characters turned into single dashes (max 50 characters).
 * Single source of truth: the server's verifier calls this too, so the UI preview cannot drift.
 * @param {string} customerReference
 * @returns {string | undefined} undefined when nothing usable remains
 */
export function customerLabelFor(customerReference) {
  const norm = String(customerReference).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/g, '');
  return norm ? `customer-${norm}` : undefined;
}

const MINIMUM_PROOF =/^criteria\.MINIMUM_PROOF_REQUIRED\.([^:]{1,64}):([A-Z_]{1,40})$/;
const ILLEGAL = /^([A-Z_]{1,40}) from ([A-Z_]{1,40})$/;

/**
 * One sentence for a single detail token. Unknown tokens return undefined so the caller can show
 * a generic line instead of a blank (a test fails if a token used by the server is unmapped).
 * @param {string} token
 * @returns {string | undefined}
 */
export function describeDetail(token) {
  if (typeof token !== 'string') return undefined;
  if (Object.prototype.hasOwnProperty.call(DETAIL_TEXT, token)) return DETAIL_TEXT[token];
  const mp = MINIMUM_PROOF.exec(token);
  if (mp) return `Criterion ${mp[1]} needs the automatic check ${mp[2] === 'CUSTOMER_LABEL' ? 'for the customer label' : 'that the evidence is linked to this request'}.`;
  const il = ILLEGAL.exec(token);
  if (il) return `${AUDIT_TEXT[il[1]] || il[1]} is not possible while the promise is ${(LIFECYCLE_TEXT[il[2]] || il[2]).toLowerCase()}.`;
  return undefined;
}

/**
 * A user-written phrase without trailing punctuation, so it can sit inside a sentence of ours.
 * @param {unknown} text
 * @returns {string} empty when there is nothing usable
 */
export function plainName(text) {
  return typeof text === 'string' ? text.trim().replace(/[\s.!?:;,]+$/, '') : '';
}

/**
 * One sentence for a blocker token from the fulfilment decision.
 * @param {string} token e.g. ACK_MISSING, CRITERION_stale:c1, PREDICATE_FAILED:c1:CUSTOMER_LABEL
 * @param {{ requiredCustomerLabel?: string, criterionText?: Record<string,string> }} [ctx]
 * @returns {string}
 */
export function describeBlocker(token, ctx = {}) {
  const t = String(token);
  const simple = {
    NOT_CONFIRMED: 'The promise has not been confirmed yet.',
    NO_REQUIRED_CRITERIA: 'The promise has no required criteria.',
    ACK_MISSING: 'The customer acknowledgement has not been recorded yet.',
    ACK_DENIED: 'The acknowledgement was denied.',
    ACK_STALE: 'The terms changed after the acknowledgement, so it must be given again.',
  };
  if (simple[t]) return simple[t];
  const crit = /^CRITERION_(satisfied|missing|stale|conflicting|unauthorized|unmet):(.{1,64})$/.exec(t);
  if (crit) {
    const name = plainName(ctx.criterionText && ctx.criterionText[crit[2]]) || `criterion ${crit[2]}`;
    return `${name}: ${CRITERION_STATUS_TEXT[crit[1]]}.`;
  }
  const pred = /^PREDICATE_FAILED:(.{1,64}):([A-Z_]{1,40})$/.exec(t);
  if (pred) {
    const base = PREDICATE_TEXT[pred[2]] || `check ${pred[2]} failed`;
    const extra = pred[2] === 'CUSTOMER_LABEL' && ctx.requiredCustomerLabel ? ` (needs label ${ctx.requiredCustomerLabel})` : '';
    return `Not met: ${base}${extra}.`;
  }
  return 'A required condition is not met yet.';
}

/**
 * A short, readable message for a refused or failed server response.
 * @param {{ code?: string, detail?: string[] }} r
 * @param {{ requiredCustomerLabel?: string }} [ctx]
 * @returns {string[]} lines (never empty)
 */
export function describeRefusal(r, ctx = {}) {
  const code = r && typeof r.code === 'string' ? r.code : '';
  const head = REFUSAL_TEXT[code] || 'Something went wrong. Please try again.';
  const detail = r && Array.isArray(r.detail) ? r.detail.slice(0, 8) : [];
  const lines = [head];
  for (const d of detail) {
    let text = code === 'PRECONDITION_FAILED' && /^(NOT_CONFIRMED|ACK_|CRITERION_|PREDICATE_FAILED:)/.test(String(d))
      ? describeBlocker(d, ctx)
      : describeDetail(d);
    // Input validation names the offending field (a server-generated path such as `sourceRef`).
    // Never leave the user with no hint: name the field. Only plain field-path shapes qualify, so
    // arbitrary strings are still dropped, never echoed.
    if (!text && code === 'INVALID_INPUT' && typeof d === 'string' && /^[a-z][A-Za-z0-9]{0,40}(\.[A-Za-z0-9]{1,40}){0,3}$/.test(d)) {
      text = `Check the field "${d}".`;
    }
    if (text && !lines.includes(text)) lines.push(text);
  }
  // The banner already says the action did not go through; a generic first line adds nothing once
  // specific reasons exist.
  if (code === 'PRECONDITION_FAILED' && lines.length > 1) lines.shift();
  return lines;
}

/**
 * The decision summary shown on an audit line, e.g. "Decision: Fix is deployed is satisfied; all gates held.".
 * @param {{ criteria: { criterionId: string, status: string }[], canFulfill?: boolean }} report
 * @param {Record<string,string>} criterionText
 * @returns {string}
 */
export function describeDecision(report, criterionText = {}) {
  const parts = (report.criteria || []).map((x) => {
    const name = plainName(criterionText[x.criterionId]) || x.criterionId;
    const text = CRITERION_STATUS_TEXT[x.status] || x.status;
    return x.status === 'satisfied' ? `${name} is ${text}` : `${name}: ${text}`;
  });
  return `Decision: ${parts.join('; ')}${report.canFulfill ? '; all gates held' : ''}.`;
}

/**
 * One audit line without codes.
 * @param {{ type: string, fromLifecycle?: string, toLifecycle?: string }} a
 * @returns {string}
 */
export function describeAudit(a) {
  const what = AUDIT_TEXT[a.type] || 'Change recorded';
  if (a.fromLifecycle && a.toLifecycle && a.fromLifecycle !== a.toLifecycle) {
    return `${what} (${LIFECYCLE_TEXT[a.fromLifecycle] || a.fromLifecycle} to ${LIFECYCLE_TEXT[a.toLifecycle] || a.toLifecycle})`;
  }
  return what;
}

/**
 * Relative time such as "3 min ago"; falls back to the date for old or unparsable input.
 * @param {string} iso
 * @param {number} [nowMs]
 * @returns {string}
 */
export function relativeTime(iso, nowMs = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso).slice(0, 16);
  const s = Math.round((nowMs - t) / 1000);
  if (s < 0) return String(iso).slice(0, 16);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return String(iso).slice(0, 10);
}

const STAGES = ['CONFIRMED', 'IN_PROGRESS', 'DELIVERED', 'VERIFIED', 'ACKNOWLEDGED', 'FULFILLED'];

/**
 * Timeline stages for a promise. `state` is text-friendly (done / current / todo) so the UI can
 * show a word or glyph and never relies on colour alone. DRAFT has no stage reached yet.
 * @param {string} lifecycle
 * @returns {{ stage: string, label: string, state: 'done' | 'current' | 'todo' }[]}
 */
export function timeline(lifecycle) {
  const at = STAGES.indexOf(lifecycle);
  return STAGES.map((stage, i) => ({
    stage,
    label: LIFECYCLE_TEXT[stage],
    // Fulfilled is the end: once reached it is "done", not "current".
    state: at < 0 ? 'todo' : i < at || (i === at && stage === 'FULFILLED') ? 'done' : i === at ? 'current' : 'todo',
  }));
}

/**
 * What should happen next on a promise, for the viewer, in one sentence. Guidance only: the
 * server still refuses anything the viewer may not do.
 * @param {{ lifecycle: string, atRisk?: boolean }} contract
 * @param {string[]} available commands the server says the viewer may issue now
 * @param {{ required?: boolean }} [reviewRequired]
 * @returns {string}
 */
export function nextStep(contract, available, reviewRequired) {
  const has = (c) => available.includes(c);
  if (contract.lifecycle === 'FULFILLED') {
    return reviewRequired && reviewRequired.required
      ? 'Reopen the promise to re-verify it.'
      : 'Done. The fulfilment and its proof are on record.';
  }
  switch (contract.lifecycle) {
    case 'DRAFT': return has('CONFIRM') ? 'Confirm the promise when the wording is right.' : 'Waiting for the support owner to confirm.';
    case 'CONFIRMED': return has('START') ? 'Start work when engineering begins.' : 'Waiting for work to start.';
    case 'IN_PROGRESS': return has('MARK_DELIVERED') ? 'Attach evidence, then mark delivered.' : 'Waiting for delivery.';
    case 'DELIVERED': return has('REVIEW_EVIDENCE') || has('VERIFY') ? 'Review the evidence, then verify.' : 'Waiting for a reviewer to check the evidence.';
    case 'VERIFIED': return has('ACKNOWLEDGE') ? 'Record the customer\'s acknowledgement.' : 'Waiting for an acknowledger.';
    case 'ACKNOWLEDGED': return has('FULFILL') ? 'Mark the promise fulfilled.' : 'Waiting for fulfilment.';
    default: return 'No action available to you right now.';
  }
}
