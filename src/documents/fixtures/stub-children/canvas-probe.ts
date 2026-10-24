/**
 * Test-only stub child for `run-extractor.test.ts`. Installs the real
 * child's native-canvas block (`child-hardening.ts`), then asks `require`
 * for `@napi-rs/canvas` the way pdf.js does, and reports whether it was
 * refused.
 *
 * Never wired into `extract-child.ts` — see `hang.ts` in this directory for
 * why a stub like this stays test-only.
 */
import { createRequire } from 'node:module';
import { blockNativeCanvas } from '../../child-hardening.js';

blockNativeCanvas();
let refused = false;
try {
  createRequire(import.meta.url)('@napi-rs/canvas');
} catch {
  refused = true;
}
const content = { refused };
process.stdout.write(
  JSON.stringify({ artifacts: [{ ordinal: 0, kind: 'text', partName: null, content, flags: [] }] }),
);
