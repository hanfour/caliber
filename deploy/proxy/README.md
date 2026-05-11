# Reverse-proxy configs for Caliber

Two example configs that put TLS in front of the gateway + web
services. Pick whichever you already operate.

| File | When to use |
|---|---|
| `Caddyfile.example` | New deployments — Caddy auto-provisions Let's Encrypt certs from DNS, zero TLS boilerplate |
| `nginx.example.conf` | Existing nginx infrastructure or stricter org policy on TLS / module configuration |

Both configs assume the docker-compose stack is running with default
service names (`caliber-web`, `caliber-gateway`); for managed deploys
(Render / Fly / Railway) the platform handles ingress for you and
these configs aren't relevant.

## Hostname pattern

The configs assume two public origins:

- `caliber.example.com` → web (admin UI). NextAuth callback hosts must
  match this.
- `gateway.example.com` → gateway (`/v1/*` customer-facing endpoints).
  This is what end-user SDKs hit.

The `api` service stays on the internal Docker network — neither
config exposes it. The web container reverse-proxies `/trpc` and
`/api/v1` to api over the compose network.

## Critical settings the configs handle

### SSE streaming (gateway only)

`/v1/messages stream:true` and `/v1/chat/completions stream:true`
emit Server-Sent Events. Without explicit buffering disabled,
proxy-side accumulation breaks the streaming UX:

- **Caddy**: `flush_interval -1` in the gateway's `reverse_proxy` block.
- **nginx**: `proxy_buffering off; proxy_cache off; chunked_transfer_encoding on;` in the gateway's `location /` block.

Both configs set this. Don't remove it without testing streaming
end-to-end.

### Long timeouts

Streaming responses can run 60-300s for a chatty conversation.
Caddy: `idle 10m`. nginx: `proxy_read_timeout 300s`. Tune up if
your customers send long-context prompts; tune down if you want
to shed slow responses sooner.

### Body size

Customer SDKs send large request bodies (system prompt + tool
definitions can run 100s of KB). Default 10 MiB matches
`GATEWAY_MAX_BODY_BYTES`; raise both in lockstep if you've raised
the gateway env, or your reverse proxy will reject before the
gateway sees the request.

### Trusted proxies

When you add a reverse proxy, set `GATEWAY_TRUSTED_PROXIES` on the
gateway to the proxy's CIDR (e.g. `10.0.0.0/8` for compose's default
network) so `req.ip` resolves to the actual client instead of the
proxy address. Without this, IP allowlist on api keys won't work
against real client IPs.

## Setup walkthrough — Caddy (recommended for new deployments)

1. Install Caddy on the host (or use the official Docker image):
   ```sh
   # Debian/Ubuntu host
   apt install caddy
   # OR docker
   docker run -d --name caddy -p 80:80 -p 443:443 \
     -v $(pwd)/Caddyfile:/etc/caddy/Caddyfile \
     -v caddy_data:/data \
     caddy
   ```
2. Copy `Caddyfile.example` to `/etc/caddy/Caddyfile` (or wherever
   Caddy reads its config), edit the two hostnames.
3. DNS A/AAAA records for both hostnames must point at the Caddy
   host before reload — Caddy ACME challenge needs reachability.
4. Reload: `caddy reload`.

Caddy auto-renews certs every 30 days; nothing else to do.

## Setup walkthrough — nginx

1. Provision certs first (certbot example):
   ```sh
   certbot certonly --standalone -d caliber.example.com -d gateway.example.com
   ```
2. Drop `nginx.example.conf` into `/etc/nginx/sites-available/caliber`,
   edit hostnames + cert paths.
3. `ln -s /etc/nginx/sites-available/caliber /etc/nginx/sites-enabled/caliber`.
4. `nginx -t && systemctl reload nginx`.
5. Cert renewal is on you — set up the certbot timer if you haven't
   already.

## Verifying

After reload:

```sh
# TLS cert + HTTP/2
curl -fsSI https://caliber.example.com/api/health
curl -fsSI https://gateway.example.com/health

# Streaming end-to-end (see chunks arrive immediately, not in bursts)
curl -N https://gateway.example.com/v1/messages \
  -H "Authorization: Bearer ak_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","stream":true,"max_tokens":256,"messages":[{"role":"user","content":"count to 10 slowly"}]}'

# IP forwarding (gateway logs should show the real client IP, not 172.x)
docker compose --profile gateway logs gateway | grep '"reqId"' | tail -5
```

## Notes

- **Cloudflare proxy**: if you put Cloudflare in front of Caddy/nginx,
  set `proxy_set_header X-Real-IP $http_cf_connecting_ip;` (nginx) or
  configure trusted_proxies for Cloudflare's CIDR ranges. Otherwise
  IP allowlists don't work against the real client.
- **Cert pinning by clients**: customer SDKs typically don't pin certs
  but if any do, certificate rotation needs a coordinated rollout.
  Caddy's auto-rotation may catch you off guard here — if you have
  pinning customers, switch to manual cert management.
