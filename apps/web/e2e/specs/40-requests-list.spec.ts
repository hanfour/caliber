import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resetDb, seedDb } from "../fixtures/seed-db";
import { signInWithSession } from "../fixtures/mock-oauth";
import { E2E_GATEWAY_BASE_URL } from "../fixtures/gateway-env";

/**
 * single-request-replay Task 10 — 請求清單頁 (apps/web/src/app/dashboard/
 * organizations/[id]/requests/page.tsx).
 *
 * NOTE on the brief's stated test path: task-10-brief.md says
 * `apps/web/e2e/requests-list.spec.ts`, but playwright.config.ts's
 * `testDir: "./specs"` only discovers files under `e2e/specs/`. Same class
 * of brief/convention mismatch Task 8's report flagged for its own test
 * path — placed here, numbered `40-` to sort after the existing evaluator
 * specs (20/30) and before the post-release smoke test (99).
 *
 * ENVIRONMENT PREREQUISITE: this spec (like 20-evaluator-happy.spec.ts and
 * 30-evaluator-cost-facet-ui.spec.ts) needs ENABLE_EVALUATOR=true on the api
 * process — `replay.enqueue` is wrapped in `evaluatorProcedure` and 404s
 * otherwise. CI's e2e job sets this at the job level; playwright.config.ts's
 * local `webServer` env does NOT (only ENABLE_GATEWAY is defaulted there),
 * so a local run needs `ENABLE_EVALUATOR=true` exported in the shell before
 * `pnpm --filter @caliber/web e2e` — same pre-existing requirement specs
 * 20/30 already have, not something new introduced here.
 *
 * Body capture (request_bodies) is asynchronous (BullMQ body-capture queue,
 * same shape as the usage-log write other specs already poll for), so every
 * assertion that depends on a captured body's flags polls
 * `usage.listRequests` directly via `page.request` until the expected shape
 * lands, mirroring 10-gateway-happy.spec.ts's `toPass({...})` pattern.
 */
test("requests list: renders captured requests, explains each disabled replay state up front, and the enabled path enqueues + navigates", async ({
  page,
  context,
}) => {
  const orgId = randomUUID();
  const adminToken = "e2e-requests-admin-" + Date.now();
  const orgSlug = "e2e-requests-list";

  // ── Seed: org + super_admin user ──────────────────────────────────────
  await resetDb();
  const seed = await seedDb({
    reset: false,
    orgs: [{ id: orgId, slug: orgSlug, name: "E2E Requests List" }],
    users: [{ email: "admin-requests@e2e.test", sessionToken: adminToken }],
  });
  const admin = seed.users[0];
  if (!admin) throw new Error("admin not seeded");
  await seedDb({
    reset: false,
    orgMembers: [{ orgId, userId: admin.id }],
    roleAssignments: [
      // super_admin covers content_capture.toggle, accounts.create,
      // api_key.issue_own, and (as the request's own author) request.replay.
      { userId: admin.id, role: "super_admin", scopeType: "global" },
    ],
  });
  await signInWithSession(context, { sessionToken: adminToken });

  // ── 1. Create an api_key upstream account ────────────────────────────
  await page.goto(`/dashboard/organizations/${orgId}/accounts/new`);
  await page.getByLabel("Name").fill("e2e-requests-anthropic-key");
  await page.getByLabel("Credentials").fill("sk-ant-fake-e2e-requests");
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(
    new RegExp(`^.*/dashboard/organizations/${orgId}/accounts$`),
  );

  // ── 2. Self-issue a platform API key ─────────────────────────────────
  await page.goto("/dashboard/profile");
  await page.getByRole("button", { name: /new key/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("e2e-requests-key");
  await dialog.getByRole("button", { name: /generate key/i }).click();
  const keyCode = dialog.locator("#apiKeyRaw");
  await expect(keyCode).toBeVisible();
  const rawKey = (await keyCode.textContent())?.trim();
  expect(rawKey, "reveal panel should surface the raw key").toBeTruthy();
  await dialog.getByRole("button", { name: /done/i }).click();

  // ── 3. Fixture A — "nobody" row: capture is OFF by default, so this
  //      request is logged but its body is never captured → hasBody:false.
  const gwHeaders = {
    "x-api-key": rawKey!,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  const nobodyRes = await page.request.post(
    `${E2E_GATEWAY_BASE_URL}/v1/messages`,
    {
      headers: gwHeaders,
      data: {
        model: "nobody-fixture-model",
        max_tokens: 8,
        messages: [{ role: "user", content: "no capture yet" }],
      },
    },
  );
  expect(nobodyRes.status(), await nobodyRes.text()).toBe(200);

  // ── 4. Enable content capture via the Settings UI ────────────────────
  await page.goto(`/dashboard/organizations/${orgId}/evaluator/settings`);
  const captureToggle = page.locator(
    '[role="switch"][id="contentCaptureEnabled"]',
  );
  await expect(captureToggle).toBeVisible();
  if ((await captureToggle.getAttribute("aria-checked")) !== "true") {
    await captureToggle.click();
  }
  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/trpc/contentCapture.setSettings") &&
        res.request().method() === "POST",
      { timeout: 15000 },
    ),
    page.getByRole("button", { name: /save settings/i }).click(),
  ]);

  // ── 5. Fixture B — "normal" row: small message, capture ON, not
  //      truncated → hasBody:true, bodyTruncated:false, enabled button.
  const normalRes = await page.request.post(
    `${E2E_GATEWAY_BASE_URL}/v1/messages`,
    {
      headers: gwHeaders,
      data: {
        model: "normal-fixture-model",
        max_tokens: 8,
        messages: [{ role: "user", content: "a normal, small request" }],
      },
    },
  );
  expect(normalRes.status(), await normalRes.text()).toBe(200);

  // ── 6. Fixture C — "truncated" row: an oversized message pushes the
  //      captured request+response past the 256KB overall cap
  //      (apps/gateway/src/capture/truncate.ts OVERALL_CAP), forcing
  //      bodyTruncated:true. Fake-anthropic's response is a small fixed
  //      canned payload regardless of input, so the requestBody alone must
  //      carry the whole overage.
  const oversized = "x".repeat(300_000);
  const truncatedRes = await page.request.post(
    `${E2E_GATEWAY_BASE_URL}/v1/messages`,
    {
      headers: gwHeaders,
      data: {
        model: "truncated-fixture-model",
        max_tokens: 8,
        messages: [{ role: "user", content: oversized }],
      },
    },
  );
  expect(truncatedRes.status(), await truncatedRes.text()).toBe(200);

  // ── 7. Poll usage.listRequests until all three rows have landed with
  //      the expected flags — body capture is async (BullMQ worker).
  let requestIds: {
    nobody?: string;
    normal?: string;
    truncated?: string;
  } = {};
  await expect(async () => {
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const input = encodeURIComponent(
      JSON.stringify({ "0": { orgId, userId: admin.id, from, to, limit: 50 } }),
    );
    const res = await page.request.get(
      `/trpc/usage.listRequests?batch=1&input=${input}`,
    );
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as Array<{
      result?: {
        data?: {
          rows: Array<{
            requestId: string;
            requestedModel: string;
            bodyTruncated: boolean;
            hasBody: boolean;
          }>;
          replayEnabled: boolean;
        };
      };
    }>;
    const data = body[0]?.result?.data;
    expect(data, `full body=${JSON.stringify(body)}`).toBeTruthy();
    expect(data!.replayEnabled).toBe(true);

    const nobody = data!.rows.find(
      (r) => r.requestedModel === "nobody-fixture-model",
    );
    const normal = data!.rows.find(
      (r) => r.requestedModel === "normal-fixture-model",
    );
    const truncated = data!.rows.find(
      (r) => r.requestedModel === "truncated-fixture-model",
    );
    expect(nobody, "nobody row not landed yet").toBeTruthy();
    expect(normal, "normal row not landed yet").toBeTruthy();
    expect(truncated, "truncated row not landed yet").toBeTruthy();
    expect(nobody!.hasBody).toBe(false);
    expect(normal!.hasBody).toBe(true);
    expect(normal!.bodyTruncated).toBe(false);
    expect(truncated!.hasBody).toBe(true);
    expect(truncated!.bodyTruncated).toBe(true);

    requestIds = {
      nobody: nobody!.requestId,
      normal: normal!.requestId,
      truncated: truncated!.requestId,
    };
  }).toPass({ timeout: 20_000, intervals: [500, 1000, 2000] });

  // ── 8. Load the requests page and assert the table itself ────────────
  //
  // This page's copy is Traditional Chinese (matching the deployment this
  // feature targets — see task-10-report.md). DEFAULT_LOCALE is "en", so
  // pin the locale cookie next-intl reads (packages/i18n-validation's
  // LOCALE_COOKIE="NEXT_LOCALE") to make the assertions below deterministic
  // regardless of what a developer's browser/CI runner would otherwise
  // negotiate via Accept-Language. Set only NOW, after the boilerplate
  // account/key/capture-toggle steps above — those reuse label text from
  // specs 10/20, which (like most of this app's existing UI) assume the
  // English default; flipping locale earlier would break THOSE lookups.
  await context.addCookies([
    {
      name: "NEXT_LOCALE",
      value: "zh-TW",
      domain: "localhost",
      path: "/",
    },
  ]);

  await page.goto(`/dashboard/organizations/${orgSlug}/requests`);
  await expect(page.getByRole("row")).not.toHaveCount(0);

  const truncatedRow = page.getByRole("row", { name: /truncated-fixture/ });
  await expect(truncatedRow.getByRole("button", { name: "重放" })).toBeDisabled();
  await expect(truncatedRow).toContainText("已截斷");

  const nobodyRow = page.getByRole("row", { name: /nobody-fixture/ });
  await expect(nobodyRow.getByRole("button", { name: "重放" })).toBeDisabled();
  await expect(nobodyRow).toContainText("已超過保存期限");

  const normalRow = page.getByRole("row", { name: /normal-fixture/ });
  const normalReplayButton = normalRow.getByRole("button", { name: "重放" });
  await expect(normalReplayButton).toBeEnabled();

  // ── 9. Replay cost break-out is rendered on the usage page (Task 10
  //      requirement: replayCostUsd must be surfaced somewhere a reader
  //      comparing costs would see it — this is that surface).
  await page.goto(`/dashboard/organizations/${orgId}/usage`);
  await expect(page.getByText("重放費用", { exact: true })).toBeVisible();

  // ── 10. Happy path: enabled row → dialog → enqueue → navigate ────────
  await page.goto(`/dashboard/organizations/${orgSlug}/requests`);
  await page
    .getByRole("row", { name: /normal-fixture/ })
    .getByRole("button", { name: "重放" })
    .click();

  const replayDialog = page.getByRole("dialog");
  await expect(replayDialog).toBeVisible();
  await replayDialog
    .getByLabel(/target model|目標模型/i)
    .fill("replay-target-fixture-model");

  const [enqueueRes] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/trpc/replay.enqueue") &&
        res.request().method() === "POST",
    ),
    replayDialog.getByRole("button", { name: /^(開始重放|start replay)$/i }).click(),
  ]);
  expect(enqueueRes.status(), await enqueueRes.text()).toBe(200);
  const enqueueBody = (await enqueueRes.json()) as Array<{
    result?: { data?: { runId?: string } };
  }>;
  expect(enqueueBody[0]?.result?.data?.runId).toBeTruthy();

  // The org layout canonicalizes /organizations/<slug>/... to
  // /organizations/<uuid>/... via a redirect effect shortly after the org
  // resolves (apps/web/src/app/dashboard/organizations/[id]/layout.tsx), so
  // by the time this page navigates on a successful enqueue, the `[id]`
  // route param it read is already the canonical orgId — not the slug this
  // test's own `page.goto` used above.
  await expect(page).toHaveURL(
    new RegExp(
      `^.*/dashboard/organizations/${orgId}/requests/${requestIds.normal}$`,
    ),
  );
});
