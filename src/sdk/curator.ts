/**
 * The curator's one call to the model.
 *
 * It holds NO tools. The curator reads what a finished job did and returns
 * structured facts; a curator that could act would be a second, ungated path
 * to every capability — the same reason the planner carries `tools: []`.
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
  };

  let text = '';
  for await (const message of query({ prompt: brief.text, options })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') text += block.text;
      }
    }
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('curateWithModel: no JSON object in the response');
  }

  return CurationResult.parse(JSON.parse(text.slice(start, end + 1)));
};
