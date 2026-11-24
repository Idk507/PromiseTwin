import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_TEXT, CRITERION_STATUS_TEXT, DETAIL_TEXT, LIFECYCLE_TEXT, PREDICATE_TEXT, REFUSAL_TEXT,
  customerLabelFor, describeAudit, describeBlocker, describeDecision, plainName, describeDetail, describeRefusal, nextStep, relativeTime, timeline,
} from '../src/shared/messages';
import { customerLabel } from '../src/domain/verification';
import { predicateSchema } from '../src/domain/contract';

const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const SERVER_FILES = ['domain/lifecycle.ts', 'service/contract-service.ts', 'resolvers/index.ts'].map(read).join('\n');

// Detail tokens that are generated dynamically and covered by pattern tests below.
const DYNAMIC_DETAIL = new Set(['criteria/reason']);

describe('every server code has a plain-language message (a new unmapped code fails here)', () => {
  it('refusal codes used by the domain, service and resolvers are all mapped', () => {
    const codes = new Set<string>();
    for (const m of SERVER_FILES.matchAll(/(?:refuse\(|code: )'([A-Z_]+)'/g)) codes.add(m[1]!);
    expect(codes.size).toBeGreaterThanOrEqual(10);
    for (const c of codes) expect(REFUSAL_TEXT[c], `unmapped refusal code ${c}`).toBeTruthy();
  });

  it('literal detail tokens used with refusals are all mapped', () => {
    const tokens = new Set<string>();
    for (const m of SERVER_FILES.matchAll(/(?:refuse\('[A-Z_]+',|detail:) \[([^\]]*)\]/g)) {
      for (const t of m[1]!.matchAll(/'([^'$`]+)'/g)) tokens.add(t[1]!);
    }
    expect(tokens.size).toBeGreaterThanOrEqual(15);
    for (const t of tokens) {
      if (DYNAMIC_DETAIL.has(t) && !DETAIL_TEXT[t]) continue;
      expect(describeDetail(t), `unmapped detail token ${t}`).toBeTruthy();
    }
  });

  it('every audit event type and lifecycle state is mapped', () => {
    const types = new Set<string>();
    for (const m of read('domain/lifecycle.ts').matchAll(/type: '([A-Z_]+)'/g)) types.add(m[1]!);
    for (const t of types) expect(AUDIT_TEXT[t], `unmapped audit/command type ${t}`).toBeTruthy();
    expect(AUDIT_TEXT.CREATED).toBeTruthy();
    for (const s of ['DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'DELIVERED', 'VERIFIED', 'ACKNOWLEDGED', 'FULFILLED']) {
      expect(LIFECYCLE_TEXT[s]).toBeTruthy();
    }
  });

  it('every predicate kind and criterion status has text', () => {
    const kinds = predicateSchema.options.map((o) => (o.shape.kind as unknown as { value: string }).value);
    expect(kinds.length).toBe(5);
    for (const k of kinds) expect(PREDICATE_TEXT[k], `unmapped predicate ${k}`).toBeTruthy();
    for (const s of ['satisfied', 'missing', 'stale', 'conflicting', 'unauthorized', 'unmet']) {
      expect(CRITERION_STATUS_TEXT[s]).toBeTruthy();
    }
  });
});

describe('describeBlocker / describeRefusal', () => {
  it('turns live blocker tokens into sentences without codes', () => {
    const label = 'customer-synthetic-delta';
    const out = [
      'NOT_CONFIRMED', 'ACK_MISSING', 'ACK_DENIED', 'ACK_STALE', 'NO_REQUIRED_CRITERIA',
      'CRITERION_unmet:c1', 'CRITERION_stale:c1',
      'PREDICATE_FAILED:c1:CUSTOMER_LABEL', 'PREDICATE_FAILED:c1:LINKED_TO_SOURCE',
      'PREDICATE_FAILED:c1:STATUS_CATEGORY_IS', 'PREDICATE_FAILED:c1:RESOLUTION_SET',
    ].map((t) => describeBlocker(t, { requiredCustomerLabel: label }));
    for (const s of out) {
      expect(s).not.toMatch(/PREDICATE_FAILED|CRITERION_|ACK_|NOT_CONFIRMED|_/);
      expect(s.length).toBeGreaterThan(10);
    }
    expect(out[7]).toContain(label);
    expect(out[8]).not.toContain(label);
  });

  it('uses the criterion description when provided and a generic sentence for unknown tokens', () => {
    expect(describeBlocker('CRITERION_missing:c1', { criterionText: { c1: 'Fix is deployed' } })).toBe('Fix is deployed: no reviewed evidence yet.');
    expect(describeBlocker('SOMETHING_NEW')).toBe('A required condition is not met yet.');
    expect(describeBlocker('PREDICATE_FAILED:c1:NEW_KIND')).toContain('NEW_KIND'); // visible, not blank
  });

  it('explains the live refusals seen in the P3 run', () => {
    expect(describeRefusal({ code: 'UNAUTHORIZED_ACTOR', detail: ['SELF_REVIEW'] })).toEqual([
      REFUSAL_TEXT.UNAUTHORIZED_ACTOR, DETAIL_TEXT.SELF_REVIEW,
    ]);
    const lines = describeRefusal({
      code: 'PRECONDITION_FAILED',
      detail: ['CRITERION_unmet:c1', 'PREDICATE_FAILED:c1:CUSTOMER_LABEL', 'PREDICATE_FAILED:c1:LINKED_TO_SOURCE'],
    }, { requiredCustomerLabel: 'customer-acme' });
    expect(lines.length).toBe(3); // the generic first line is dropped once specific reasons exist
    expect(lines[0]).not.toBe(REFUSAL_TEXT.PRECONDITION_FAILED);
    expect(lines.join(' ')).not.toMatch(/PRECONDITION_FAILED|PREDICATE_FAILED|CRITERION_/);
    expect(lines.join(' ')).toContain('customer-acme');
  });

  it('minimum-proof and illegal-transition details are readable', () => {
    expect(describeDetail('criteria.MINIMUM_PROOF_REQUIRED.c1:CUSTOMER_LABEL')).toContain('customer label');
    expect(describeDetail('criteria.MINIMUM_PROOF_REQUIRED.c1:LINKED_TO_SOURCE')).toContain('linked');
    expect(describeDetail('VERIFY from IN_PROGRESS')).toBe('Evidence verified is not possible while the promise is in progress.');
  });

  it('names the field when evidence input is malformed (the live "Some of the input is not valid" report)', () => {
    const lines = describeRefusal({ code: 'INVALID_INPUT', detail: ['sourceRef'] });
    expect(lines).toEqual([REFUSAL_TEXT.INVALID_INPUT, DETAIL_TEXT.sourceRef]);
    expect(lines[1]).toContain('ITS-6267');
  });

  it('falls back to naming an unmapped field path, but only for plain field shapes', () => {
    expect(describeRefusal({ code: 'INVALID_INPUT', detail: ['criteria.0.description'] })[1]).toBe('Check the field "criteria.0.description".');
    expect(describeRefusal({ code: 'INVALID_INPUT', detail: ['newField'] })[1]).toBe('Check the field "newField".');
    // Not field shapes: dropped, never echoed. Also never applied to other refusal codes.
    for (const bad of ['<img src=x>', 'a b', 'Robert; DROP', 'UPPER_TOKEN', 'x'.repeat(60), 'a.b.c.d.e.f']) {
      expect(describeRefusal({ code: 'INVALID_INPUT', detail: [bad] })).toEqual([REFUSAL_TEXT.INVALID_INPUT]);
    }
    expect(describeRefusal({ code: 'PRECONDITION_FAILED', detail: ['newField'] })).toEqual([REFUSAL_TEXT.PRECONDITION_FAILED]);
  });

  it('never blank and bounded: unknown code, missing detail, hostile detail', () => {
    expect(describeRefusal({}).length).toBe(1);
    expect(describeRefusal({ code: 'WHAT' })[0]).toMatch(/went wrong/);
    expect(describeRefusal({ code: 'INVALID_INPUT', detail: ['<script>alert(1)</script>', 'promiseText'] })).toEqual([
      REFUSAL_TEXT.INVALID_INPUT, DETAIL_TEXT.promiseText,
    ]); // unknown detail text is dropped, never echoed
    const many = Array.from({ length: 50 }, (_, i) => `x${i}`);
    expect(describeRefusal({ code: 'INVALID_INPUT', detail: many }).length).toBeLessThanOrEqual(9);
    expect(describeDetail('__proto__')).toBeUndefined();
    expect(describeDetail('constructor')).toBeUndefined();
    expect(describeDetail(42 as unknown as string)).toBeUndefined();
  });
});

describe('customerLabelFor (shared by the UI preview and the server verifier)', () => {
  it('normalises references the way the live run needed', () => {
    expect(customerLabelFor('SYNTHETIC-DELTA')).toBe('customer-synthetic-delta');
    expect(customerLabelFor('  Acme  Corp!! ')).toBe('customer-acme-corp');
    expect(customerLabelFor('x'.repeat(80))).toBe(`customer-${'x'.repeat(50)}`);
  });

  it('returns undefined when nothing usable remains, and the verifier uses the same function', () => {
    expect(customerLabelFor('---')).toBeUndefined();
    expect(customerLabelFor('')).toBeUndefined();
    for (const ref of ['SYNTHETIC-DELTA', 'a b', '---', 'Ünï-cödé 9']) expect(customerLabel(ref)).toBe(customerLabelFor(ref));
  });
});

describe('timeline', () => {
  const states = (l: string) => timeline(l).map((s) => s.state).join(',');
  it('marks reached stages done, the present stage current, the rest todo', () => {
    expect(states('DRAFT')).toBe('todo,todo,todo,todo,todo,todo');
    expect(states('CONFIRMED')).toBe('current,todo,todo,todo,todo,todo');
    expect(states('DELIVERED')).toBe('done,done,current,todo,todo,todo');
    expect(states('ACKNOWLEDGED')).toBe('done,done,done,done,current,todo');
  });
  it('fulfilled is complete, never "current", and an unknown state shows nothing reached', () => {
    expect(states('FULFILLED')).toBe('done,done,done,done,done,done');
    expect(states('MYSTERY')).toBe('todo,todo,todo,todo,todo,todo');
    expect(timeline('FULFILLED').map((s) => s.label)).toEqual(['Confirmed', 'In progress', 'Delivered', 'Verified', 'Acknowledged', 'Fulfilled']);
  });
});

describe('describeAudit / relativeTime / nextStep', () => {
  it('describes audit lines without codes', () => {
    expect(describeAudit({ type: 'VERIFY', fromLifecycle: 'DELIVERED', toLifecycle: 'VERIFIED' })).toBe('Evidence verified (Delivered to Verified)');
    expect(describeAudit({ type: 'ADD_EVIDENCE', fromLifecycle: 'DELIVERED', toLifecycle: 'DELIVERED' })).toBe('Evidence added');
    expect(describeAudit({ type: 'BRAND_NEW' })).toBe('Change recorded');
  });

  it('relative time is monotonic and falls back safely', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    expect(relativeTime('2026-11-03T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-11-03T11:30:00Z', now)).toBe('30 min ago');
    expect(relativeTime('2026-11-03T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-11-01T12:00:00Z', now)).toBe('2 d ago');
    expect(relativeTime('2026-10-01T12:00:00Z', now)).toBe('2026-10-01');
    expect(relativeTime('not a date', now)).toBe('not a date');
    expect(relativeTime('2026-11-03T13:00:00Z', now)).toBe('2026-11-03T13:00'); // future: no negative text
  });

  it('next step follows the viewer\'s permissions and never says fulfilled when review is required', () => {
    expect(nextStep({ lifecycle: 'DRAFT' }, ['CONFIRM'])).toMatch(/Confirm/);
    expect(nextStep({ lifecycle: 'DRAFT' }, [])).toMatch(/Waiting/);
    expect(nextStep({ lifecycle: 'DELIVERED' }, ['REVIEW_EVIDENCE'])).toMatch(/Review the evidence/);
    expect(nextStep({ lifecycle: 'VERIFIED' }, ['ACKNOWLEDGE'])).toMatch(/acknowledgement/);
    expect(nextStep({ lifecycle: 'FULFILLED' }, [], { required: false })).toMatch(/Done/);
    expect(nextStep({ lifecycle: 'FULFILLED' }, [], { required: true })).toBe('Reopen the promise to re-verify it.');
    expect(nextStep({ lifecycle: 'FULFILLED' }, [], { required: true })).not.toMatch(/Done/);
  });
});

describe('wording fixes found in the clean-install run (F3, F5)', () => {
  it('keeps the generic first line only when there is nothing more specific to say (negative)', () => {
    expect(describeRefusal({ code: 'PRECONDITION_FAILED' })).toEqual([REFUSAL_TEXT.PRECONDITION_FAILED]);
    expect(describeRefusal({ code: 'PRECONDITION_FAILED', detail: ['<unknown>'] })).toEqual([REFUSAL_TEXT.PRECONDITION_FAILED]);
    // other refusal codes keep their own head even with details
    expect(describeRefusal({ code: 'UNAUTHORIZED_ACTOR', detail: ['SELF_REVIEW'] })[0]).toBe(REFUSAL_TEXT.UNAUTHORIZED_ACTOR);
  });

  it('plainName trims trailing punctuation and whitespace and never throws on odd input', () => {
    expect(plainName('The fix is deployed for this customer.')).toBe('The fix is deployed for this customer');
    expect(plainName('  Done!?  ')).toBe('Done');
    expect(plainName('Keep inner. punctuation, here')).toBe('Keep inner. punctuation, here');
    for (const bad of [undefined, null, 5, {}, [], '', '...']) expect(plainName(bad)).toBe('');
  });

  it('a criterion that ends with a full stop no longer produces ".:" in a blocker or a decision line', () => {
    const ctx = { criterionText: { c1: 'The fix is deployed for this customer.' } };
    expect(describeBlocker('CRITERION_unmet:c1', ctx)).toBe('The fix is deployed for this customer: evidence does not meet the checks.');
    expect(describeBlocker('CRITERION_unmet:c1', ctx)).not.toContain('.:');
    // an empty or punctuation-only description falls back to the criterion id
    expect(describeBlocker('CRITERION_missing:c1', { criterionText: { c1: '...' } })).toBe('criterion c1: no reviewed evidence yet.');
  });

  it('describeDecision reads as a sentence, names unknown statuses without codes, and marks passing gates', () => {
    const text = { c1: 'The fix is deployed for this customer.' };
    expect(describeDecision({ criteria: [{ criterionId: 'c1', status: 'satisfied' }], canFulfill: true }, text)).toBe('Decision: The fix is deployed for this customer is satisfied; all gates held.');
    expect(describeDecision({ criteria: [{ criterionId: 'c1', status: 'unmet' }], canFulfill: false }, text)).toBe('Decision: The fix is deployed for this customer: evidence does not meet the checks.');
    expect(describeDecision({ criteria: [{ criterionId: 'zz', status: 'weird' }] }, {})).toBe('Decision: zz: weird.');
    expect(describeDecision({ criteria: [] }, {})).toBe('Decision: .');
  });
});