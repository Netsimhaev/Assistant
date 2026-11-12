/**
 * The per-business save folder a test needs (spec §5.8).
 *
 * `saveDocumentSettings` refuses a base folder outside
 * `<DOCUMENT_SAVE_ROOT>/<businessId>`, and `vitest.config.ts` points
 * `DOCUMENT_SAVE_ROOT` at a fixed temp path. A test that needs a base folder
 * takes it from here instead of `tmpdir()`.
 */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { businessSaveRoot } from '../tenancy/paths.js';

/** `<DOCUMENT_SAVE_ROOT>/<businessId>`, created. */
export async function businessSaveFolder(businessId: string): Promise<string> {
  const root = businessSaveRoot(businessId);
  if (root === null) throw new Error('DOCUMENT_SAVE_ROOT is not set for tests — see vitest.config.ts');
  await mkdir(root, { recursive: true });
  return root;
}

/** A fresh, unique folder inside the business's save folder. */
export async function scratchSaveFolder(businessId: string, prefix: string): Promise<string> {
  return mkdtemp(join(await businessSaveFolder(businessId), prefix));
}
