import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type pg from "pg";
import { ignorePoolTeardownErrors } from "./db.js";

// Guards the fix for the intermittent integration-suite teardown flake:
// node-postgres re-emits an idle client's connection error on the Pool, and a
// stopped testcontainer makes that a FATAL 57P01 ("terminating connection due
// to administrator command"). An EventEmitter 'error' with no listener is
// thrown by Node as an uncaught exception, which Vitest counts as a failed run
// even when every test passed. ignorePoolTeardownErrors must attach a listener.
describe("ignorePoolTeardownErrors", () => {
  it("documents the hazard: a bare EventEmitter 'error' with no listener throws", () => {
    const bare = new EventEmitter();
    expect(() =>
      bare.emit(
        "error",
        new Error("terminating connection due to administrator command"),
      ),
    ).toThrow(/terminating connection/);
  });

  it("swallows async pool 'error' events so teardown 57P01s aren't uncaught", () => {
    const pool = new EventEmitter() as unknown as pg.Pool;
    ignorePoolTeardownErrors(pool);
    expect(() =>
      (pool as unknown as EventEmitter).emit(
        "error",
        new Error("terminating connection due to administrator command"),
      ),
    ).not.toThrow();
  });

  it("returns the same pool for inline wrapping at the call site", () => {
    const pool = new EventEmitter() as unknown as pg.Pool;
    expect(ignorePoolTeardownErrors(pool)).toBe(pool);
  });
});
