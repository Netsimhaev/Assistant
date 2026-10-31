/**
 * Stage 10 of the setup interview: turning the owner's free-text "anything
 * else forbidden?" into a proposed rule.
 *
 * The model only proposes. This module builds the rule in code from the
 * validated fields, so model text never becomes rule text: the stored `text`
 * is always the owner's own sentence, and the only model-supplied strings that
 * reach a rule are `phrase` and `label`. Anything that does not validate falls
 * back to `guidance`, which constrains nothing mechanically and is shown to
 * the owner as such.
 */
import { z } from 'zod';
import { ActionClass } from '../../domain/action.js';
import { ACTION_CLASS_HE } from '../../domain/labels.js';
import { extractJsonObjects } from '../../util/json-extract.js';
import { AcceptedRule, CounterpartyEntry } from './answers.js';
import { INTERVIEW_ROWS, isReachable } from './rows.js';

/** What the model is asked to return. Loose by design; code does the building. */
const ModelProposal = z.object({
  kind: z.enum(['forbid', 'do_not_contact', 'never_say', 'guidance']),
  actionClasses: z.array(z.string()).optional(),
  label: z.string().optional(),
  emailDomain: z.string().optional(),
  phone: z.string().optional(),
  phrase: z.string().optional(),
});

/** Positive named set: the rows a forbid may name. */
const FORBIDDABLE: ReadonlySet<string> = new Set(INTERVIEW_ROWS.filter((r) => isReachable(r)));

export function parseRuleProposal(raw: string, text: string): AcceptedRule {
  const guidance: AcceptedRule = { kind: 'guidance', text };
  const first = extractJsonObjects(raw)[0];
  const parsed = ModelProposal.safeParse(first);
  if (!parsed.success) return guidance;
  const p = parsed.data;

  let rule: AcceptedRule = guidance;
  switch (p.kind) {
    case 'forbid': {
      const classes = new Set<ActionClass>();
      for (const c of p.actionClasses ?? []) {
        const cls = ActionClass.safeParse(c);
        if (cls.success && FORBIDDABLE.has(cls.data)) classes.add(cls.data);
      }
      if (classes.size === 0) return guidance;
      rule = { kind: 'forbid', text, actionClasses: [...classes] };
      break;
    }
    case 'do_not_contact': {
      const entry = CounterpartyEntry.safeParse({
        label: p.label ?? '',
        ...(p.emailDomain !== undefined ? { emailDomain: p.emailDomain } : {}),
        ...(p.phone !== undefined ? { phone: p.phone } : {}),
      });
      if (!entry.success) return guidance;
      rule = { kind: 'do_not_contact', text, entry: entry.data };
      break;
    }
    case 'never_say': {
      const phrase = (p.phrase ?? '').trim();
      if (phrase.length === 0) return guidance;
      rule = { kind: 'never_say', text, phrase };
      break;
    }
    case 'guidance':
      return guidance;
  }
  // Final gate: the built rule must satisfy the shared schema (text length etc.).
  const checked = AcceptedRule.safeParse(rule);
  return checked.success ? checked.data : guidance;
}

export function describeRule(rule: AcceptedRule): string {
  switch (rule.kind) {
    case 'forbid':
      return `לעולם לא: ${rule.actionClasses.map((c) => ACTION_CLASS_HE[c]).join(', ')}`;
    case 'do_not_contact': {
      const where = [rule.entry.emailDomain, rule.entry.phone].filter((v) => v !== undefined).join(', ');
      return `לא לפנות אל ${rule.entry.label} (${where})`;
    }
    case 'never_say':
      return `לעולם לא לכתוב: "${rule.phrase}"`;
    case 'guidance':
      return `הנחיה כללית (לא נאכפת אוטומטית): ${rule.text}`;
  }
}

export type RuleProposer = (text: string) => Promise<AcceptedRule>;
