import { execSync } from "node:child_process";

/**
 * Vitest globalSetup that force-removes lingering testcontainers-labeled
 * containers before the integration suite starts. Stale containers from a
 * previous interrupted run (Ctrl-C, killed worker, OOM, etc.) accumulate
 * with `org.testcontainers=true` label and starve new `PostgreSqlContainer`
 * allocations — the symptom is a `Hook timed out in 60000ms` on every
 * `beforeAll(() => setupTestDb())` and 30 test files crash in sequence.
 *
 * The ryuk sidecar that testcontainers ships is supposed to handle this on
 * normal exit, but on macOS / Docker Desktop it occasionally fails to clean
 * up after non-graceful terminations. This hook is a defense-in-depth
 * cleanup that runs once per `vitest run --config vitest.integration.config.ts`.
 *
 * Scope: matches `--filter "label=org.testcontainers=true"`, which covers
 * every container testcontainers-node has ever started (postgres, ryuk,
 * redis, etc.). Production `docker-*-1` compose services are NOT labeled
 * with that label and are unaffected. If you are running a second
 * unrelated testcontainers-based test suite on the same Docker daemon in
 * parallel, this WILL kill those too — set `SKIP_TESTCONTAINER_CLEANUP=1`
 * to opt out.
 *
 * Cleanup is best-effort: if `docker` isn't on PATH or the daemon is down
 * we silently skip; the actual test setup will fail with a clearer error
 * if the daemon is genuinely unreachable.
 */
export default async function setup(): Promise<void> {
  if (process.env.SKIP_TESTCONTAINER_CLEANUP === "1") return;
  try {
    execSync(
      'docker ps -aq --filter "label=org.testcontainers=true" | xargs -r docker rm -f >/dev/null 2>&1',
      { stdio: "pipe", shell: "/bin/sh" },
    );
  } catch {
    // Best-effort — proceed even if cleanup couldn't run.
  }
}
