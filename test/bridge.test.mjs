/**
 * Tests for lib/host/bridge.js — the panel ↔ detached-window command bus.
 *
 * The bridge is small enough that its value is entirely in its edge cases: a
 * consumer that missed commands, a command that went stale, a listener that
 * throws, an unknown kind from a newer window. Those are what this file pins.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createBridge, normalizeCommand, WINDOW_COMMANDS } from "../lib/host/bridge.js";

test("publish assigns increasing sequence numbers and hands the command to listeners", () => {
  const bridge = createBridge();
  const seen = [];
  const unsubscribe = bridge.subscribe((command) => seen.push(command));

  bridge.publish("open-session", { sessionId: "s1" });
  bridge.publish("new-session", { workspaceId: "w1" });
  unsubscribe();
  bridge.publish("open-session", { sessionId: "s2" });

  assert.equal(seen.length, 2, "the unsubscribed listener saw nothing more");
  assert.deepEqual(seen.map((command) => command.seq), [1, 2]);
  assert.equal(seen[0].kind, "open-session");
  assert.deepEqual(seen[0].payload, { sessionId: "s1" });
  assert.equal(bridge.cursor, 3, "the cursor keeps counting after an unsubscribe");
});

test("since returns only what the consumer has not seen", () => {
  const bridge = createBridge();
  bridge.publish("open-session", { sessionId: "a" });
  bridge.publish("open-session", { sessionId: "b" });
  bridge.publish("open-session", { sessionId: "c" });

  assert.deepEqual(bridge.since(0).map((command) => command.seq), [1, 2, 3]);
  assert.deepEqual(bridge.since(2).map((command) => command.seq), [3]);
  assert.deepEqual(bridge.since(99), [], "a cursor ahead of the bus yields nothing");
});

test("the ring buffer drops the oldest commands but keeps the numbers", () => {
  const bridge = createBridge({ capacity: 3 });
  for (let index = 0; index < 6; index += 1) bridge.publish("refresh", { index });

  const kept = bridge.since(0);
  assert.equal(kept.length, 3, "only the capacity survives");
  assert.deepEqual(kept.map((command) => command.seq), [4, 5, 6]);
  assert.equal(bridge.size, 3);
});

test("a command older than the window is not replayed", () => {
  let clock = 1_000;
  const bridge = createBridge({ now: () => clock });
  bridge.publish("open-session", { sessionId: "old" });
  clock += 60_000;
  bridge.publish("open-session", { sessionId: "fresh" });

  const live = bridge.since(0);
  assert.equal(live.length, 1, "the stale command is gone");
  assert.equal(live[0].payload.sessionId, "fresh");
});

test("a listener that throws does not starve the others", () => {
  const bridge = createBridge();
  const seen = [];
  bridge.subscribe(() => {
    throw new Error("boom");
  });
  bridge.subscribe((command) => seen.push(command.kind));

  assert.doesNotThrow(() => bridge.publish("reveal", {}));
  assert.deepEqual(seen, ["reveal"]);
});

test("clear() empties the buffer and restarts the numbering", () => {
  const bridge = createBridge();
  bridge.publish("refresh", {});
  bridge.clear();
  assert.equal(bridge.size, 0);
  assert.equal(bridge.cursor, 0);
  assert.deepEqual(bridge.since(0), []);
});

test("normalizeCommand accepts the window's kinds and refuses the rest", () => {
  assert.deepEqual(normalizeCommand({ kind: "open-session", payload: { sessionId: "s1" } }), {
    kind: "open-session",
    payload: { sessionId: "s1" },
  });

  for (const kind of WINDOW_COMMANDS) {
    assert.doesNotThrow(() => normalizeCommand({ kind }), kind + " is allowed");
  }
  for (const kind of ["", "delete-everything", "open-session; rm -rf /", null]) {
    assert.throws(() => normalizeCommand({ kind }), /unsupported bridge command/, String(kind));
  }
});

test("open-settings is navigation: allowed from the window and carrying no payload", () => {
  // 更多设置… in the detached window is a request to the DSH page, so the window
  // has to be allowed to send it — and it names nothing, so nothing is filtered.
  assert.deepEqual(normalizeCommand({ kind: "open-settings" }), { kind: "open-settings", payload: {} });
  assert.deepEqual(normalizeCommand({ kind: "open-settings", payload: { shell: "/bin/sh" } }), {
    kind: "open-settings",
    payload: {},
  });
});

test("normalizeCommand keeps only the known payload fields, and clips them", () => {
  const long = "x".repeat(500);
  const { payload } = normalizeCommand({
    kind: "open-session",
    payload: { sessionId: long, workspaceId: "w1", scope: "f-root", evil: "<script>", ids: ["a"] },
  });

  assert.equal(payload.sessionId.length, 200, "a payload field is clipped");
  assert.equal(payload.workspaceId, "w1");
  assert.equal(payload.scope, "f-root");
  assert.ok(!("evil" in payload), "unknown fields are dropped");
  assert.ok(!("ids" in payload), "arrays are dropped");
});

test("normalizeCommand tolerates a missing or non-object payload", () => {
  assert.deepEqual(normalizeCommand({ kind: "refresh" }), { kind: "refresh", payload: {} });
  assert.deepEqual(normalizeCommand({ kind: "refresh", payload: "nope" }), { kind: "refresh", payload: {} });
  assert.deepEqual(normalizeCommand({ kind: "refresh", payload: { sessionId: 42 } }), { kind: "refresh", payload: {} });
});

test("a full bus refuses a new listener instead of growing without bound", () => {
  const bridge = createBridge();
  /** @type {Array<() => void>} */
  const stops = [];
  for (let index = 0; index < 32; index += 1) stops.push(bridge.subscribe(() => {}));
  assert.equal(bridge.listeners, 32);
  assert.equal(bridge.subscribe(() => {}), null, "the ceiling is a refusal, not a silent drop");

  // A listener that goes away frees its slot, so the panel reconnecting after a
  // closed tab is not locked out by the connections it left behind.
  stops[0]();
  assert.equal(bridge.listeners, 31);
  const stop = bridge.subscribe(() => {});
  assert.equal(typeof stop, "function");
  assert.equal(bridge.listeners, 32);
});
