/**
 * The operator panel as a process, separate from the dashboard and the
 * scheduler.
 *
 *   npm run admin
 *
 * Binds loopback only (`ADMIN_HOST`, default 127.0.0.1; anything else needs
 * `ADMIN_ALLOW_PUBLIC_BIND=1`) — like the dashboard it does not terminate TLS
 * and sets `Secure` cookies, so it must sit behind a tunnel or reverse proxy.
 *
 * Refuses to start without the master key, or with a key that does not match
 * the server's key state: every technician's second factor is sealed under
 * it, and a wrong key would read as "wrong code" for everyone.
 */
import type { AddressInfo } from 'node:net';
import { closePool } from '../db/pool.js';
import { closePlatform, verifyServerKeyState } from '../tenancy/platform.js';
import { loadMasterKey, MasterKeyError } from '../governance/master-key.js';
import { config } from '../config.js';
import { createAdminServer } from './server.js';
import { buildServerRuntime } from '../orchestrator/runtime.js';
import { runtimeOwnerNoticeSender } from './owner-notice.js';

const port = Number(process.env['ADMIN_PORT'] ?? 8788);
const host = process.env['ADMIN_HOST'] ?? '127.0.0.1';
const trustProxy = process.env['ADMIN_TRUST_PROXY'] === '1';
const allowNonLoopbackBind = process.env['ADMIN_ALLOW_PUBLIC_BIND'] === '1';
const dashboardBaseUrl = process.env['ADMIN_DASHBOARD_BASE_URL'] ?? process.env['DASHBOARD_BASE_URL'] ?? 'http://127.0.0.1:4173';

const keyPath = process.env['CREDENTIAL_KEY_PATH'];
if (keyPath === undefined || keyPath.length === 0) {
  throw new MasterKeyError('CREDENTIAL_KEY_PATH אינו מוגדר — בלי מפתח האב אי אפשר לאמת כניסה, והפאנל מסרב לעלות');
}
const masterKey = await loadMasterKey(keyPath);
await verifyServerKeyState(masterKey);
// The business notification seam, for telling an owner a technician reset his
// sign-in (final review I1). Its warnings are the scheduler's to print.
const serverRuntime = await buildServerRuntime();

const server = createAdminServer({
  masterKey,
  host,
  port,
  trustProxy,
  allowNonLoopbackBind,
  documentRoot: config.documentRoot,
  dashboardBaseUrl,
  ownerNotice: runtimeOwnerNoticeSender(serverRuntime),
});

server.on('listening', () => {
  const address = server.address() as AddressInfo;
  console.log(`http://${address.address}:${address.port}`);
});

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — closing the admin panel`);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closePool();
  await closePlatform();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
