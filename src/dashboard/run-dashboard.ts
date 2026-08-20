/**
 * The dashboard as a process, separate from the scheduler.
 *
 *   npm run dashboard
 *
 * Binds loopback only — see docs/dashboard-deployment.md. This process does
 * not terminate TLS; reaching it from the internet requires a tunnel or
 * reverse proxy in front of it that does. Getting that wrong does not fail
 * loudly: a `Secure` cookie sent over plain HTTP is silently never returned
 * by the browser, so a misdeployment just stops authenticating anyone.
 */
import type { AddressInfo } from 'node:net';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { createServer } from './server.js';

const port = Number(process.env['DASHBOARD_PORT'] ?? 4173);
const host = process.env['DASHBOARD_HOST'] ?? '127.0.0.1';

const server = createServer({ businessId: config.businessId, host, port });

server.on('listening', () => {
  const address = server.address() as AddressInfo;
  console.log(
    `dashboard listening on http://${address.address}:${address.port} for ${config.businessId}`,
  );
});

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — closing the dashboard`);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closePool();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
