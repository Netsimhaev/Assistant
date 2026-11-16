/**
 * The loopback-only bind rule, shared by the two HTTP servers: the owner's
 * dashboard (`src/dashboard/server.ts`) and the operator panel
 * (`src/admin/server.ts`). Neither terminates TLS, and both set `Secure`
 * cookies, so a non-loopback bind serves the login form in the clear and
 * silently stops authenticating anyone. See docs/dashboard-deployment.md.
 */

/**
 * Hosts that are only reachable from this machine. A positive list, never
 * "anything that is not 0.0.0.0": an address this file has not heard of is
 * one nobody has reasoned about, and the safe reading of that is "not
 * loopback".
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '::1', '[::1]', '::ffff:127.0.0.1']);

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  // The whole 127.0.0.0/8 block, which is what a loopback IPv4 address is.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Which server is binding, for the refusal message: its name and the env var that overrides. */
export interface BindSubject {
  server: string;
  allowEnv: string;
}

export const DASHBOARD_BIND: BindSubject = { server: 'dashboard', allowEnv: 'DASHBOARD_ALLOW_PUBLIC_BIND' };
export const ADMIN_BIND: BindSubject = { server: 'admin panel', allowEnv: 'ADMIN_ALLOW_PUBLIC_BIND' };

/**
 * Refuse to bind anything but loopback, unless a caller explicitly says
 * otherwise — and refuse loudly.
 *
 * Bind `0.0.0.0` and the result is plaintext HTTP serving cookies a browser
 * will refuse to send back: the deployment does not break in any way that
 * says what is wrong, it just silently stops authenticating anyone, forever,
 * while also exposing the login form to the network in the clear. A
 * misconfiguration whose only symptom is "nobody can log in" is worth
 * throwing over.
 *
 * Exported so the refusal can be tested without actually opening a socket on
 * a public interface.
 */
export function assertBindableHost(host: string, allowNonLoopback: boolean, subject: BindSubject = DASHBOARD_BIND): void {
  if (isLoopbackHost(host) || allowNonLoopback) return;
  throw new Error(
    `${subject.server} refuses to bind "${host}": it does not terminate TLS and sets Secure cookies, ` +
      'so a non-loopback bind serves the login form in the clear and silently stops ' +
      'authenticating anyone. Put a tunnel or reverse proxy in front and keep the bind on ' +
      `127.0.0.1, or set ${subject.allowEnv}=1 if you really mean it.`,
  );
}
