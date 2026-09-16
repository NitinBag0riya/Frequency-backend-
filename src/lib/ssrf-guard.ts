/**
 * ssrf-guard.ts — block Server-Side Request Forgery on outbound fetches whose
 * URL is tenant-authored (workflow `http_request` nodes and queued webhook
 * outbound jobs).
 *
 * The engine lets a tenant supply an arbitrary URL, headers and body and reads
 * the response back into a workflow variable. Without a guard that is a full
 * read-SSRF primitive against internal services and the cloud metadata endpoint.
 *
 * `assertPublicUrl` enforces:
 *   - scheme is http or https only (no file:, gopher:, data:, etc.);
 *   - the host is not a private / loopback / link-local / unique-local address,
 *     literal or DNS-resolved (all resolved addresses must be public);
 *   - the cloud metadata address (169.254.169.254) and common internal names are
 *     rejected explicitly.
 *
 * An optional allowlist (SSRF_ALLOWED_HOSTS, comma-separated hostnames) lets an
 * operator permit specific legitimate internal integrations.
 */
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

function envAllowlist(): Set<string> {
  const raw = process.env.SSRF_ALLOWED_HOSTS ?? "";
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True for IPv4/IPv6 literals in private, loopback, link-local or ULA ranges. */
export function isPrivateAddress(addr: string): boolean {
  const ip = addr.toLowerCase();
  // IPv6
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fe80:")) return true; // link-local
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // unique-local fc00::/7
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — evaluate the embedded v4
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = mapped ? mapped[1] : ip;
  if (isIP(v4) === 4) {
    const p = v4.split(".").map(Number);
    if (p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local incl. metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // multicast / reserved
  }
  return false;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

/**
 * Throws if `rawUrl` is not a safe public http(s) destination. On success the
 * caller may fetch it. Resolves DNS to catch hostnames that point at private
 * space; an operator allowlist (SSRF_ALLOWED_HOSTS) bypasses the checks for
 * named hosts only.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`ssrf-guard: invalid URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`ssrf-guard: blocked scheme ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const allow = envAllowlist();
  if (allow.has(host)) return;

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error(`ssrf-guard: blocked internal host`);
  }

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`ssrf-guard: blocked private address`);
    return;
  }

  // Hostname: resolve and require every address to be public (defends against
  // DNS entries that point at internal space; not a full rebinding defense).
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`ssrf-guard: DNS resolution failed`);
  }
  if (!addrs.length) throw new Error(`ssrf-guard: no addresses`);
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) throw new Error(`ssrf-guard: host resolves to private address`);
  }
}
