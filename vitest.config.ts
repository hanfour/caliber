import { defineConfig, configDefaults } from "vitest/config";

/**
 * Repo-root vitest config — scopes `vitest run` (invoked by the root
 * `pnpm test` script, which `prepublishOnly` calls before `npm publish`)
 * to the CLI tool's own tests only.
 *
 * Without an explicit `include`, root-level `vitest run` discovers EVERY
 * `*.test.ts` in the workspace — packages/, apps/, and any local
 * `.worktrees/`. That breaks `npm publish` in two ways even on a clean
 * tree:
 *
 *  1. Per-package configs (JSX setup for apps/web, testcontainer hook
 *     timeout overrides for packages/auth, etc.) are NOT applied when
 *     vitest runs from root — those tests fail with parse errors or
 *     `Hook timed out in 10000ms` from default settings.
 *  2. Spawning ~30 testcontainer postgres instances in parallel chokes
 *     Docker; even files that should pass time out.
 *
 * The CLI npm package only ships `dist/`, `templates/`, and `README.md`
 * — its correctness is gated on its own subprocess tests under
 * `tests/`. Per-package tests run separately via `pnpm turbo run test`
 * with each package's own config (which is what CI already does).
 *
 * `.worktrees/**` stays in the exclude as a defence-in-depth: if the
 * include glob is ever loosened, a developer's `git worktree add` still
 * won't pollute the CLI publish gate.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ".worktrees/**"],
  },
});
