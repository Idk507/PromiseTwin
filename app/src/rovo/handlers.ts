import { buildService } from '../wiring';
import { createRovoActions } from './actions';

// Forge function entry points for the Rovo actions. Jira reads inside ContractService use
// api.asUser (adapters/forge-jira.ts), so every call is limited to what the invoking user can see.
// A fresh service per call: no state is shared between users.
const actions = () => createRovoActions(buildService());

export const getCommitment = (payload: unknown, context: unknown) => actions().getCommitment(payload, context);
export const explainMissingEvidence = (payload: unknown, context: unknown) => actions().explainMissingEvidence(payload, context);
export const listAtRisk = (payload: unknown, context: unknown) => actions().listAtRisk(payload, context);
