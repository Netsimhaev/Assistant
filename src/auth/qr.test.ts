import { expect, it } from 'vitest';
import { qrSvg } from './qr.js';

it('renders an svg without scripts', async () => {
  const s = await qrSvg('x');
  expect(s.startsWith('<svg')).toBe(true);
  expect(s).not.toContain('<script');
});
