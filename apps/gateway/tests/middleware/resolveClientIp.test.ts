import { describe, it, expect } from "vitest";
import { resolveClientIp } from "../../src/middleware/resolveClientIp.js";

// Minimal FastifyRequest-shaped stub for the fields resolveClientIp reads.
function req(opts: { ip: string; peer: string; cfHeader?: string }) {
  return {
    ip: opts.ip,
    headers: opts.cfHeader ? { "cf-connecting-ip": opts.cfHeader } : {},
    raw: { socket: { remoteAddress: opts.peer } },
  } as unknown as import("fastify").FastifyRequest;
}

describe("resolveClientIp", () => {
  it("trusts CF-Connecting-IP when the socket peer is a trusted proxy", () => {
    const ip = resolveClientIp(req({ ip: "10.9.0.2", peer: "10.9.0.2", cfHeader: "203.0.113.7" }), ["10.9.0.0/24"]);
    expect(ip).toBe("203.0.113.7");
  });
  it("IGNORES CF-Connecting-IP when the socket peer is NOT trusted (spoof)", () => {
    const ip = resolveClientIp(req({ ip: "192.168.1.50", peer: "192.168.1.50", cfHeader: "203.0.113.7" }), ["10.9.0.0/24"]);
    expect(ip).toBe("192.168.1.50");
  });
  it("falls back to req.ip when trusted peer sends no CF header", () => {
    expect(resolveClientIp(req({ ip: "203.0.113.9", peer: "10.9.0.2" }), ["10.9.0.0/24"])).toBe("203.0.113.9");
  });
  it("empty trustedProxies → always req.ip (never trusts header)", () => {
    expect(resolveClientIp(req({ ip: "1.2.3.4", peer: "10.9.0.2", cfHeader: "203.0.113.7" }), [])).toBe("1.2.3.4");
  });
});
