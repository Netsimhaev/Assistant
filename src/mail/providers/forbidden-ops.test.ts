import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = /trash|\/delete|DELETE|\bmove\b|SPAM|UNREAD|isRead|removeLabelIds|junk|block/i;

describe('mailbox provider code never carries a forbidden operation', () => {
  it('scans gmail.ts and graph.ts as text', () => {
    const files = ['gmail.ts', 'graph.ts'].map((f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
    expect(files).toHaveLength(2);
    for (const text of files) expect(text.length).toBeGreaterThan(500);
    for (const text of files) expect(text).not.toMatch(FORBIDDEN);
  });

  it('the regex does catch the operations it names', () => {
    for (const bad of ['TRASH', '/delete', 'DELETE', 'move', 'SPAM', 'UNREAD', 'isRead', 'removeLabelIds', 'junk', 'block']) {
      expect(bad).toMatch(FORBIDDEN);
    }
  });
});
