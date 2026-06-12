# Gateway load-test harness (#206)

Correctness gate (CI; needs Docker for Testcontainers — Postgres + Redis):

    pnpm --filter @caliber/gateway test:load

Perf benchmark (report-only, manual; needs Docker):

    pnpm perf:gateway
    pnpm perf:gateway -- --connections 100 --duration 30

Output: docs/perf/<date>-gateway-load.md (env metadata for trend comparison).

Design: docs/superpowers/specs/2026-06-12-gateway-load-test-design.md
The correctness lane is serial (prom-client global registry + one long-lived gateway per scenario file).
