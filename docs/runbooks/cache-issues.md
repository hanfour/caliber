# GatewayResponseCacheIssues

## Severity

info (low hit rate) | warning (stale-response complaints) | critical (cross-tenant leak suspected)

## Symptoms

- Org admin reports identical request returning identical response (working
  as designed if cache is on; only "issue" if they expected fresh).
- `x-cache: hit` header on calls that the user thinks should be fresh.
- Cache hit rate suspiciously low or high (no metric today; eyeball the
  header on a sample).
- Suspected privacy concern: user A's cached response served to user B
  (this MUST NEVER happen — see §Cross-tenant suspected below).

## Likely causes

1. **TTL too long for the use case** — model output stale relative to a
   data feed the prompt referenced.
2. **Cache filling Redis** — large bodies × many distinct requests OOM Redis
   for shared workloads.
3. **Operator forgot it's enabled** — `GATEWAY_CACHE_TTL_SEC > 0` and
   nobody told the customer about hit semantics.
4. **Bug — cache key collision** (would require SHA-256 collision +
   identical orgId; effectively impossible).
5. **Bug — orgId in key wasn't set** (would explain cross-tenant — but
   `req.gwOrg.id` is required by apiKeyAuth, so unreachable. Verify
   anyway if reported.)

## Diagnosis commands

```bash
# Cache TTL config the gateway booted with.
docker compose exec gateway sh -c 'echo "Cache TTL: $GATEWAY_CACHE_TTL_SEC"'

# Sample the cache: count keys + average TTL remaining.
docker compose exec redis redis-cli --scan --pattern 'aide:gw:respcache:*' | wc -l
docker compose exec redis redis-cli --scan --pattern 'aide:gw:respcache:*' \
  | head -5 \
  | xargs -I {} sh -c 'echo "{}: $(docker compose exec redis redis-cli ttl {})"'

# Sample a single payload (READ-ONLY — payload is base64'd model output,
# do NOT share outside ops).
docker compose exec redis redis-cli get 'aide:gw:respcache:<sha256>'

# Spot-check live traffic — pick a customer and watch their headers.
# (no metric today; this is the lowest-friction sample method.)
docker compose --profile gateway logs gateway --tail 200 \
  | grep -E 'x-cache|response sent'

# Redis memory pressure.
docker compose exec redis redis-cli info memory \
  | grep -E 'used_memory_human|maxmemory_human|evicted_keys'
```

## Resolution steps

### Stale-response complaints
1. Confirm with the user that they actually see a `x-cache: hit` header
   on the offending call. If they don't, this isn't a cache issue.
2. Decide: tighten the TTL globally (next subsection) or turn cache off
   for them entirely (set `GATEWAY_CACHE_TTL_SEC=0` and restart — affects
   ALL orgs). Per-org / per-group opt-in is a follow-up not yet shipped.
3. Manually invalidate a specific key if you can compute it (rarely
   useful — easier to just wait for TTL):
   ```sh
   docker compose exec redis redis-cli del 'aide:gw:respcache:<sha256>'
   ```

### Tighten the TTL
```sh
sed -i '' 's/^GATEWAY_CACHE_TTL_SEC=.*/GATEWAY_CACHE_TTL_SEC=60/' docker/.env
docker compose --profile gateway up -d gateway
# New writes use new TTL; existing keys age out at their original TTL.
```

### Redis filling up
1. Check `evicted_keys` from the diagnosis output.
2. Lower `GATEWAY_CACHE_TTL_SEC` to shrink working set.
3. Consider `MAX_CACHEABLE_BODY_BYTES` (compile-time constant in
   `responseCache.ts`, currently 64 KiB) — could be tightened in code.
4. Sustained Redis OOM → upgrade Redis instance / add maxmemory-policy
   `allkeys-lru` so cache entries are evicted before slot/idempotency
   state.

### Disabling cache temporarily
```sh
sed -i '' 's/^GATEWAY_CACHE_TTL_SEC=.*/GATEWAY_CACHE_TTL_SEC=0/' docker/.env
docker compose --profile gateway up -d gateway
```
Live cache entries are still readable until TTL expiry but no new
writes happen, and the route handlers' read-path early-exits.

### Cross-tenant suspected (CRITICAL)

If a user reports seeing another org's response:

1. **Pause cache immediately** — set `GATEWAY_CACHE_TTL_SEC=0`, restart.
2. **Capture evidence** — `docker compose --profile gateway logs gateway`
   tail; the offending response body if it's still in Redis.
3. **Verify the report** — get the request's `req_id` from the
   complaining user, look up matching `usage_logs` row, get the
   `org_id` it was actually served by. If org_id matches the user's
   org, the concern is misreading the response, not a leak.
4. **If actually cross-tenant** — escalate immediately, treat as a
   security incident. `computeCacheKey` includes `orgId` so this
   shouldn't be possible without code corruption — but if it
   happened, do not re-enable cache until root-caused.

## Escalation

- Stale-response complaints from paying customers → CS within 1 business hour.
- Suspected cross-tenant cache leak → security oncall **immediately**, do not investigate further before paging.
- Redis OOM-killing keys → infra oncall (memory/instance sizing).

## Related

- `apps/gateway/src/runtime/responseCache.ts` — cache helper, key shape, TTL handling
- `apps/gateway/src/routes/{messages,chatCompletions,responses}.ts` — integration points
- `docs/GATEWAY.md#2-configuration` — `GATEWAY_CACHE_TTL_SEC` reference
