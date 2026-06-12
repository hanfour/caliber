# Gateway load report — 2026-06-12

## Environment

- git sha: 99d1702
- Node: v20.19.5
- OS/CPU: Darwin 25.3.0 / Apple M1 x8
- connections: 10, duration: 3s
- payload: fixed small (see scripts/perf-gateway.ts SURFACES)
- fake latencies: 0/50/200ms
- env: GATEWAY_ENABLE_MODEL_ALIAS=false, GATEWAY_CACHE_TTL_SEC=0, no idempotency header
- surfaces: messages (ungrouped→anthropic), responses + codex-responses (openai-grouped key)

## Results

| surface | upstream_ms | RPS | p50 | p95 | p99 | max | non2xx | fake_reqs | fake_errs | gw_net_p50 |
|---|---|---|---|---|---|---|---|---|---|---|
| messages | 0 | 570 | 16 | 28 | 30 | 38 | 0 | 3281 | 0 | 16 |
| messages | 50 | 137 | 71 | 88 | 93 | 95 | 0 | 846 | 0 | 21 |
| messages | 200 | 40 | 239 | 249 | 251 | 251 | 0 | 260 | 0 | 39 |
| responses | 0 | 548 | 17 | 27 | 29 | 35 | 0 | 3180 | 0 | 17 |
| responses | 50 | 137 | 71 | 91 | 93 | 95 | 0 | 837 | 0 | 21 |
| responses | 200 | 40 | 242 | 253 | 254 | 254 | 0 | 260 | 0 | 42 |
| codex-responses | 0 | 507 | 17 | 31 | 37 | 42 | 0 | 2808 | 0 | 17 |
| codex-responses | 50 | 133 | 72 | 87 | 88 | 90 | 0 | 849 | 0 | 22 |
| codex-responses | 200 | 40 | 242 | 257 | 258 | 258 | 0 | 260 | 0 | 42 |

> p95 column is autocannon's p97_5 (its nearest tracked percentile).
> Streaming first-token vs stream-complete is a documented follow-up; this matrix covers non-stream surfaces for v1.