# PromiseTwin: judge guide (DRAFT, 2026-11-04)

Status: **draft.** Written from the code and from the live runs on the development demo site. The installation link does not exist yet (it needs a production deploy and the owner's explicit approval, planned for P7). **No person unfamiliar with the code has followed this guide yet**; that run is still open and may change it.

## What PromiseTwin does (one paragraph)
A customer promise is not fulfilled when a ticket is closed. In PromiseTwin it is fulfilled only when (1) real evidence issues carry the customer's own Jira label, are linked to the customer's request, and are Done with a resolution, (2) a different person has reviewed that evidence as valid, and (3) someone other than the promise owner has recorded the customer's acknowledgement. If the evidence changes later, the promise shows "Review required" and the history stays. No AI decides anything.

## What you need
- A Jira Service Management project on a site where you are the admin (use a test site).
- **Two Atlassian accounts** that can open the project:
  - **Account 1 (you, the project admin):** becomes the promise owner.
  - **Account 2 (a colleague or a second test account):** reviews and acknowledges.
  Why two: the owner cannot acknowledge their own promise and nobody can review evidence they added. The code (and the three-account live run) enforce this; the two-account variant below follows from the same rules but has not been run live yet.
- Use **synthetic customers only** (for example `SYNTHETIC-DELTA`). Do not enter real customer data.

## Setup (about 3 minutes)
1. Install the app from the installation link: `[LINK ADDED AT SUBMISSION]`. Installing requires a site admin.
2. Open any request in the project and find the **PromiseTwin** panel. Under "Your roles in <PROJECT>" you will see `APPROVER` only. That is correct: **everyone starts with no PromiseTwin role** (default deny).
3. In the same panel (project admins see "Role assignments"), choose yourself and tick **Support owner**, then Save roles. Choose Account 2 and tick **Reviewer** and **Acknowledger**, then Save roles. Saving replaces that person's roles, so tick both at once.

## The scenario (about 10 minutes)
Request = the customer ticket, here called `REQ-1`. You will create a second ticket `FIX-1` that acts as the evidence.

| # | Who | Do this | You should see |
|---|---|---|---|
| 1 | Account 1 | On `REQ-1`, "Record a customer promise": customer `SYNTHETIC-DELTA`, a promise, and a criterion. Create draft. | A Draft promise. The form shows the exact Jira label evidence must carry: `customer-synthetic-delta`. |
| 2 | Account 1 | Confirm promise, then Start work. | State moves to Confirmed, then In progress, with a timeline and a "Next:" line. |
| 3 | Account 1 | In Jira, create `FIX-1`. Do NOT finish it yet. Under "Add evidence" enter `FIX-1`. Then Mark delivered. | Evidence listed as "Awaiting review". |
| 4 | Account 2 | Open `REQ-1`. Mark `FIX-1` valid. Then try **Verify evidence**. | **Refused.** The panel says, in plain words, that the evidence issue is not Done, has no resolution, does not carry the customer label, and is not linked to this request. A reviewer saying "valid" is not enough. |
| 5 | Account 1 | Fix `FIX-1` in Jira: resolve it (Done with a resolution), add label `customer-synthetic-delta`, and link it to `REQ-1` (for example "Relates"). | Back on `REQ-1` the earlier review shows as out of date ("evidence changed since it was reviewed"). |
| 6 | Account 1 | Add `FIX-1` as evidence again. | A new evidence entry awaiting review. |
| 7 | Account 2 | Mark the new entry valid, **Verify evidence**, **Acknowledge (accept)**, then **Mark fulfilled**. | State Fulfilled. The history lines carry a decision summary (the criterion is satisfied, all gates held). |
| 8 | Account 1 | Try to **Acknowledge** your own promise (use a promise at the Verified step). | Refused: the owner cannot acknowledge their own promise. |
| 9 | Account 1 | In Jira, remove the label from `FIX-1`. Reload `REQ-1`. | The Fulfilled promise shows **"Review required: this promise is marked fulfilled, but its proof no longer holds."** The fulfilment stays on record; nothing changed by itself. |
| 10 | Anyone | Open the project's **Promises** page (left navigation). | A list of the project's promises with filters, "Needs my action" per role, and "Review required". |

Steps 1 to 7 and 9 to 10 were run live with three accounts in the development environment (see `docs/P3-EVIDENCE.md` and `docs/P4-EVIDENCE.md`). Step 8 is covered by unit tests, not yet run live in the current build.

## What is deliberately not there
- No automatic message is ever sent to a customer.
- A closed or Done ticket never fulfils a promise on its own.
- No AI output influences any decision. (Rovo is a later, advisory-only phase; its availability on a free site is not yet verified.)
- No demo mode that skips the second person (decision recorded in `docs/P4-PLAN.md`, option (a)).

## Known limits to be aware of
- The checks read facts that Jira editors can change (labels, links, status). They are observable and recorded, not cryptographic proof. The real control is those checks plus an independent reviewer plus an independent acknowledger.
- Role assignments and audit entries are logged but are not tamper-proof storage.
- The Promises page shows a promise's customer and text to anyone who can open its request, and says how many more exist on requests you cannot open.
- Not yet verified by a person who did not write the code, with a screen reader, or on a real phone.
