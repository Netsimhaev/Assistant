import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No automatic promotion (phase 2, package 2). Three writes widen what goes
 * out to a contact alone: turning a topic's auto reply ON, creating a topic,
 * and marking a document public. Each happens only on an explicit owner act —
 * a dashboard screen, or `applySuggestion` on the owner's "yes". A third
 * caller (the suggestion pass itself, a tool handler, the conductor) would let
 * the assistant promote itself. Narrowing stays open to anyone: a call that
 * turns auto reply OFF with a literal `false` (the package-1 mark path and the
 * auto re-raise) is not restricted (ruling R2).
 *
 * Checked by reading the source, tests excluded — the property is about WHO
 * calls, not what a call does.
 */
const SRC = join(process.cwd(), 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

function allowed(rel: string): boolean {
  return rel.startsWith('dashboard/') || rel === 'whatsapp/suggestion-apply.ts';
}

/** The argument list of the call whose `(` is at `open`, split at top-level commas. */
function callArgs(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = open + 1; i < source.length; i += 1) {
    const ch = source[i] as string;
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  return args;
}

const CALL = /(?<!function\s+)\b(createTopic|setPublicFor|setPublicForSuggested|setTopicAutoReply)\s*\(/g;
// A renamed import or a bare reference passed around would slip past CALL.
const ALIAS = /\b(createTopic|setPublicFor|setPublicForSuggested|setTopicAutoReply)\s+as\s+\w/;
const BARE_REF = /(?:=|:|,|\(|return)\s*(createTopic|setPublicFor|setPublicForSuggested|setTopicAutoReply)\s*[,;)\n]/;

/** Every promoting use in a source, as `name` strings. */
function promotingUses(source: string): string[] {
  const uses: string[] = [];
  for (const m of source.matchAll(CALL)) {
    const name = m[1] as string;
    if (name === 'setTopicAutoReply') {
      const args = callArgs(source, (m.index ?? 0) + m[0].length - 1);
      if (args[2] === 'false') continue;
    }
    uses.push(name);
  }
  const alias = ALIAS.exec(source);
  if (alias !== null) uses.push(`${alias[1] as string} (alias)`);
  const withoutImports = source.replace(/import\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"]/g, '');
  const bare = BARE_REF.exec(withoutImports);
  if (bare !== null) uses.push(`${bare[1] as string} (reference)`);
  return uses;
}

describe('no automatic promotion — only the owner turns things on', () => {
  it('the scan catches planted promoting calls and spares narrowing and definitions', () => {
    for (const planted of [
      'await createTopic(db, { name })',
      'await setPublicFor(db, id, "both", by)',
      'await setPublicForSuggested(db, id, appliesTo, by)',
      'await setTopicAutoReply(db, topicId, true, by)',
      "await setTopicAutoReply(db, topic.id, form.get('on') === '1', by)",
      'await setTopicAutoReply(db, loadId(x, y), on, by)',
      "import { createTopic as make } from './contact-topics.js'",
      'const f = createTopic;',
      'run(setPublicFor, id)',
    ]) {
      expect(promotingUses(planted), planted).not.toEqual([]);
    }
    for (const spared of [
      'await setTopicAutoReply(db, context.topicId, false, by)',
      'await setTopicAutoReply(db, pick(a, b), false, session.username)',
      'export async function createTopic(db: BusinessDb, input: TopicInput) {',
      'export async function setTopicAutoReply(db: BusinessDb, topicId: string, on: boolean, by: string) {',
      'export async function setPublicForSuggested(',
      "import { createTopic, listTopics } from './contact-topics.js'",
      "import {\n  listTopics,\n  createTopic,\n  loadTopic,\n} from './contact-topics.js'",
    ]) {
      expect(promotingUses(spared), spared).toEqual([]);
    }
  });

  it('only the dashboard screens and src/whatsapp/suggestion-apply.ts promote', () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(100); // positive control: the scan found the source tree
    const offenders: string[] = [];
    const reached = new Set<string>();
    for (const f of files) {
      const rel = relative(SRC, f).split('\\').join('/');
      const uses = promotingUses(readFileSync(f, 'utf8'));
      if (uses.length === 0) continue;
      reached.add(rel);
      if (!allowed(rel)) offenders.push(`${rel}: ${uses.join(', ')}`);
    }
    expect(offenders).toEqual([]);
    // Positive control: the known promoters are found, so the patterns are live.
    expect(reached).toContain('whatsapp/suggestion-apply.ts');
    expect(reached).toContain('dashboard/contact-topics-routes.ts');
    expect(reached).toContain('dashboard/public-documents-routes.ts');
  });
});
