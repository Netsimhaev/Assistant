/**
 * The address guard for every external call (Stage D, Task 5).
 *
 * The question it answers is "may a socket to this address leave the
 * server?", and it answers it positively: an address is allowed only when it
 * parses as a canonical IP literal AND falls in none of the ranges below.
 * Anything that does not parse — a hostname, a shorthand like `127.1`, a
 * decimal or hex integer, a bracketed literal, a zone id — is forbidden. A
 * value we could not read is not a permissive value.
 *
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`, including the hex form `::ffff:7f00:1`)
 * and NAT64 (`64:ff9b::/96`) are judged by the IPv4 address they carry, so
 * `::ffff:127.0.0.1` cannot slip past as "an IPv6 address that isn't ::1".
 * The deprecated IPv4-compatible block `::/96` is refused outright: it is not
 * a public destination under any current routing. So are the transition and
 * special-purpose blocks that can tunnel to an arbitrary IPv4: 6to4
 * `2002::/16` (refused whole — deprecated, not judged by its embedded v4),
 * `2001::/23` (incl. Teredo), NAT64 local-use `64:ff9b:1::/48`, discard
 * `100::/64`, IPv4-translated `::ffff:0:0:0/96`, and the 6to4 relay
 * `192.88.99.0/24`.
 *
 * This module is pure. `http.ts` calls it on every address DNS returned and
 * on any IP-literal hostname, on the socket that is actually used.
 */
import { isIP } from 'node:net';

/** [network, prefix length] for every IPv4 range a call may never reach. */
const FORBIDDEN_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // deprecated 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast 255.255.255.255
  ['255.255.255.255', 32], // broadcast (already inside 240/4; named for the reader)
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    // isIP already rejected leading zeros and out-of-range octets; this is
    // a second, local check so the arithmetic never runs on a bad octet.
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function v4Forbidden(value: number): boolean {
  for (const [network, prefix] of FORBIDDEN_V4) {
    const base = v4ToInt(network);
    if (base === null) return true;
    const size = 2 ** (32 - prefix);
    if (value >= base && value < base + size) return true;
  }
  return false;
}

/** Eight 16-bit groups, or null when the text is not a plain IPv6 literal. */
function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const after = text.slice(lastColon + 1);
  if (after.includes('.')) {
    // Rewrite a dotted IPv4 tail as its two hex groups, then parse as usual.
    const v4 = v4ToInt(after);
    if (v4 === null) return null;
    const hi = Math.floor(v4 / 65536).toString(16);
    const lo = (v4 % 65536).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = parse(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = parse(halves[1] ?? '');
  if (rest === null) return null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

function embeddedV4(groups: readonly number[]): number {
  return (groups[6] ?? 0) * 65536 + (groups[7] ?? 0);
}

function v6Forbidden(g: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = g;
  const zeroPrefix96 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::ffff:0:0/96 — IPv4-mapped: judge the IPv4 part.
  if (zeroPrefix96 && g5 === 0xffff) return v4Forbidden(embeddedV4(g));
  // ::/96 — unspecified, loopback, and the deprecated IPv4-compatible block.
  if (zeroPrefix96 && g5 === 0) return true;
  // 64:ff9b::/96 — NAT64 well-known prefix: judge the embedded IPv4.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return v4Forbidden(embeddedV4(g));
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  // ::ffff:0:0:0/96 — IPv4-translated (SIIT): never a public destination here.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return true;
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // 64:ff9b:1::/48 NAT64 local-use
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard-only
  if (g0 === 0x2001 && g1 < 0x200) return true; // 2001::/23 IETF protocols, incl. Teredo 2001::/32
  if (g0 === 0x2002) return true; // 2002::/16 6to4 — deprecated; refused whole, not judged
  return false;
}

/**
 * True unless `ip` is a canonical IP literal outside every forbidden range.
 */
export function isForbiddenAddress(ip: string): boolean {
  if (typeof ip !== 'string') return true;
  const family = isIP(ip);
  if (family === 4) {
    const value = v4ToInt(ip);
    return value === null ? true : v4Forbidden(value);
  }
  if (family === 6) {
    if (ip.includes('%')) return true; // zone ids name an interface, not a host
    const groups = v6Groups(ip);
    return groups === null ? true : v6Forbidden(groups);
  }
  return true;
}
