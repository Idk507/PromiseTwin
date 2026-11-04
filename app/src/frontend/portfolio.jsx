import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, { Box, Button, Heading, Inline, Link, Lozenge, SectionMessage, Spinner, Stack, Strong, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import { LIFECYCLE_TEXT, describeRefusal, nextStep, relativeTime } from '../shared/messages';

// Project portfolio. Read-only: it lists what the server returns and links to the request where
// each promise is worked. Hiding and scoping are decided by the server per viewer; the filters
// below only narrow what was already returned. Status is always a word, never colour alone.

const STATE_APPEARANCE = {
  DRAFT: 'default', CONFIRMED: 'new', IN_PROGRESS: 'inprogress', DELIVERED: 'inprogress',
  VERIFIED: 'moved', ACKNOWLEDGED: 'moved', FULFILLED: 'success',
};

const FILTERS = [
  ['all', 'All'],
  ['mine', 'Needs my action'],
  ['review', 'Review required'],
  ['risk', 'At risk'],
];
const matches = (f, r) => f === 'all' || (f === 'mine' && r.needsMyAction) || (f === 'review' && r.reviewRequired === 'yes') || (f === 'risk' && r.atRisk);

/** Gap in plain words from stored facts only (live proof status is on the request itself). */
const gap = (r) => {
  if (r.reviewRequired === 'yes') return 'Proof no longer holds: review required.';
  if (r.reviewRequired === 'unchecked') return 'Not re-checked here (too many promises); open the request to check.';
  const e = r.evidence;
  if (r.lifecycle === 'FULFILLED') return 'Fulfilled; proof still holds.';
  if (e.valid + e.pending + e.invalid === 0) return 'No evidence attached yet.';
  const parts = [];
  if (e.pending) parts.push(`${e.pending} awaiting review`);
  if (e.valid) parts.push(`${e.valid} reviewed valid`);
  if (e.invalid) parts.push(`${e.invalid} invalid`);
  return `Evidence: ${parts.join(', ')}.`;
};

const Row = ({ r }) => (
  <Stack space="space.050">
    <Inline space="space.100" alignBlock="center" shouldWrap>
      <Lozenge appearance={STATE_APPEARANCE[r.lifecycle]} isBold>{LIFECYCLE_TEXT[r.lifecycle] || r.lifecycle}</Lozenge>
      {r.atRisk && <Lozenge appearance="removed">At risk</Lozenge>}
      {r.reviewRequired === 'yes' && <Lozenge appearance="removed">Review required</Lozenge>}
      {r.needsMyAction && <Lozenge appearance="information">Needs your action</Lozenge>}
    </Inline>
    <Text><Strong>{r.customerReference}</Strong>: {r.promiseText}</Text>
    <Text>{gap(r)}</Text>
    <Text>Next: {nextStep({ lifecycle: r.lifecycle }, r.available, { required: r.reviewRequired === 'yes' })}</Text>
    <Inline space="space.100" alignBlock="center" shouldWrap>
      <Link href={`/browse/${r.issueKey}`}>Open request {r.issueKey}</Link>
      <Text>changed {relativeTime(r.updatedAt)}</Text>
    </Inline>
  </Stack>
);

const App = () => {
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState({ hidden: 0, myRoles: [], projectKey: '', nextCursor: undefined });
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState('all');

  const fetchPage = useCallback(async (cursor, append) => {
    try {
      const r = await invoke('getPortfolio', cursor ? { cursor } : {});
      if (!r.ok) { setError(describeRefusal(r)); return; }
      setError(null);
      setRows((cur) => (append && cur ? [...cur, ...r.value.rows] : r.value.rows));
      setMeta((m) => ({ projectKey: r.value.projectKey, myRoles: r.value.myRoles, nextCursor: r.value.nextCursor, hidden: (append ? m.hidden : 0) + r.value.hidden }));
    } catch (e) {
      setError([String(e && e.message ? e.message : e).slice(0, 200)]);
    }
  }, []);

  useEffect(() => { fetchPage(undefined, false); }, [fetchPage]);

  if (error) {
    return (
      <Stack space="space.100">
        <SectionMessage appearance="error" title="Could not load the portfolio">{error.map((l, i) => <Text key={i}>{l}</Text>)}</SectionMessage>
        <Inline><Button onClick={() => { setError(null); setRows(null); fetchPage(undefined, false); }}>Try again</Button></Inline>
      </Stack>
    );
  }
  if (!rows) return <Spinner label="Loading promises" />;

  const shown = rows.filter((r) => matches(filter, r)).sort((a, b) => Number(b.needsMyAction) - Number(a.needsMyAction));
  const noRole = meta.myRoles.length === 0;

  return (
    <Stack space="space.200">
      <Heading size="medium">Customer promises in {meta.projectKey}</Heading>
      <Text>A promise is fulfilled only when reviewed proof exists and the customer's acknowledgement is recorded, not when a ticket is closed.</Text>
      {noRole && (
        <SectionMessage appearance="warning" title="You have no PromiseTwin role in this project">
          <Text>You can read the promises below, but cannot change them. Ask a project administrator to assign you a role (open any request and see "Your roles").</Text>
        </SectionMessage>
      )}
      <Inline space="space.100" shouldWrap rowSpace="space.050" alignBlock="center">
        {FILTERS.map(([key, label]) => (
          <Button key={key} appearance={filter === key ? 'primary' : 'default'} onClick={() => setFilter(key)}>
            {`${label} (${rows.filter((r) => matches(key, r)).length})`}
          </Button>
        ))}
      </Inline>
      <Text>
        Showing {shown.length} of {rows.length} loaded{meta.nextCursor ? ' (more available)' : ''}.
        {meta.hidden > 0 ? ` ${meta.hidden} more in this project are on requests you cannot open.` : ''}
      </Text>
      {rows.length === 0 && (
        <SectionMessage appearance="information" title="No promises in this project yet">
          <Text>Open a request, find the PromiseTwin panel, and record the first customer promise. It will appear here.</Text>
        </SectionMessage>
      )}
      {rows.length > 0 && shown.length === 0 && <Text>Nothing matches this filter among the loaded promises.</Text>}
      {shown.map((r) => <Box key={r.id}><Row r={r} /></Box>)}
      {meta.nextCursor && (
        <Inline>
          <Button isDisabled={loadingMore} onClick={async () => { setLoadingMore(true); await fetchPage(meta.nextCursor, true); setLoadingMore(false); }}>
            {loadingMore ? 'Loading...' : 'Load more'}
          </Button>
        </Inline>
      )}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
