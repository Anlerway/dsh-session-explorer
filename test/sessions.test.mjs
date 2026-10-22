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

/**
 * One workspace, one ordinary session in it, and whatever children a test adds.
 *
 * DSH's registry lists only sessions a user opened from a workspace, which is
 * exactly why a delegated child is missing from `sessionIds` here.
 */
function registryOf(extra = {}) {
  return {
    workspaceIds: ["w1"],
    workspaces: new Map([
      ["w1", { id: "w1", title: "project", path: "C:\\p", sessionIds: ["p"] }],
    ]),
    archivedSessionIds: [],
    pinnedSessionIds: [],
    defaultWorkspaceId: "w1",
    ...extra,
  };
}

test("a subagent inherits its parent's workspace instead of 未分组", () => {
  // The bug (m00002 ①): a delegated child is created by its parent and never
  // appears in workspace.sessionIds, so it used to reach placementOfNode with
  // workspaceId null and was filed under 未分组 while its parent sat in w1.
  const view = viewOf(
    [
      { id: "p", cwd: "C:\\p" },
      { id: "c", origin: "subagent", delegationDepth: 1, parentSession: "p", cwd: "C:\\p" },
    ],
    { registry: registryOf() },
  );
  const child = view.sessions.find((s) => s.id === "c");
  assert.equal(child.isSubagent, true);
  assert.equal(child.workspaceId, "w1");
  assert.equal(child.workspaceTitle, "project");
});

test("workspace inheritance follows a whole delegation chain", () => {
  // A subagent may delegate again; the grandchild is not in the registry either,
  // so one hop would leave it ungrouped.
  const view = viewOf(
    [
      { id: "p", cwd: "C:\\p" },
      { id: "c", delegationDepth: 1, parentSession: "p", cwd: "C:\\p" },
      { id: "g", delegationDepth: 2, parentSession: "c", cwd: "C:\\p" },
    ],
    { registry: registryOf() },
  );
  assert.equal(view.sessions.find((s) => s.id === "g").workspaceId, "w1");
});

test("an orphaned subagent falls back to an exact cwd match", () => {
  // Its parent is not listed, so the parent link is pruned; the cwd is still the
  // workspace path, which is the same witness DSH uses for the workspace.
  const view = viewOf(
    [{ id: "c", origin: "subagent", delegationDepth: 1, parentSession: "gone", cwd: "C:\\p\\" }],
    { registry: registryOf() },
  );
  const child = view.sessions.find((s) => s.id === "c");
  assert.equal(child.parentSession, null);
  assert.equal(child.workspaceId, "w1");
});

test("a subagent whose parent and cwd are both unknown stays unplaced", () => {
  const view = viewOf(
    [{ id: "c", origin: "subagent", delegationDepth: 1, parentSession: "gone", cwd: "C:\\elsewhere" }],
    { registry: registryOf() },
  );
  assert.equal(view.sessions.find((s) => s.id === "c").workspaceId, null);
});

test("a fork is not dragged into its source's workspace", () => {
  // Forks are siblings, not delegations; only subagents inherit.
  const view = viewOf(
    [
      { id: "p", cwd: "C:\\p" },
      { id: "f", parentSession: "p", isSeeded: true, cwd: "C:\\other" },
    ],
    { registry: registryOf() },
  );
  assert.equal(view.sessions.find((s) => s.id === "f").workspaceId, null);
});

test("displayTitle falls back to the cwd folder name", () => {
  assert.equal(displayTitleOf({ title: "real title", cwd: "C:\\x", id: "s" }), "real title");
  assert.equal(displayTitleOf({ title: "", cwd: "C:\\work\\proj", id: "s" }), "proj");
});
