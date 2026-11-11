import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, getMigratorPool } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await getMigratorPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const { rows } = await getMigratorPool().query<{ name: string }>(
    'SELECT name FROM schema_migrations',
  );
  return new Set(rows.map((row) => row.name));
}

export async function migrate(): Promise<string[]> {
  await ensureMigrationsTable();
  const applied = await appliedMigrations();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    // Each migration is one transaction: it applies whole or not at all.
    // On the MIGRATOR pool — the role that owns every table — never the app.
    const tx = await getMigratorPool().connect();
    try {
      await tx.query('BEGIN');
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      tx.release();
    }
    ran.push(file);
  }
  return ran;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isEntrypoint) {
  try {
    const ran = await migrate();
    console.log(
      ran.length > 0
        ? `applied ${ran.length} migration(s): ${ran.join(', ')}`
        : 'no pending migrations',
    );
  } finally {
    await closePool();
  }
}
