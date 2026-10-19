/**
 * The merged session view — the one place that decides what a session *is*.
 *
 * The expensive parts (a zstd scan, the projection cache) are not exercised
 * here: this suite feeds the merge function the shapes those readers produce,
 * which is where the classification rules live.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildSessionView, displayTitleOf } from "../lib/domain/sessions.js";

/** @param {object[]} headers */
function viewOf(headers, options = {}) {
  const map = new Map(headers.map((header) => [header.id, normalize(header)]));
  return buildSessionView({
    headers: map,
    projcache: new Map(),
    registry: options.registry ?? null,
    running: options.running ?? new Set(),
    annotations: options.annotations ?? {},
  });
}

function normalize(header) {
  return {
    id: header.id,
    formatVersion: 4,
    createdAt: header.createdAt ?? 1_700_000_000_000,
    cwd: header.cwd ?? "C:\\work",
    isSeeded: header.isSeeded === true,
    delegationDepth: header.delegationDepth ?? 0,
    agentPreset: header.agentPreset ?? null,
    parentSession: header.parentSession ?? null,
    origin: header.origin ?? null,
    logPath: null,
    sizeBytes: 1024,
  };
}

test("a delegation stamped with origin is a subagent", () => {
  const view = viewOf([
    { id: "p" },
    { id: "c", origin: "subagent", delegationDepth: 1, parentSession: "p" },
  ]);
  const child = view.sessions.find((session) => session.id === "c");
  assert.equal(child.isSubagent, true);
  assert.equal(child.delegationDepth, 1);
});

test("a depth-only delegation is a subagent too", () => {
  // dsh-subagent stamps origin; the in-process team path only persists
  // delegationDepth. Keying on origin alone listed those children as ordinary
  // sessions, which is the "子智能体识别失败" bug.
  const view = viewOf([
    { id: "p" },
    { id: "c", delegationDepth: 2, parentSession: "p" },
  ]);
  const child = view.sessions.find((session) => session.id === "c");
  assert.equal(child.isSubagent, true);
});

test("a fork is not a subagent", () => {
  // A fork carries parentSession and isSeeded but stays depth 0: it is an
  // independent conversation and must remain a sibling of its source.
  const view = viewOf([
    { id: "p" },
    { id: "f", parentSession: "p", isSeeded: true },
  ]);
  const fork = view.sessions.find((session) => session.id === "f");
  assert.equal(fork.isSubagent, false);
  assert.equal(fork.parentSession, "p");
  assert.equal(fork.isSeeded, true);
});

test("a parent link is dropped when the parent is not listed", () => {
  // Otherwise the row renders a 子 badge with nothing to nest under.
  const view = viewOf([{ id: "c", origin: "subagent", delegationDepth: 1, parentSession: "gone" }]);
  const child = view.sessions.find((session) => session.id === "c");
  assert.equal(child.parentSession, null);
  assert.equal(child.isSubagent, true, "the row is still a delegation");
});

test("the registry decides the workspace, not the projection cache", () => {
  const registry = {
    workspaceIds: ["w1"],
    workspaces: new Map([["w1", { id: "w1", title: "project", path: "C:\\p", sessionIds: ["s1"] }]]),
    archivedSessionIds: [],
    pinnedSessionIds: [],
    defaultWorkspaceId: "w1",
  };
  const view = viewOf([{ id: "s1" }, { id: "s2" }], { registry });
  assert.equal(view.sessions.find((s) => s.id === "s1").workspaceTitle, "project");
  assert.equal(view.sessions.find((s) => s.id === "s2").workspaceId, null);
});

test("displayTitle falls back to the cwd folder name", () => {
  assert.equal(displayTitleOf({ title: "real title", cwd: "C:\\x", id: "s" }), "real title");
  assert.equal(displayTitleOf({ title: "", cwd: "C:\\work\\proj", id: "s" }), "proj");
});
