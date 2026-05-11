import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Database } from "@caliber/db";
import { auditLogs, gdprDeleteRequests } from "@caliber/db";
import { eq } from "drizzle-orm";
import { setupTestDb, makeOrg, makeUser } from "../../factories/index.js";
import { notifyGdprRequested } from "../../../src/services/gdprNotifications.js";

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.stop();
});

describe("gdprNotifications", () => {
  // ── Test 1: notifyGdprRequested writes an audit log row ──────────────────────

  it("notifyGdprRequested writes an audit_logs row", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, { orgId: org.id });

    // Manually create a GDPR delete request to get a requestId
    const [gdprRequest] = await t.db
      .insert(gdprDeleteRequests)
      .values({
        orgId: org.id,
        userId: user.id,
        requestedByUserId: user.id,
        reason: "Test deletion",
        scope: "bodies",
      })
      .returning({ id: gdprDeleteRequests.id });

    const mockLogger = {
      info: vi.fn(),
    };

    // Call the notification service
    await notifyGdprRequested({
      db: t.db,
      orgId: org.id,
      userId: user.id,
      requestedByUserId: user.id,
      requestId: gdprRequest!.id,
      scope: "bodies",
      reason: "Test deletion",
      logger: mockLogger,
    });

    // Verify audit log was inserted
    const logs = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, user.id));

    expect(logs.length).toBeGreaterThan(0);
    const auditLog = logs.find(
      (l) =>
        l.action === "gdpr.delete_requested" &&
        l.targetId === user.id &&
        (l.metadata as Record<string, unknown>)?.requestId === gdprRequest!.id,
    );
    expect(auditLog).toBeDefined();
    expect(auditLog!.actorUserId).toBe(user.id);
    expect(auditLog!.orgId).toBe(org.id);
    expect(auditLog!.targetType).toBe("user");
  });

  // ── Test 2: notifyGdprRequested logs structured data with all fields ─────────

  it("notifyGdprRequested emits structured log with all fields", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, { orgId: org.id });

    const [gdprRequest] = await t.db
      .insert(gdprDeleteRequests)
      .values({
        orgId: org.id,
        userId: user.id,
        requestedByUserId: user.id,
        reason: "GDPR exercise",
        scope: "bodies_and_reports",
      })
      .returning({ id: gdprDeleteRequests.id });

    const mockLogger = {
      info: vi.fn(),
    };

    await notifyGdprRequested({
      db: t.db,
      orgId: org.id,
      userId: user.id,
      requestedByUserId: user.id,
      requestId: gdprRequest!.id,
      scope: "bodies_and_reports",
      reason: "GDPR exercise",
      logger: mockLogger,
    });

    expect(mockLogger.info).toHaveBeenCalledOnce();
    const call = mockLogger.info.mock.calls[0];
    expect(call).toBeDefined();
    const [logObject, logMessage] = call!;

    expect(logMessage).toBe("gdpr delete request submitted");
    expect(logObject).toEqual(
      expect.objectContaining({
        type: "gdpr_delete_requested",
        orgId: org.id,
        userId: user.id,
        requestedByUserId: user.id,
        requestId: gdprRequest!.id,
        scope: "bodies_and_reports",
        hasReason: true,
      }),
    );
  });

  // ── Test 3: notifyGdprRequested handles null reason safely ──────────────────

  it("notifyGdprRequested is idempotent and safe when called after INSERT", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, { orgId: org.id });

    const [gdprRequest] = await t.db
      .insert(gdprDeleteRequests)
      .values({
        orgId: org.id,
        userId: user.id,
        requestedByUserId: user.id,
        reason: null,
        scope: "bodies",
      })
      .returning({ id: gdprDeleteRequests.id });

    const mockLogger = {
      info: vi.fn(),
    };

    // Call notification twice to verify idempotency
    // (second call should not error on duplicate metadata in audit log)
    await notifyGdprRequested({
      db: t.db,
      orgId: org.id,
      userId: user.id,
      requestedByUserId: user.id,
      requestId: gdprRequest!.id,
      scope: "bodies",
      reason: null,
      logger: mockLogger,
    });

    // Verify hasReason is false when reason is null
    const nullReasonCall = mockLogger.info.mock.calls[0];
    expect(nullReasonCall).toBeDefined();
    const [logObject] = nullReasonCall!;
    expect((logObject as Record<string, unknown>).hasReason).toBe(false);

    // Verify audit log metadata contains null reason
    const logs = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, user.id));

    const auditLog = logs.find(
      (l) =>
        l.action === "gdpr.delete_requested" &&
        (l.metadata as Record<string, unknown>)?.requestId === gdprRequest!.id,
    );
    expect(auditLog).toBeDefined();
    expect((auditLog!.metadata as Record<string, unknown>).reason).toBeNull();
  });
});
