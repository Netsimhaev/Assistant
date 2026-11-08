import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The hold is the one documented gate bypass of the calendar feature. These
 * read source text, because the properties are about what the file can say and
 * who may import it, not about what it does when called.
 */
describe('holds bypass invariants', () => {
  it('writes no attendee but the empty list, and calls only createEvent and deleteEvent on the client', async () => {
    const source = await readFile('src/meetings/holds.ts', 'utf8');
    const code = source
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    const attendees = [...code.matchAll(/attendees\s*:\s*([^,\n}]*)/g)].map((m) => (m[1] ?? '').trim());
    expect(attendees.length).toBeGreaterThan(0);
    for (const a of attendees) expect(a).toBe('[]');

    const methods = new Set([...code.matchAll(/\.client\.(\w+)\(/g)].map((m) => m[1]));
    expect([...methods].sort()).toEqual(['createEvent', 'deleteEvent']);
    // No other way to reach the client.
    expect(code).not.toMatch(/\b(updateEvent|getEvent|listEvents|listCalendars)\b/);
  });

  it('is imported only by door.ts and sync.ts', async () => {
    const allowed = new Set([
      join('src', 'meetings', 'holds.ts'),
      join('src', 'meetings', 'door.ts'),
      join('src', 'meetings', 'sync.ts'),
    ]);
    const offenders: string[] = [];
    let scanned = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        scanned += 1;
        if (allowed.has(path)) continue;
        const source = await readFile(path, 'utf8');
        const importsHolds = /(?:from|import\s*\()\s*['"][^'"]*\/holds\.js['"]/.test(source);
        if (importsHolds && /\b(createHold|releaseHold)\b/.test(source)) offenders.push(path);
      }
    };
    await walk('src');
    expect(scanned).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
