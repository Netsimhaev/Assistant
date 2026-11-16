/**
 * The one way a panel action is recorded (admin-panel spec; global
 * constraints): a `platform_activity_log` row naming the staff member, and —
 * when the action touched a business — an `audit_log` row in that business's
 * own chain, so the owner's trail shows that a technician acted.
 *
 * **Neither row carries content.** The activity row takes the action kind and
 * only the counts/flags the caller passes in `detail` (`logStaffAction`
 * refuses anything else). The audit row's `reason` is the action kind and the
 * staff display name, and its `inputHash` hashes the action kind alone —
 * never a business name, an address, an email or anything typed.
 *
 * Every panel route calls this, and only this, to record what it did.
 *
 * Order: the platform row first, then the business row. The two live in
 * different databases' worth of trust (platform pool vs. the business's own
 * `withBusiness`), so they cannot share a transaction; a failure of the
 * second throws after the first committed, and the caller's 500 says so.
 */
import { appendAudit } from '../audit/log.js';
import { withBusiness } from '../db/pool.js';
import { logStaffAction, type StaffAction } from '../tenancy/activity-log.js';
import { canonicalHash } from '../util/canonical.js';

export interface RecordingStaff {
  staffId: string;
  displayName: string;
}

export async function recordStaffAction(
  staff: RecordingStaff,
  action: StaffAction,
  businessId: string | null,
  detail?: Record<string, number | boolean | string>,
): Promise<void> {
  await logStaffAction({
    staffId: staff.staffId,
    action,
    businessId,
    ...(detail !== undefined ? { detail } : {}),
  });
  if (businessId === null) return;
  await withBusiness(businessId, (db) =>
    appendAudit(db, {
      actor: 'human',
      onBehalfOf: `staff:${staff.staffId}`,
      kind: 'staff_action',
      // A panel action is not a policy evaluation: no charter version to
      // name, the convention `secret.ts` and `erasure.ts` already use.
      charterVersion: 'n/a',
      provenance: 'boss',
      inputHash: canonicalHash({ action }),
      reason: `${action} · ${staff.displayName}`,
    }),
  );
}
