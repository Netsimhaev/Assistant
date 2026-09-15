/**
 * Which finished jobs are worth a billed model call.
 *
 * The owner's decision (spec §2 row 5) is "when the job read or
 * communicated". Both halves of that sentence are already defined elsewhere
 * and enforced elsewhere: `ingestsExternalContent` is the table the
 * first-contact exemption reads, and `OUTBOUND_TOOLS` is the table that
 * decides redaction, quiet hours and the kill switch's outbound scope.
 *
 * This derives from both rather than restating either. A second list of
 * "tools that read" would be a second definition, and this codebase has
 * three separate incidents of exactly that drifting apart.
 */
import type { Plan } from '../domain/plan.js';
import { ingestsExternalContent, isOutbound } from '../policy/classify.js';

export function jobQualifiesForCuration(plan: Plan): boolean {
  return plan.steps.some(
    (step) => ingestsExternalContent(step.toolName) || isOutbound(step.toolName),
  );
}
