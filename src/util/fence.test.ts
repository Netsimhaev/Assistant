import { describe, expect, it } from 'vitest';
import { buildFence, stripFenceMarkers, stripUntilStable } from './fence.js';

describe('fence util', () => {
  it('buildFence refuses an empty nonce and embeds the nonce', () => {
    expect(() => buildFence('l', '')).toThrow(/nonce must not be empty/);
    expect(buildFence('l', 'n1').open).toBe('=== l :: n1 ===');
  });
  it('stripUntilStable catches markers rebuilt by the removal', () => {
    expect(stripUntilStable('ab<m>c<m>d'.replace(/<m>/g, 'M'), 'M')).toBe('abcd');
    expect(stripUntilStable('MaMarkerrker', 'Marker')).toBe('');
  });
  it('stripFenceMarkers removes both open and close', () => {
    const f = buildFence('l', 'n1');
    expect(stripFenceMarkers(`a${f.open}b${f.close}c`, f)).toBe('abc');
  });
});
