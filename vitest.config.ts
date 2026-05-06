import { defineConfig, configDefaults } from "vitest/config";

/**
 * Repo-root vitest config — only exists to keep `vitest run` (invoked by the
 * root `pnpm test` script, which `prepublishOnly` calls before `npm publish`)
 * from globbing into local-only side trees that contain stale dist/ artifacts
 * those other branches expect.
 *
 * Notably: a developer's local `git worktree add .worktrees/<branch>` would
 * otherwise be discovered as a test source — its `dist/cli.js` may be out of
 * sync with the worktree's source, and the resulting subprocess CLI tests
 * would fail with confusing errors that don't reproduce on a clean CI checkout.
 *
 * Per-package vitest configs (e.g. packages/auth, apps/api) are unaffected;
 * they declare their own `include` patterns rooted in their own directory.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".worktrees/**"],
  },
});
