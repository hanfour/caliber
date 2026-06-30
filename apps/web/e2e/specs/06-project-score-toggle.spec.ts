import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resetDb, seedDb } from "../fixtures/seed-db";
import { signInWithSession } from "../fixtures/mock-oauth";

/**
 * Per-project scoring (PR6 web layer) — "Score as project" toggle E2E spec.
 *
 * Locks the member-facing toggle on the profile API-keys list: a member can
 * opt one of their own keys into project scoring and the choice persists
 * (`apiKeys.setEvaluateAsProject` → `apiKeys.listOwn`).
 *
 * Coverage:
 *   1. A freshly created key shows the "Score as project" toggle, unchecked.
 *   2. Clicking the toggle persists: after a reload the toggle stays checked.
 *
 * NOT covered here (deferred — needs evaluator cron data that isn't produced
 * in the E2E environment): the downstream per-project score *rendering* on
 * /dashboard/profile/evaluation (the ProjectScoreSection report). That path
 * is exercised by the component test `ProjectScoreSection.test.tsx` and the
 * by-key tRPC integration tests. This spec validates only the opt-in toggle
 * and its persistence, which is the high-value UI regression catch.
 */
test("member can toggle 'Score as project' on an own key and it persists", async ({
  page,
  context,
}) => {
  const orgId = randomUUID();
  const memberToken = "e2e-project-score-" + Date.now();

  // ── Seed: org + member user with org membership and a member role ─────────
  await resetDb();
  const seed = await seedDb({
    reset: false,
    orgs: [{ id: orgId, slug: "e2e-project-score", name: "E2E Project Score" }],
    users: [{ email: "member-ps@e2e.test", sessionToken: memberToken }],
  });
  const member = seed.users[0];
  if (!member) throw new Error("member not seeded");

  await seedDb({
    reset: false,
    orgMembers: [{ orgId, userId: member.id }],
    roleAssignments: [
      { userId: member.id, role: "member", scopeType: "organization", scopeId: orgId },
    ],
  });

  await signInWithSession(context, { sessionToken: memberToken });

  // ── Create an API key via the profile page dialog ────────────────────────
  await page.goto("/dashboard/profile");

  await page.getByRole("button", { name: "New key" }).click();
  await page.getByLabel("Name").fill("e2e-project-key");
  await page.getByRole("button", { name: "Generate key" }).click();

  // Close the one-time reveal panel.
  await page.getByRole("button", { name: "Done" }).click();

  // ── 1. The new key row shows the toggle, unchecked ───────────────────────
  const toggle = page.getByRole("checkbox", {
    name: 'Toggle project scoring for "e2e-project-key"',
  });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();

  // ── 2. Toggle on, then verify it persists across a reload ────────────────
  await toggle.check();
  await expect(toggle).toBeChecked();

  await page.reload();

  const toggleAfter = page.getByRole("checkbox", {
    name: 'Toggle project scoring for "e2e-project-key"',
  });
  await expect(toggleAfter).toBeChecked();
});
