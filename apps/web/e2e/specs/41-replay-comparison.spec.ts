import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resetDb, seedDb } from "../fixtures/seed-db";
import { signInWithSession } from "../fixtures/mock-oauth";
import { E2E_GATEWAY_BASE_URL } from "../fixtures/gateway-env";

/**
 * single-request-replay Task 11 — 對照頁 (apps/web/src/app/dashboard/
 * organizations/[id]/requests/[requestId]/page.tsx).
 *
 * This spec drives the REAL replay pipeline end to end rather than seeding a
 * finished run: enabling content capture AND LLM eval provisions the org eval
 * key into Redis (apps/api's contentCapture.setSettings → provisionLlmEvalKey,
 * which fires on the eval toggle specifically), which is exactly what
 * apps/gateway's replay worker reads before its loopback call.
 * A seeded `replay_runs` row would prove the page renders SOMETHING; only the
 * real pipeline proves the page renders the two bodies that actually came back
 * from two different models.
 *
 * That last sentence used to be aspiration, not fact. Step 6 asserted only that
 * the two `ResponsePanel`s were VISIBLE — and they mount unconditionally,
 * substituting `emptyText` when a side has no body — so the spec stayed green
 * for the life of the branch while the replay was failing
 * `eval_key_unavailable` before it ever reached an upstream. The assertion is
 * now on panel CONTENT (`msg_fake_e2e`, the fake upstream's canned reply id),
 * which nothing but a completed loopback can put on the page. This is the ONLY
 * automated coverage of the enqueue → worker → loopback → capture chain; every
 * other layer in the repo stubs `fetchImpl`.
 *
 * ENVIRONMENT PREREQUISITE (same as specs 20/30/40): ENABLE_EVALUATOR=true
 * must be exported for the local run — the replay router is behind
 * `evaluatorProcedure` and the gateway only wires the replay worker inside the
 * same ENABLE_EVALUATOR block. CI's e2e job sets it at the job level.
 *
 * ENABLE_GATEWAY=true, CREDENTIAL_ENCRYPTION_KEY and API_KEY_HASH_PEPPER must
 * be exported too, and that is easy to miss: playwright.config.ts puts them in
 * the GATEWAY webServer's env only, never the API's, so a bare local run leaves
 * the API with ENABLE_GATEWAY=false and step 1 dies on `accounts.create`
 * → NOT_FOUND (ensureGatewayEnabled) with nothing pointing at the cause. CI
 * does not hit this because its e2e job sets all of them job-wide, so every
 * process inherits them. Use the same values as e2e/fixtures/gateway-env.ts.
 */
test("comparison page: fidelity warning sits above the comparison, latency is never presented as comparable, and a same-model baseline can be started", async ({
  page,
  context,
}) => {
  const orgId = randomUUID();
  const adminToken = "e2e-replay-cmp-admin-" + Date.now();
  const orgSlug = "e2e-replay-comparison";

  // ── Seed: org + super_admin user ──────────────────────────────────────
  await resetDb();
  const seed = await seedDb({
    reset: false,
    orgs: [{ id: orgId, slug: orgSlug, name: "E2E Replay Comparison" }],
    users: [{ email: "admin-replay-cmp@e2e.test", sessionToken: adminToken }],
  });
  const admin = seed.users[0];
  if (!admin) throw new Error("admin not seeded");
  await seedDb({
    reset: false,
    orgMembers: [{ orgId, userId: admin.id }],
    roleAssignments: [
      { userId: admin.id, role: "super_admin", scopeType: "global" },
    ],
  });
  await signInWithSession(context, { sessionToken: adminToken });

  // ── 1. Upstream account ───────────────────────────────────────────────
  await page.goto(`/dashboard/organizations/${orgId}/accounts/new`);
  await page.getByLabel("Name").fill("e2e-replay-cmp-key");
  await page.getByLabel("Credentials").fill("sk-ant-fake-e2e-replay-cmp");
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(
    new RegExp(`^.*/dashboard/organizations/${orgId}/accounts$`),
  );

  // ── 2. Platform API key ───────────────────────────────────────────────
  await page.goto("/dashboard/profile");
  await page.getByRole("button", { name: /new key/i }).click();
  const keyDialog = page.getByRole("dialog");
  await keyDialog.getByLabel("Name").fill("e2e-replay-cmp-apikey");
  await keyDialog.getByRole("button", { name: /generate key/i }).click();
  const keyCode = keyDialog.locator("#apiKeyRaw");
  await expect(keyCode).toBeVisible();
  const rawKey = (await keyCode.textContent())?.trim();
  expect(rawKey, "reveal panel should surface the raw key").toBeTruthy();
  await keyDialog.getByRole("button", { name: /done/i }).click();

  // ── 3. Enable content capture AND LLM eval ────────────────────────────
  //
  //      Both are preconditions of replay, and for different reasons:
  //      content capture is what stores the body there is anything to replay,
  //      while `llm_eval_enabled` is the org's own switch governing the eval
  //      key replay borrows — `replay.enqueue` refuses with
  //      PRECONDITION_FAILED without it, and apps/gateway's `runReplay`
  //      refuses again with `eval_key_unavailable`. Turning eval on is also
  //      the ONLY path that provisions that key into Redis
  //      (contentCapture.setSettings → provisionLlmEvalKey), so this toggle is
  //      what makes the loopback call at step 6 possible at all.
  await page.goto(`/dashboard/organizations/${orgId}/evaluator/settings`);
  const captureToggle = page.locator(
    '[role="switch"][id="contentCaptureEnabled"]',
  );
  await expect(captureToggle).toBeVisible();
  if ((await captureToggle.getAttribute("aria-checked")) !== "true") {
    await captureToggle.click();
  }
  const llmEvalToggle = page.locator('[role="switch"][id="llmEvalEnabled"]');
  await expect(llmEvalToggle).toBeVisible();
  if ((await llmEvalToggle.getAttribute("aria-checked")) !== "true") {
    await llmEvalToggle.click();
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

  // ── 4. One real captured request to be the comparison's source ────────
  const gwRes = await page.request.post(`${E2E_GATEWAY_BASE_URL}/v1/messages`, {
    headers: {
      "x-api-key": rawKey!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    data: {
      model: "comparison-source-model",
      max_tokens: 8,
      messages: [{ role: "user", content: "which model is at fault?" }],
    },
  });
  expect(gwRes.status(), await gwRes.text()).toBe(200);

  // Body capture is asynchronous (BullMQ) — poll until the row is replayable.
  let sourceRequestId = "";
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
            hasBody: boolean;
            bodyTruncated: boolean;
          }>;
        };
      };
    }>;
    const row = body[0]?.result?.data?.rows.find(
      (r) => r.requestedModel === "comparison-source-model",
    );
    expect(row, `full body=${JSON.stringify(body)}`).toBeTruthy();
    expect(row!.hasBody).toBe(true);
    expect(row!.bodyTruncated).toBe(false);
    sourceRequestId = row!.requestId;
  }).toPass({ timeout: 20_000, intervals: [500, 1000, 2000] });

  // ── 5. Start a replay against a DIFFERENT model, the way an operator
  //      does: from the request list. This lands on the comparison page.
  //
  //      Locale is pinned only now — the boilerplate above reuses English
  //      labels from specs 10/20 (see 40-requests-list.spec.ts).
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "zh-TW", domain: "localhost", path: "/" },
  ]);

  await page.goto(`/dashboard/organizations/${orgSlug}/requests`);
  await page
    .getByRole("row", { name: /comparison-source-model/ })
    .getByRole("button", { name: "重放" })
    .click();
  const replayDialog = page.getByRole("dialog");
  await expect(replayDialog).toBeVisible();
  await replayDialog
    .getByLabel(/target model|目標模型/i)
    .fill("comparison-target-model");
  await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/trpc/replay.enqueue") &&
        res.request().method() === "POST",
    ),
    replayDialog
      .getByRole("button", { name: /^(開始重放|start replay)$/i })
      .click(),
  ]);

  await expect(page).toHaveURL(
    new RegExp(
      `^.*/dashboard/organizations/${orgId}/requests/${sourceRequestId}$`,
    ),
  );

  // ── 6. The comparison itself ──────────────────────────────────────────
  // Both panels are MOUNTED unconditionally (`ResponsePanel` substitutes
  // `emptyText` when its side has no body), so `toBeVisible()` alone proves
  // only that the page rendered — an `eval_key_unavailable` run that never
  // reached an upstream satisfies it just as well. Kept as a cheap mount check;
  // the pipeline proof is the content assertion below it.
  await expect(page.getByTestId("source-response")).toBeVisible({
    timeout: 60_000,
  });
  const replayPanel = page.getByTestId("replay-response");
  await expect(replayPanel).toBeVisible({ timeout: 60_000 });

  // THE falsifiable assertion. `msg_fake_e2e` is the id in the fake upstream's
  // canned reply (apps/web/e2e/fixtures/fake-anthropic.ts), so it can only
  // appear inside the replay panel if every link of the chain that spends money
  // actually ran: enqueue → worker claimed the run → loopback POST to the
  // gateway authenticated with the org eval key → forwarded upstream → response
  // captured, encrypted and written → the replay's own usage_logs row landed →
  // getComparison found, decrypted and rendered it.
  //
  // Nothing else in this repo covers that chain: every other layer stubs
  // `fetchImpl`. Scoped to the panel because the SOURCE response carries the
  // same canned id — a page-wide search would pass on the source alone.
  await expect(replayPanel).toContainText("msg_fake_e2e", { timeout: 60_000 });
  await expect(page.getByTestId("source-response")).toContainText(
    "msg_fake_e2e",
  );

  // The negation stated directly, so a regression fails with the symptom named
  // rather than with "some string was missing".
  await expect(replayPanel).not.toContainText("尚無重放結果可比對");

  // The caveat must sit ABOVE what it qualifies. A footnote under the
  // comparison has already failed at its job.
  const banner = page.getByTestId("fidelity-banner");
  const content = page.getByTestId("comparison-content");
  await expect(banner).toBeVisible();
  await expect(content).toBeVisible();
  const bannerBox = await banner.boundingBox();
  const contentBox = await content.boundingBox();
  expect(bannerBox, "fidelity banner should have a box").toBeTruthy();
  expect(contentBox, "comparison content should have a box").toBeTruthy();
  expect(bannerBox!.y).toBeLessThan(contentBox!.y);

  // Latency is never presented as a comparable number.
  await expect(page.getByText("延遲不可比").first()).toBeVisible();

  // The noise baseline is not optional: without a same-model rerun the reader
  // cannot tell a model-change difference from ordinary sampling variance.
  const baseline = page.getByRole("button", {
    name: "用同一模型再跑一次",
  });
  await expect(baseline).toBeEnabled();

  // And it must actually start a run against the SOURCE model.
  const [baselineRes] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/trpc/replay.enqueue") &&
        res.request().method() === "POST",
    ),
    baseline.click(),
  ]);
  expect(baselineRes.status(), await baselineRes.text()).toBe(200);
  expect(baselineRes.request().postData()).toContain("comparison-source-model");
});
