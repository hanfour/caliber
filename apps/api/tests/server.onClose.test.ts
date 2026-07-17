import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression pin for server.ts:205-232's consolidated onClose hook (task-14
// fix wave of PR1, #270 item ⑧-b). Before the fix, each of the evaluator /
// github-sync / github-delivery blocks only quit the shared `bullmqRedis`
// connection when it believed it "owned" it — with both ENABLE_EVALUATOR and
// ENABLE_GITHUB_DELIVERY on, neither block actually quit, leaking the
// connection past shutdown. The fix consolidates teardown into ONE hook that
// always closes every live queue before quitting the shared connection
// exactly once. These tests pin: (1) the bullmq connection is reused (one
// `ioredis` construction) across however many of the two flags are on, (2)
// `quit()` fires exactly once regardless of flag combination, and (3) every
// live queue's `close()` resolves before `quit()` is called.
// vi.mock factories are hoisted above every top-level statement in this
// file, so the mocks they reference must be created inside vi.hoisted() —
// a plain `const quit = vi.fn()` above the vi.mock calls would still throw
// "Cannot access before initialization" once hoisting reorders things.
const { quit, evaluatorClose, syncClose, deliveryClose, redisCtor } =
  vi.hoisted(() => {
    const quit = vi.fn().mockResolvedValue("OK");
    const evaluatorClose = vi.fn().mockResolvedValue(undefined);
    const syncClose = vi.fn().mockResolvedValue(undefined);
    const deliveryClose = vi.fn().mockResolvedValue(undefined);
    // server.ts calls `new Redis(url, opts)`, so the mock must be
    // constructible — an arrow function has no [[Construct]] and `new`ing it
    // throws "is not a constructor".
    const redisCtor = vi.fn(function RedisMock() {
      return { quit, on: vi.fn() };
    });
    return { quit, evaluatorClose, syncClose, deliveryClose, redisCtor };
  });

vi.mock("ioredis", () => ({ Redis: redisCtor, default: redisCtor }));
vi.mock("@caliber/queue", async (orig) => ({
  ...(await orig<typeof import("@caliber/queue")>()),
  createEvaluatorQueue: vi.fn(() => ({ close: evaluatorClose })),
  createGithubSyncQueue: vi.fn(() => ({ close: syncClose })),
  createGithubDeliveryQueue: vi.fn(() => ({ close: deliveryClose })),
}));

// server.ts exports an async `buildServer()` that self-configures entirely
// from process.env (unlike apps/gateway's buildServer, which takes an
// injected {env,db,redis}). We drive it by stubbing process.env per case and
// letting the real boot path run: `ioredis` and `@caliber/queue` are mocked
// above so no network I/O happens, and authPlugin's `createDb()` opens a lazy
// pg.Pool that never actually connects because no query runs before
// `app.close()`. This is the first server-level (not route-in-isolation)
// test for apps/api — health.test.ts builds a bare Fastify and registers
// routes standalone; here we exercise the real buildServer() wiring.
import { buildServer } from "../src/server.js";

const BASE_ENV: Record<string, string> = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  AUTH_SECRET: "a".repeat(32),
  NEXTAUTH_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "g-id",
  GOOGLE_CLIENT_SECRET: "g-secret",
  BOOTSTRAP_SUPER_ADMIN_EMAIL: "admin@example.com",
  BOOTSTRAP_DEFAULT_ORG_SLUG: "demo",
  BOOTSTRAP_DEFAULT_ORG_NAME: "Demo Org",
  // Gateway namespace stays off so the ONLY `ioredis` construction under
  // test is the shared bullmq connection — a gateway-enabled redis would add
  // an unrelated second `redisCtor` call and muddy the "reused once" count.
  ENABLE_GATEWAY: "false",
  REDIS_URL: "redis://localhost:6379",
};

function stubEnv(overrides: Record<string, string>) {
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("server.ts onClose: quit-exactly-once shared bullmq connection", () => {
  it("evaluator-only: one redis connection, evaluator queue closes before the single quit", async () => {
    stubEnv({ ENABLE_EVALUATOR: "true", ENABLE_GITHUB_DELIVERY: "false" });
    const app = await buildServer();
    await app.close();

    expect(redisCtor).toHaveBeenCalledTimes(1);
    expect(evaluatorClose).toHaveBeenCalledTimes(1);
    expect(syncClose).not.toHaveBeenCalled();
    expect(deliveryClose).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(evaluatorClose.mock.invocationCallOrder[0]).toBeLessThan(
      quit.mock.invocationCallOrder[0]!,
    );
  });

  it("delivery-only: one redis connection, sync+delivery queues close before the single quit", async () => {
    stubEnv({ ENABLE_EVALUATOR: "false", ENABLE_GITHUB_DELIVERY: "true" });
    const app = await buildServer();
    await app.close();

    expect(redisCtor).toHaveBeenCalledTimes(1);
    expect(evaluatorClose).not.toHaveBeenCalled();
    expect(syncClose).toHaveBeenCalledTimes(1);
    expect(deliveryClose).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(syncClose.mock.invocationCallOrder[0]).toBeLessThan(
      quit.mock.invocationCallOrder[0]!,
    );
    expect(deliveryClose.mock.invocationCallOrder[0]).toBeLessThan(
      quit.mock.invocationCallOrder[0]!,
    );
  });

  it("both flags on: the bullmq connection is reused (one redisCtor call), all three queues close before the single quit", async () => {
    stubEnv({ ENABLE_EVALUATOR: "true", ENABLE_GITHUB_DELIVERY: "true" });
    const app = await buildServer();
    await app.close();

    expect(redisCtor).toHaveBeenCalledTimes(1);
    expect(evaluatorClose).toHaveBeenCalledTimes(1);
    expect(syncClose).toHaveBeenCalledTimes(1);
    expect(deliveryClose).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(evaluatorClose.mock.invocationCallOrder[0]).toBeLessThan(
      quit.mock.invocationCallOrder[0]!,
    );
    expect(syncClose.mock.invocationCallOrder[0]).toBeLessThan(
      quit.mock.invocationCallOrder[0]!,
    );
    expect(deliveryClose.mock.invocationCallOrder[0]).toBeLessThan(
      quit.mock.invocationCallOrder[0]!,
    );
  });
});
