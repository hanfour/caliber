import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resetDb, seedDb } from "../fixtures/seed-db";
import { signInWithSession } from "../fixtures/mock-oauth";

test("org_admin can create, rename, and delete a team through the UI", async ({
  context,
  page,
}) => {
  const orgId = randomUUID();
  const adminToken = "e2e-team-admin-" + Date.now();
  await resetDb();
  const seed = await seedDb({
    reset: false,
    orgs: [{ id: orgId, slug: "e2e-team", name: "E2E Team Org" }],
    users: [{ email: "admin-team@e2e.test", sessionToken: adminToken }],
  });
  const admin = seed.users[0];
  if (!admin) throw new Error("admin not seeded");
  await seedDb({
    reset: false,
    orgMembers: [{ orgId, userId: admin.id }],
    roleAssignments: [
      {
        userId: admin.id,
        role: "org_admin",
        scopeType: "organization",
        scopeId: orgId,
      },
    ],
  });
  await signInWithSession(context, { sessionToken: adminToken });

  await page.goto(`/dashboard/organizations/${orgId}/teams`);

  const teamName = "QA Squad " + Date.now();
  await page.getByRole("button", { name: /new team/i }).click();
  await page.getByLabel(/name/i).fill(teamName);
  await page.getByLabel(/slug/i).fill("qa-" + Date.now());
  await page.getByRole("button", { name: /^create$|^save$/i }).click();

  const teamRow = page.locator("tbody tr", { hasText: teamName }).first();
  await expect(teamRow).toBeVisible();

  // Rename — open the team row, edit, save.
  await teamRow.getByRole("link", { name: /open/i }).click();
  const renamed = teamName + " v2";
  await page.getByRole("button", { name: /edit team|rename/i }).click();
  await page.getByLabel(/name/i).fill(renamed);
  await page.getByRole("button", { name: /save|update/i }).click();
  await expect(page.getByRole("heading", { name: renamed })).toBeVisible();

  // Delete — confirm via the in-app confirm dialog (replaces the old native
  // window.confirm; see #199).
  await page.getByRole("button", { name: /delete team|remove/i }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^(confirm|delete|確認|確定)/i })
    .click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/organizations/${orgId}/teams`));
  await expect(page.locator("tbody tr", { hasText: renamed })).toHaveCount(0);
});
