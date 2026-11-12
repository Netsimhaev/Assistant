import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The spine talks to a real Postgres. Tests share one database and clean up
    // per-file, so running files in parallel would interleave truncations.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: {
      NODE_ENV: 'test',
      // The server-wide save root (spec §5.8) for every test: a business's
      // `doc.save` base folder must sit under `<this>/<businessId>`. A temp
      // path rather than one the operator's `.env` names, so a test can never
      // save into a real owner's folder — and unique per run (this process's
      // pid plus a random suffix), so the end-of-turn hook's run and a run on
      // a dedicated database cannot share, or clean up, each other's folders.
      // `src/test/save-root.ts` makes the per-business folder a test needs.
      DOCUMENT_SAVE_ROOT: join(tmpdir(), `assistant-test-save-root-${process.pid}-${randomBytes(4).toString('hex')}`),
    },
  },
});
