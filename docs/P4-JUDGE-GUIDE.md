# PromiseTwin: judge guide (DRAFT, updated 2026-11-05)`n`n> **Superseded for judges by `submission/JUDGES-INSTALL.md` (P7), which carries the same scenario plus install, reset and troubleshooting. This file is kept as the P4 working copy; if the two differ, the submission file wins.**

Status: **draft.** Written from the code and from the live runs on the development demo site. The installation link does not exist yet (it needs a production deploy and the owner's explicit approval, planned for P7). **No person unfamiliar with the code has followed this guide yet**; that run is still open and may change it. A clean-install run of this guide is recorded in docs/P6-EVIDENCE.md.

## What PromiseTwin does (one paragraph)
A customer promise is not fulfilled when a ticket is closed. In PromiseTwin it is fulfilled only when (1) real evidence issues carry the customer's own Jira label, are linked to the customer's request, and are Done with a resolution, (2) a different person has reviewed that evidence as valid, and (3) someone other than the promise owner has recorded the customer's acknowledgement. If the evidence changes later, the promise shows "Review required" and the history stays. No AI decides anything.

## What you need
- A Jira Service Management project on a site where you are the admin (use a test site).
- **Two Atlassian accounts** that can open the project:
  - **Account 1 (you, the project admin):** becomes the promise owner.
  - **Account 2 (a colleague or a second test account):** reviews and acknowledges.
  Why two: the owner cannot acknowledge their own promise and nobody can review evidence they added. The two-account flow below was run live end to end on 2026-11-04.
- **Use two separate browsers or browser profiles** (for example Chrome and a private window of another browser), one per account. A browser keeps only ONE Atlassian login: signing in as the second account in another tab of the same browser logs the first one out, and you may then act as the wrong person without noticing. Check who you are before each step: the panel shows "Your roles in <PROJECT>" at the bottom (`AGENT, APPROVER` for the owner, `REVIEWER, ACKNOWLEDGER` for the reviewer).
- Use **synthetic customers only** (for example `SYNTHETIC-DELTA`). Do not enter real customer data.

## Setup (about 3 minutes)
0. If the PromiseTwin panel does not show on an issue right after installing, look for its small icon in the row of icons under the issue title and click it, or reload the page after a minute. (Seen once during the clean-install run; not seen on later loads.)
1. Install the app from the installation link: `[LINK ADDED AT SUBMISSION]`. Installing requires a site admin.
2. Open any request in the project and find the **PromiseTwin** panel. Under "Your roles in <PROJECT>" you will see `APPROVER` only. That is correct: **everyone starts with no PromiseTwin role** (default deny).
3. In the same panel (project admins see "Role assignments"), choose yourself and tick **Support owner**, then Save roles. Choose Account 2 and tick **Reviewer** and **Acknowledger**, then Save roles. Saving replaces that person's roles, so tick both at once.

## The scenario (about 10 minutes)
Request = the customer ticket, here called `REQ-1`. You will create a second ticket `FIX-1` that acts as the evidence.

| # | Who | Do this | You should see |
|---|---|---|---|
| 1 | Account 1 | On `REQ-1`, "Record a customer promise": customer `SYNTHETIC-DELTA`, a promise, and a criterion. Create draft. | A Draft promise. The form shows the exact Jira label evidence must carry: `customer-synthetic-delta`. |
| 2 | Account 1 | Confirm promise, then Start work. | State moves to Confirmed, then In progress, with a timeline and a "Next:" line. |
| 3 | Account 1 | In Jira, create `FIX-1`. Do NOT finish it yet. Under "Add evidence" enter **only the issue key** (for example `ITS-6267`, no title, no link, no spaces). Then Mark delivered (this button appears only after Start work). | Evidence listed as "Awaiting review". |
| 4 | Account 2 | Open `REQ-1`. Mark `FIX-1` valid. Then try **Verify evidence**. | **Refused.** The panel says, in plain words, that the evidence issue is not Done, has no resolution, does not carry the customer label, and is not linked to this request. A reviewer saying "valid" is not enough. |
| 5 | Account 1 | Fix `FIX-1` in Jira: set it to Done **with a resolution** (in some workflows "Mark as done" opens a dialog with a required Resolution; choose "Done" there. If the ticket shows Done but its Resolution field is empty, the promise will still refuse it; reopen it and finish it again with a resolution), add label `customer-synthetic-delta`, and link it to `REQ-1` (in Jira, Link work item: the type list starts with "action item from"; type "relates" to pick "relates to", then the key of `REQ-1`). | Back on `REQ-1` the earlier review shows as out of date ("evidence changed or expired since it was reviewed"). |
| 6 | Account 1 | Add `FIX-1` as evidence again. | A new evidence entry awaiting review. |
| 7 | Account 2 | Mark the new entry valid, **Verify evidence**, **Acknowledge (accept)**, then **Mark fulfilled**. | State Fulfilled. The history lines carry a decision summary (the criterion is satisfied, all gates held). |
| 8 | Account 1 | **Optional, needs extra setup.** Give Account 1 the **Acknowledger** role as well (tick Support owner and Acknowledger together, Save roles), create and take a second promise to the Verified step as in steps 1 to 7, then try **Acknowledge (accept)** as Account 1. Without the Acknowledger role the button is not offered at all, so there is nothing to try. | Refused: the owner cannot acknowledge their own promise. |
| 9 | Account 1 | In Jira, remove the label from `FIX-1`. Reload `REQ-1`. | The Fulfilled promise shows **"Review required: this promise is marked fulfilled, but its proof no longer holds."** The fulfilment stays on record; nothing changed by itself. |
| 10 | Anyone | Open the project's **Promises** page (left navigation). | A list of the project's promises with filters, "Needs my action" per role, and "Review required". |
| 11 | Anyone (optional) | Open Rovo chat on REQ-1, choose the agent **PromiseTwin**, and ask "Why is this promise not fulfilled yet?". Needs Rovo on your site. | A plain-language answer listing what is missing, with issue keys. It cannot change anything. If Rovo is not available, skip this step; the rest of the product does not depend on it. |

Steps 1 to 7 and 9 to 10 were run live with three accounts in the development environment (see `docs/P3-EVIDENCE.md` and `docs/P4-EVIDENCE.md`). Step 8 is covered by unit tests, not yet run live in the current build.

## What is deliberately not there
- No automatic message is ever sent to a customer.
- A closed or Done ticket never fulfils a promise on its own.
- No AI output influences any decision. A read-only Rovo agent (step 11) can explain a promise, but it has no write action, and its facts come from the same checks as the panel. Rovo worked on the demo site used for development; it is not verified on any other site.
- No demo mode that skips the second person (decision recorded in `docs/P4-PLAN.md`, option (a)).

## Known limits to be aware of
- The checks read facts that Jira editors can change (labels, links, status). They are observable and recorded, not cryptographic proof. The real control is those checks plus an independent reviewer plus an independent acknowledger.
- Role assignments and audit entries are logged but are not tamper-proof storage.
- The Promises page shows a promise's customer and text to anyone who can open its request, and says how many more exist on requests you cannot open.
- Not yet verified by a person who did not write the code, with a screen reader, or on a real phone.
