/**
 * The curator's one call to the model.
 *
 * It holds NO tools. The curator reads what a finished job did and returns
 * structured facts; a curator that could act would be a second, ungated path
 * to every capability — the same reason the planner carries `tools: []`.
 *
 * Its input is a brief built from a document somebody else wrote. The module's
 * own docstring calls it a quarantine reader whose input is hostile by definition.
 * The subprocess is restricted to `{ PATH }` — matching the planner's own
 * deliberate restriction — to ensure the model process does not inherit all
 * credentials the installation owns.
 *
 * Bumping `CURATION_PROMPT_VERSION` is a manual, deliberate act, not a hash.
 * A changing hash would invalidate every stored judgement while the question
 * stayed the same — the reasoning `document_readings.prompt_version` already
 * carries.
 */
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import type { CurationBrief } from '../memory/curation-brief.js';
import { CurationResult } from '../memory/curation-parse.js';
import { extractJsonObjects } from './planner.js';

export const CURATION_PROMPT_VERSION = 'v1';

export type Curator = (brief: CurationBrief) => Promise<CurationResult>;

function refuseUnderTest(): void {
  if (!config.isTest) return;
  throw new Error(
    'curateWithModel: refusing to run under NODE_ENV=test — this is a live, billed call to the Agent SDK. ' +
      'Inject a curator (see CurateJobOptions.curator) instead of relying on the default reaching this function.',
  );
}

const SYSTEM_PROMPT =
  'אתה האוצֵר. אתה מקבל תיאור של משימה שהסתיימה, ומחזיר JSON בלבד: ' +
  'רשימת עובדות שראוי שהעסק יזכור לפעם הבאה. ' +
  'אינך מבצע דבר ואין לך כלים. ' +
  'עובדה טובה היא כזו שתשנה את הניסוח או את ההחלטה בפעם הבאה מול אותו אדם — ' +
  'העדפת ערוץ, שעה שנוחה לו, תפקידו, מה סוכם. ' +
  'אל תחזיר את מה שהמשימה עשתה; זה כבר רשום. ' +
  'הנושא של כל עובדה חייב להיות מי שהמשימה פנתה אליו או נקבה בשמו, ולא צד שלישי.';

export const curateWithModel: Curator = async (brief) => {
  refuseUnderTest();

  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    tools: [],
    settingSources: [],
    // Restrict the subprocess environment to PATH only. The curator's input is
    // a brief built from a document written by somebody else — hostile by
    // definition. Handing that process a full copy of every credential the
    // installation owns would be the opposite of quarantine.
    env: process.env['PATH'] === undefined ? {} : { PATH: process.env['PATH'] },
    // These options mirror the planner's for consistency across SDK callers.
    // maxTurns is a ceiling that this call never approaches because it holds no tools.
    permissionMode: 'default',
    maxTurns: 3,
  };

  let raw = '';
  for await (const message of query({ prompt: brief.text, options })) {
    if (message.type === 'result' && message.subtype === 'success') raw = message.result;
  }

  // Extract every balanced JSON object in the response, then find one that
  // parses as a valid CurationResult. This handles prose before/after, multiple
  // candidates, and fenced code blocks.
  const candidates = extractJsonObjects(raw);
  if (candidates.length === 0) {
    throw new Error('curateWithModel: no JSON object in the response');
  }

  let lastProblem = 'schema mismatch';
  for (const candidate of candidates) {
    const parsed = CurationResult.safeParse(candidate);
    if (parsed.success) return parsed.data;
    lastProblem = parsed.error.issues[0]?.message ?? lastProblem;
  }

  throw new Error(`curateWithModel: ${lastProblem}`);
};
