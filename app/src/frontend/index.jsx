import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Text, Lozenge, Stack, SectionMessage } from '@forge/react';
import { invoke } from '@forge/bridge';

// P0 spike panel: shows what the backend read from Jira/JSM for this issue.
// Engineering status and promise fulfillment are shown separately on purpose.
const App = () => {
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    invoke('getRequestSnapshot')
      .then(setSnap)
      .catch((e) => setError(String(e && e.message ? e.message : e)));
  }, []);

  if (error) {
    return (
      <SectionMessage appearance="error" title="Could not read request">
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!snap) return <Text>Loading...</Text>;

  let jsmText = 'JSM lookup unreadable';
  if (snap.jsm.kind === 'available') {
    jsmText = `JSM request (type ${snap.jsm.requestTypeId ?? 'n/a'}, portal status ${snap.jsm.portalStatus ?? 'n/a'})`;
  } else if (snap.jsm.kind === 'not-a-jsm-request') {
    jsmText = `Not readable as a JSM request (HTTP ${snap.jsm.httpStatus})`;
  }

  return (
    <Stack space="space.100">
      <Text>{snap.issueKey}: {snap.summary}</Text>
      <Text>Issue status: {snap.issueStatus}</Text>
      <Lozenge appearance={snap.engineeringDone ? 'success' : 'inprogress'}>
        {snap.engineeringDone ? 'Engineering done' : 'Engineering open'}
      </Lozenge>
      <Lozenge appearance="default">Promise fulfillment: {snap.fulfillment}</Lozenge>
      <Text>{jsmText}</Text>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
