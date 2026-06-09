import ipaddr from "ipaddr.js";
import type { FastifyRequest } from "fastify";

// CF-Connecting-IP is the single authoritative client IP that Cloudflare sets
// on the trusted hop. But the gateway also publishes :3002 directly, so a
// LAN/VPN/direct client can FORGE this header. We therefore only honour it
// when the socket peer (the actual TCP source) is one of the configured
// trusted proxies (the cloudflared peer / tunnel network). Otherwise we
// ignore the header entirely and fall back to Fastify's resolved req.ip.
export function resolveClientIp(
  req: FastifyRequest,
  trustedProxies: string[],
): string {
  if (trustedProxies.length === 0) return req.ip;
  const peer = req.raw.socket.remoteAddress ?? "";
  if (!peerIsTrusted(peer, trustedProxies)) return req.ip;
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim().length > 0) return cf.trim();
  return req.ip;
}

function peerIsTrusted(peer: string, cidrs: string[]): boolean {
  if (!peer) return false;
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.process(peer);
  } catch {
    return false;
  }
  return cidrs.some((c) => {
    try {
      const cidr = c.includes("/")
        ? c
        : `${c}/${parsed.kind() === "ipv6" ? 128 : 32}`;
      return parsed.match(ipaddr.parseCIDR(cidr));
    } catch {
      return false;
    }
  });
}
