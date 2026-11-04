import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Checkbox,
  Heading,
  Inline,
  Label,
  Link,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Strong,
  Tag,
  Text,
  Textfield,
  User,
  UserPicker,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import {
  CRITERION_STATUS_TEXT,
  LIFECYCLE_TEXT,
  customerLabelFor,
  describeAudit,
  describeBlocker,
  describeRefusal,
  nextStep,
  relativeTime,
  timeline,
} from '../shared/messages';

// The UI owns NO authorization: it shows what the server says is available and sends commands;
// the resolver re-checks everything. Engineering status and promise fulfilment are deliberately
// different things, so they are shown side by side. All wording comes from shared/messages.js.

const newId = () =>
  (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '-');

const STATE_APPEARANCE = {
  DRAFT: 'default', CONFIRMED: 'new', IN_PROGRESS: 'inprogress', DELIVERED: 'inprogress',
  VERIFIED: 'moved', ACKNOWLEDGED: 'moved', FULFILLED: 'success',
};

const LABEL = {
  CONFIRM: 'Confirm promise', START: 'Start work', MARK_DELIVERED: 'Mark delivered', VERIFY: 'Verify evidence',
  FULFILL: 'Mark fulfilled', REOPEN: 'Reopen',
};
// Commands that need no extra input are rendered as plain buttons.
const SIMPLE = ['CONFIRM', 'START', 'MARK_DELIVERED', 'VERIFY', 'FULFILL'];

// Status is always shown as a word (and a glyph in the timeline), never as colour alone.
const GLYPH = { done: '✔', current: '▶', todo: '○' };

/** Error box: a readable first line plus reasons, never a raw code. */
const Problem = ({ lines, title }) => (
  <SectionMessage appearance="error" title={title}>
    {lines.map((l, i) => <Text key={i}>{l}</Text>)}
  </SectionMessage>
);

const failureLines = (r, ctx) => describeRefusal(r, ctx);
const thrownLines = (e) => [String(e && e.message ? e.message : e).slice(0, 200)];

const ASSIGNABLE = [
  ['AGENT', 'Support owner (create, confirm, progress)'], ['CONTRIBUTOR', 'Engineering contributor (attach evidence only)'],
  ['REVIEWER', 'Reviewer (review and verify evidence)'], ['ACKNOWLEDGER', 'Acknowledger (accept or deny fulfilment)'],
];

// Per-project role administration. Admin-only controls are shown only when the SERVER says the
// caller is a project admin; the resolver re-checks it on every change.
const RolesPanel = ({ onView }) => {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [busy, setBusy] = useState(false);

  const accept = useCallback((v) => { setView(v); setError(null); if (onView) onView(v); }, [onView]);
  const load = useCallback(() => {
    invoke('getRoles').then((r) => (r.ok ? accept(r.value) : setError(failureLines(r)))).catch((e) => setError(thrownLines(e)));
  }, [accept]);
  useEffect(load, [load]);

  const save = async (accountId, roles) => {
    setBusy(true); setError(null);
    const r = await invoke('setRoles', { assignment: { accountId, roles } });
    setBusy(false);
    if (r.ok) { accept(r.value); setPicked(null); setChosen([]); } else setError(failureLines(r));
  };

  if (!view) return error ? <Problem lines={error} title="Could not load roles" /> : null;
  return (
    <Stack space="space.100">
      <Heading size="xsmall">Your roles in {view.projectKey}</Heading>
      <Text>{view.myRoles.length ? view.myRoles.join(', ') : 'none (read-only). Ask a project admin to assign you a role.'}</Text>
      {view.canAdminister && (
        <Stack space="space.100">
          <Heading size="xsmall">Role assignments (project admins)</Heading>
          {(view.assignments || []).length === 0 && <Text>No roles assigned yet. Everyone without a role is read-only.</Text>}
          {(view.assignments || []).map((a) => (
            <Inline key={a.accountId} space="space.100" alignBlock="center" shouldWrap>
              <User accountId={a.accountId} />
              {a.roles.map((r) => <Tag key={r} text={r} />)}
              <Button isDisabled={busy} onClick={() => save(a.accountId, [])}>Remove</Button>
            </Inline>
          ))}
          <UserPicker label="Assign roles to" name="role-user" onChange={(u) => setPicked(u && u.id ? u.id : null)} />
          {ASSIGNABLE.map(([role, text]) => (
            <Checkbox key={role} label={text} isChecked={chosen.includes(role)}
              onChange={(e) => setChosen((cur) => (e.target.checked ? [...new Set([...cur, role])] : cur.filter((x) => x !== role)))} />
          ))}
          <Text>Saving replaces all roles this person has in this project.</Text>
          <Button appearance="primary" isDisabled={busy || !picked || chosen.length === 0} onClick={() => save(picked, chosen)}>Save roles</Button>
          {error && <Problem lines={error} />}
          {(view.history || []).length > 0 && (
            <Stack space="space.050">
              <Heading size="xsmall">Recent role changes</Heading>
              {view.history.slice().reverse().slice(0, 5).map((h, i) => (
                <Text key={`${h.at}-${i}`}>{relativeTime(h.at)} · {h.roles.length ? h.roles.join(', ') : 'roles removed'}</Text>
              ))}
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  );
};

/** A text field with a real, associated label (placeholders alone are not accessible names). */
const Field = ({ id, label, help, value, onChange }) => (
  <Stack space="space.050">
    <Label labelFor={id}>{label}</Label>
    <Textfield id={id} name={id} value={value} onChange={(e) => onChange(e.target.value)} />
    {help && <Text>{help}</Text>}
  </Stack>
);

const CreateForm = ({ onCreated }) => {
  const [customerReference, setCustomerReference] = useState('');
  const [promiseText, setPromiseText] = useState('');
  const [criterion, setCriterion] = useState('');
  // Machine-checkable conditions on the EVIDENCE issue. Customer label and request link are
  // MANDATORY (server policy); "Done with a resolution" is an optional extra.
  const [needDone, setNeedDone] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Idempotency key for THIS form submission; reused on retry, renewed after success.
  const [requestId, setRequestId] = useState(newId);

  const label = customerLabelFor(customerReference);
  const complete = Boolean(customerReference && promiseText && criterion);

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    const predicates = [{ kind: 'CUSTOMER_LABEL' }, { kind: 'LINKED_TO_SOURCE' }];
    if (needDone) predicates.push({ kind: 'STATUS_CATEGORY_IS', value: 'done' }, { kind: 'RESOLUTION_SET' });
    const input = {
      requestId, customerReference, promiseText,
      criteria: [{ id: 'c1', type: 'LINKED_WORK', description: criterion, required: true, predicates }],
    };
    try {
      const r = await invoke('createContract', { input });
      if (r.ok) {
        setCustomerReference(''); setPromiseText(''); setCriterion(''); setRequestId(newId());
        onCreated();
      } else setError(failureLines(r, { requiredCustomerLabel: label }));
    } catch (e) { setError(thrownLines(e)); }
    setBusy(false);
  };

  return (
    <Stack space="space.150">
      <Heading size="small">Record a customer promise</Heading>
      <Field id="pt-customer" label="Customer" value={customerReference} onChange={setCustomerReference}
        help="A short reference, for example ACME. Evidence must be tagged for this customer in Jira." />
      <Field id="pt-promise" label="What was promised" value={promiseText} onChange={setPromiseText}
        help="The commitment in the customer's terms." />
      <Field id="pt-criterion" label="What proves it" value={criterion} onChange={setCriterion}
        help="For example: the fix is deployed for this customer." />
      <Text>
        Evidence is always checked automatically. The evidence issue must be linked to this request
        {label ? <> and carry the Jira label <Strong>{label}</Strong></> : ' and carry this customer\'s Jira label (shown once you enter the customer)'}.
      </Text>
      <Checkbox label="Also require the evidence issue to be Done, with a resolution" isChecked={needDone} onChange={(e) => setNeedDone(e.target.checked)} />
      {error && <Problem lines={error} title="The promise was not created" />}
      {!complete && <Text>Fill in all three fields to continue.</Text>}
      <Button appearance="primary" isDisabled={busy || !complete} onClick={submit}>{busy ? 'Creating...' : 'Create draft'}</Button>
    </Stack>
  );
};

/** Six-stage progress line: a word plus a glyph per stage. */
const Timeline = ({ lifecycle }) => (
  <Inline space="space.100" shouldWrap rowSpace="space.050">
    {timeline(lifecycle).map((s) => (
      <Text key={s.stage}>{s.state === 'current' ? <Strong>{GLYPH[s.state]} {s.label}</Strong> : `${GLYPH[s.state]} ${s.label}`}</Text>
    ))}
  </Inline>
);

const Contract = ({ view, reload, startOpen }) => {
  const { contract: c, decision, available, audit } = view;
  const [open, setOpen] = useState(startOpen);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sourceRef, setSourceRef] = useState('');
  const [criterionId] = useState(c.criteria[0] ? c.criteria[0].id : '');
  const [reason, setReason] = useState('');
  const [linkKey, setLinkKey] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const ctx = {
    requiredCustomerLabel: view.requiredCustomerLabel,
    criterionText: Object.fromEntries(c.criteria.map((x) => [x.id, x.description])),
  };
  const has = (t) => available.includes(t);
  const reviewRequired = view.reviewRequired && view.reviewRequired.required;

  const refresh = async () => {
    setBusy(true); setMessage(null);
    try {
      const r = await invoke('refreshLinkedWork', { contractId: c.id });
      if (r.ok) reload(); else setMessage(failureLines(r, ctx));
    } catch (e) { setMessage(thrownLines(e)); }
    setBusy(false);
  };

  const send = async (body) => {
    setBusy(true); setMessage(null);
    try {
      // eventId is an idempotency key: a double click replays safely instead of double-applying.
      const r = await invoke('applyCommand', { command: { contractId: c.id, eventId: newId(), expectedRevision: c.revision, ...body } });
      if (r.ok) reload(); else setMessage(failureLines(r, ctx));
      if (!r.ok && r.code === 'VERSION_CONFLICT') reload();
    } catch (e) { setMessage(thrownLines(e)); }
    setBusy(false);
  };

  const summary = (a) => (a.report
    ? ` Decision: ${a.report.criteria.map((x) => `${ctx.criterionText[x.criterionId] || x.criterionId} is ${CRITERION_STATUS_TEXT[x.status] || x.status}`).join('; ')}${a.report.canFulfill ? '; all gates held' : ''}.`
    : '');

  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <Lozenge appearance={STATE_APPEARANCE[c.lifecycle]} isBold>{LIFECYCLE_TEXT[c.lifecycle] || c.lifecycle}</Lozenge>
        {c.atRisk && <Lozenge appearance="removed">At risk</Lozenge>}
        {reviewRequired && <Lozenge appearance="removed">Review required</Lozenge>}
      </Inline>
      <Text><Strong>{c.customerReference}</Strong>: {c.promiseText}</Text>
      <Text>Next: {nextStep(c, available, view.reviewRequired)}</Text>
      <Timeline lifecycle={c.lifecycle} />
      <Button onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Show details'}</Button>

      {open && (
        <Stack space="space.100">
          {reviewRequired && (
            <SectionMessage appearance="warning" title="Review required: this promise is marked fulfilled, but its proof no longer holds">
              {view.reviewRequired.reasons.map((x) => <Text key={x}>{describeBlocker(x, ctx)}</Text>)}
              <Text>The fulfilment stays on record. Reopen the promise (with a reason) to re-verify it.</Text>
            </SectionMessage>
          )}

          {/* The product's central idea: engineering progress and the promise are different things. */}
          <Inline space="space.200" shouldWrap rowSpace="space.100" alignBlock="start">
            <Stack space="space.050">
              <Heading size="xsmall">What engineering says</Heading>
              {c.linkedWork.length === 0 && <Text>No work linked yet.</Text>}
              {c.linkedWork.map((l) => (
                <Inline key={l.issueId} space="space.100" alignBlock="center" shouldWrap>
                  <Link href={`/browse/${l.issueKey}`}>{l.issueKey}</Link>
                  <Lozenge appearance={l.statusCategory === 'done' ? 'success' : 'inprogress'}>{l.statusName}</Lozenge>
                  <Text>seen {relativeTime(l.observedUpdated)}</Text>
                  {has('UNLINK_WORK') && <Button isDisabled={busy} onClick={() => send({ type: 'UNLINK_WORK', issueKey: l.issueKey })}>Unlink</Button>}
                </Inline>
              ))}
              {view.hiddenLinks > 0 && <Text>{view.hiddenLinks} linked item(s) you do not have access to.</Text>}
              <Text>Progress only. It is never proof.</Text>
            </Stack>
            <Stack space="space.050">
              <Heading size="xsmall">What the promise says</Heading>
              {decision.criteria.map((cr) => {
                const crit = c.criteria.find((x) => x.id === cr.criterionId);
                return (
                  <Stack key={cr.criterionId} space="space.050">
                    <Inline space="space.100" alignBlock="center" shouldWrap>
                      <Lozenge appearance={cr.status === 'satisfied' ? 'success' : 'removed'}>{cr.status === 'satisfied' ? 'Proven' : 'Not proven'}</Lozenge>
                      <Text>{crit ? crit.description : cr.criterionId}</Text>
                    </Inline>
                    <Text>{CRITERION_STATUS_TEXT[cr.status] || cr.status}</Text>
                    {cr.failedPredicates.map((k) => <Text key={k}>{describeBlocker(`PREDICATE_FAILED:${cr.criterionId}:${k}`, ctx)}</Text>)}
                  </Stack>
                );
              })}
              {decision.canFulfill
                ? <Text>All gates satisfied.</Text>
                : decision.blockers.filter((b) => !b.startsWith('PREDICATE_FAILED:') && !b.startsWith('CRITERION_')).map((b) => <Text key={b}>{describeBlocker(b, ctx)}</Text>)}
            </Stack>
          </Inline>

          {c.evidence.length > 0 && (
            <Stack space="space.050">
              <Heading size="xsmall">Evidence</Heading>
              {c.evidence.map((e) => (
                <Inline key={e.id} space="space.100" alignBlock="center" shouldWrap>
                  <Link href={`/browse/${e.sourceRef}`}>{e.sourceRef}</Link>
                  <Text>as of {relativeTime(e.sourceRevision)}</Text>
                  <Lozenge appearance={e.reviewStatus === 'VALID' ? 'success' : e.reviewStatus === 'INVALID' ? 'removed' : 'default'}>
                    {e.reviewStatus === 'VALID' ? 'Reviewed: valid' : e.reviewStatus === 'INVALID' ? 'Reviewed: invalid' : 'Awaiting review'}
                  </Lozenge>
                  {has('REVIEW_EVIDENCE') && e.reviewStatus === 'PENDING' && (
                    <Inline space="space.050">
                      <Button isDisabled={busy} onClick={() => send({ type: 'REVIEW_EVIDENCE', evidenceId: e.id, status: 'VALID' })}>Mark valid</Button>
                      <Button isDisabled={busy} onClick={() => send({ type: 'REVIEW_EVIDENCE', evidenceId: e.id, status: 'INVALID' })}>Mark invalid</Button>
                    </Inline>
                  )}
                </Inline>
              ))}
              {has('REVIEW_EVIDENCE') && c.evidence.some((e) => e.reviewStatus === 'PENDING') && (
                <Text>Reviewing records you, by name, as the reviewer in the audit trail. You cannot review evidence you added.</Text>
              )}
            </Stack>
          )}

          {has('LINK_WORK') && (
            <Stack space="space.050">
              <Field id={`pt-link-${c.id}`} label="Link engineering work" value={linkKey} onChange={setLinkKey} help="A work item key such as DEV-7. Used for progress only." />
              <Button isDisabled={busy || !linkKey} onClick={() => send({ type: 'LINK_WORK', issueKey: linkKey.trim().toUpperCase() }).then(() => setLinkKey(''))}>Link work</Button>
            </Stack>
          )}
          {(c.linkedWork.length > 0 || view.hiddenLinks > 0) && (
            <Button isDisabled={busy} onClick={refresh}>Refresh linked work</Button>
          )}

          {has('ADD_EVIDENCE') && (
            <Stack space="space.050">
              <Field id={`pt-evidence-${c.id}`} label="Add evidence" value={sourceRef} onChange={setSourceRef} help="The key of the Jira issue that proves it, such as PROJ-12." />
              <Button isDisabled={busy || !sourceRef} onClick={() => send({ type: 'ADD_EVIDENCE', criterionId, sourceRef: sourceRef.trim().toUpperCase() }).then(() => setSourceRef(''))}>Add evidence</Button>
            </Stack>
          )}

          <Inline space="space.100" shouldWrap rowSpace="space.050">
            {SIMPLE.filter(has).map((t) => (
              <Button key={t} appearance={t === 'FULFILL' ? 'primary' : 'default'} isDisabled={busy} onClick={() => send({ type: t })}>{LABEL[t]}</Button>
            ))}
            {has('ACKNOWLEDGE') && (
              <>
                <Button appearance="primary" isDisabled={busy} onClick={() => send({ type: 'ACKNOWLEDGE', decision: 'GRANTED' })}>Acknowledge (accept)</Button>
                <Button isDisabled={busy} onClick={() => send({ type: 'ACKNOWLEDGE', decision: 'DENIED' })}>Acknowledge (deny)</Button>
              </>
            )}
          </Inline>
          {has('ACKNOWLEDGE') && <Text>Acknowledgement records that the customer accepted or denied this delivery. It is part of the audit trail.</Text>}

          {has('REOPEN') && (
            <Stack space="space.050">
              <Field id={`pt-reopen-${c.id}`} label="Reason to reopen" value={reason} onChange={setReason} help="Recorded in the audit trail. The previous history stays." />
              <Button isDisabled={busy || !reason} onClick={() => send({ type: 'REOPEN', reason }).then(() => setReason(''))}>Reopen</Button>
            </Stack>
          )}

          {message && <Problem lines={message} title="That did not go through" />}

          <Button onClick={() => setShowHistory(!showHistory)}>{showHistory ? 'Hide history' : `Show history (${audit.length})`}</Button>
          {showHistory && audit.slice().reverse().map((a) => (
            <Text key={a.id}>{relativeTime(a.at)} · {describeAudit(a)}.{summary(a)}</Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
};

const App = () => {
  const [views, setViews] = useState(null);
  const [error, setError] = useState(null);
  const [roles, setRoles] = useState(null);

  const load = useCallback(() => {
    invoke('listContracts')
      .then((r) => (r.ok ? (setViews(r.value), setError(null)) : setError(failureLines(r))))
      .catch((e) => setError(thrownLines(e)));
  }, []);
  useEffect(load, [load]);

  if (error) {
    return (
      <Stack space="space.100">
        <Problem lines={error} title="Could not load promises" />
        <Inline><Button onClick={() => { setError(null); load(); }}>Try again</Button></Inline>
      </Stack>
    );
  }
  if (!views) return <Spinner label="Loading promises" />;

  // Guidance only: the server refuses creation without the Support owner role regardless.
  const mayCreate = !roles || roles.myRoles.includes('AGENT');
  const noRole = roles && roles.myRoles.length === 0;

  return (
    <Stack space="space.200">
      {views.length === 0 && (
        <SectionMessage appearance="information" title="No customer promises on this request yet">
          <Text>A promise is a commitment made to one customer. It is only fulfilled when reviewed proof exists and the customer's acknowledgement is recorded, not when a ticket is closed.</Text>
          <Text>{mayCreate ? 'To start: fill in the form below, confirm the draft, then attach evidence as work progresses.' : 'You can read promises here. Creating one needs the Support owner role.'}</Text>
        </SectionMessage>
      )}
      {noRole && (
        <SectionMessage appearance="warning" title="You have no PromiseTwin role in this project">
          <Text>You can read promises, but cannot change them. Ask a project administrator to assign you a role (see "Your roles" below).</Text>
        </SectionMessage>
      )}
      {views.map((v) => (
        <Box key={v.contract.id}><Contract view={v} reload={load} startOpen={views.length === 1} /></Box>
      ))}
      {mayCreate && <CreateForm onCreated={load} />}
      <RolesPanel onView={setRoles} />
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
