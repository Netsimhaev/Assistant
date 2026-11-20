# Deleting a whole business

**Date:** 19/11/2026. **Source:** a conversation with the owner on the same day. Anything marked ⚙ is my decision, not his.

## Intent

When a customer leaves, the technical staff close their business in the system and **all of its data is deleted, immediately and completely**. No copy is given to the customer, no message is sent to the business owner, and nothing remains afterwards, including any record that the deletion took place.

## What the owner decided

1. **Only the head admin** (`is_head`) may delete a business, and only from the admin panel.
2. **Suspend first, then delete.** Only a business that is already suspended can be deleted. Suspension (which exists today) freezes everything without losing data. Deletion is a separate, later step.
3. **Mistake protection:** the head admin retypes the business name, which must match exactly.
4. **Immediate deletion, with no copy for the customer.** There is no export and no waiting period.
5. **No message to the business owner.**
6. **No record survives in the system's data:** nothing in the business's audit log, nothing in the panel activity log, and nothing saying "business X was deleted". **The server's technical logs (stdout/stderr) are outside this** (owner's answer, 19/11, option A): ordinary error handling stays as it is, and the code still writes no deliberate "deleted" record in them.
7. **The save folder is the customer's:** the customer also reaches `<DOCUMENT_SAVE_ROOT>/<businessId>`, so it is not deleted (owner's answer, 19/11).

## Goals

- **A "delete business" button on the business page in the panel.** It is shown only to the head admin and only when the business is suspended. It leads to a confirmation page that says in plain words what will be deleted and what will not (see below). Deletion happens only after the business name is typed exactly.
- **Delete everything the business has on our server:**
  - every database row whose `business_id` is that business, in every table, including tables that are append-only today (`audit_log`), the tables that "survive by name" in contact erasure (`signatures`, `spend_ledger`, `business_descriptions`), the business's sessions, devices and links, its secrets (`credentials`), its OAuth grants, its settings, and the `businesses` row itself;
  - the business's rows in `platform_activity_log`;
  - the business's files on disk: everything under `<DOCUMENT_ROOT>/<businessId>` (documents, logo), under `<DOCUMENT_ROOT>/produced/<businessId>` (produced files) and under `<DOCUMENT_INBOX_ROOT>/<businessId>`. (correction 20/11: produced files live under `produced/`)
  - **Not** `<DOCUMENT_SAVE_ROOT>/<businessId>`: the owner answered (19/11) that the customer also reaches this folder, so the files there are the customer's own, in the same sense as CLAUDE.md, "the copies `doc.save` wrote … are never deleted". The confirmation page states this in words, in the "what is not deleted" list.
- **Revoke access at providers:** for every live OAuth grant (Gmail, Google Calendar), attempt revocation at Google ⚙ on a best-effort basis. A failure does not stop the deletion. Microsoft has no revocation endpoint, so this is not possible there.
- **The business id becomes free:** a new business can be opened with the same id afterwards ⚙, **but only when none of the three per-business folders (document, inbox, save) holds any file** ⚙. Opening a business, from the panel or from the command line, refuses with a Hebrew message while any of them is non-empty. Otherwise a new business with the same id would get the previous customer's files: the document reader runs with that folder as its working directory, and the save folder is shared by path. The cost: an id whose save folder the customer did not clear stays blocked until someone clears it by hand.
- **"Finished" means files too** ⚙: if deleting any file fails, the deletion is not reported as finished, and the head admin can retry the file step. The business stays suspended, and has no rows, until that happens.
- **Secrets of external systems** ⚙: our copy is deleted. The confirmation page says the key is still active at the provider and that the customer can revoke it there.

## Non-goals

- **No export or copy** for the customer (owner ruling).
- **No message** to the business owner (owner ruling).
- **No waiting period or undo.** The protection is the prior suspension plus typing the name.
- **Deleting a whole business from the command line** is not part of this version ⚙. The panel is the place, and the head admin is the role.

## Anti-goals (what would make this a failure even if it technically works)

- **Deleting the wrong business** by mistake, or a business that was not suspended.
- **Partial deletion:** a row in some table, or a file, that survives without anyone knowing.
- **Deleting another business's data,** or data that belongs to the server: the master key, `platform_credentials`, `server_key_state`, other businesses' rows, the staff themselves.
- **A deletion that a business owner or a non-head staff member can trigger.**
- **Deleting while a scheduler pass for that business is still running,** so the pass writes new rows after the deletion.

## What is not deleted, and the confirmation page says so in words

- **Things held at the providers, which belong to the customer:** the mail in their mailbox, events in their calendar, records in their CRM or other external systems, and the GREEN-API instance and its messages.
- **The files in the save folder** (`<DOCUMENT_SAVE_ROOT>/<businessId>`), which the customer also reaches: they are the customer's, and they stay.
- **External-system keys at the provider:** our copy is deleted; the key itself stays active until the customer revokes it there.
- **Backups:** if the database or disk is backed up, the business stays in old backups until they are replaced. The deletion cannot reach a backup that was already taken.
- **The OAuth app access at Microsoft** stays until it expires or until the customer removes the app from their account.

## Constraints and fit with what exists

- **The deletion crosses the RLS walls deliberately.** It is a new cross-business operation and is added to the closed list in `src/tenancy/` as a named function, according to the rules in CLAUDE.md, "ריבוי עסקים".
- **`audit_log` is append-only at the database level** (the `audit_log_no_update` trigger), and the app role does not own tables. Deletion requires a privileged path. The builder chooses it, for example a `SECURITY DEFINER` function owned by the table owner that deletes one business's rows and nothing else. It is not called from any path other than this one, and an invariant test locks that.
- **A complete inventory, not a handwritten list.** A test seeds a row in every table that has `business_id` (found from `information_schema`, not from a list in a file), deletes, and asserts zero rows for that business in every table and unchanged rows for a second business. A new table that someone adds later and forgets to wire in will fail the test by name. This is the same pattern as `erasure-invariants.test.ts`.
- **Order:** database first, files after (the precedent of `executeErasure`). A file that failed to delete is reported to the head admin on screen. A file without a row is recoverable; a row without a file is not.
- **No running pass:** the deletion refuses if the business has a scheduler pass in flight, or takes the business's lock so that no new pass starts during the deletion. The builder chooses how; the requirement is that nothing writes for the business after the deletion.
- **Re-check under lock at execution time:** the business is still suspended, the typed name matches exactly, and the deleter is still an active head admin.
- **CSRF and session** as with every panel action.
- **The report on the screen** after deletion says how many rows and files were deleted and which files failed, if any. It contains no identities, and nothing about it is persisted (owner ruling).

## What is left to the builder

- **The exact privileged path** for deleting `audit_log` and the other owned tables, including an invariant that no one else calls it.
- **Delete order,** given foreign keys between tables.
- **How a running pass is prevented** (lock, or check of `inFlight` in the scheduler process). The scheduler is a separate process from the panel.
- **Whether a deletion of tens of thousands of rows** runs in one transaction or in batches. If in batches, it must survive a crash midway (resume until finished), and the business stays suspended throughout.
- **Live checks** (OAuth revocation at Google): none of them are run during the build. Every such check goes into docs/11.
