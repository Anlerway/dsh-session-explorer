/**
 * dsh-session-navigator — 子智能体的绑定规则 (P32).
 *
 * The module answers three questions, and every one of them is a route's guard:
 *
 *   isBound          — may this session be operated on alone? (never, for a child)
 *   descendantsOf    — which sessions leave with this one? (the whole chain)
 *   withDescendants  — the cascade a bin write actually applies
 *   boundIds         — which of these ids the standalone routes must refuse
 *
 * A fork is the trap in all of them: it carries `parentSession` and is seeded
 * from another session, but it is a session of its own. The tests pin that
 * difference, because reading `parentSession` alone would bind every fork.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { boundIds, descendantsOf, isBound, withDescendants } from "../lib/domain/subagents.js";

const session = (id, extra = {}) => ({ id, isSubagent: false, parentSession: null, ...extra });
const child = (id, parentSession, extra = {}) => session(id, { isSubagent: true, parentSession, ...extra });

test("isBound is the reader's own flag, and a fork is not bound", () => {
  assert.equal(isBound(child("c1", "p1")), true);
  // A fork: seeded, has a parent, is still a session of its own.
  assert.equal(isBound(session("f1", { isSeeded: true, parentSession: "p1" })), false);
  assert.equal(isBound(session("s1")), false);
  assert.equal(isBound(null), false);
  assert.equal(isBound(undefined), false);
  // Only the boolean counts; a truthy string must not bind a row.
  assert.equal(isBound({ id: "c1", isSubagent: "yes" }), false);
});

test("descendantsOf walks the whole chain, parents before children", () => {
  const sessions = [
    session("p1"),
    child("c1", "p1"),
    child("c2", "p1"),
    // A subagent may delegate again: this one is below c1.
    child("g1", "c1"),
    child("g2", "g1"),
    // Somebody else's subtree must not be touched.
    session("p2"),
    child("other", "p2"),
  ];
  assert.deepEqual(descendantsOf(sessions, "p1"), ["c1", "c2", "g1", "g2"]);
  assert.deepEqual(descendantsOf(sessions, "c1"), ["g1", "g2"]);
  // A leaf, an unknown id, and a fork with children: all answer empty.
  assert.deepEqual(descendantsOf(sessions, "g2"), []);
  assert.deepEqual(descendantsOf(sessions, "nope"), []);
  assert.deepEqual(descendantsOf([...sessions, session("f1", { parentSession: "p1" })], "f1"), []);
});

test("descendantsOf survives a cycle in the data instead of hanging", () => {
  // A hand-edited header can point a child at its own descendant. The walk has
  // to terminate: a route that hangs is worse than a route that answers short.
  const sessions = [session("a"), child("b", "a"), child("a", "b")];
  const found = descendantsOf(sessions, "a");
  assert.deepEqual(found, ["b"]);
});

test("withDescendants expands parents, dedupes, and drops unknown ids", () => {
  const sessions = [session("p1"), child("c1", "p1"), child("g1", "c1"), session("p2")];
  // A parent pulls its chain in.
  assert.deepEqual(withDescendants(sessions, ["p1"]), ["p1", "c1", "g1"]);
  // Input order is kept, and a child named twice appears once.
  assert.deepEqual(withDescendants(sessions, ["p2", "p1", "c1"]), ["p2", "p1", "c1", "g1"]);
  // An unknown id cannot be cascaded to, so it is not echoed back.
  assert.deepEqual(withDescendants(sessions, ["nope", "p2"]), ["p2"]);
  assert.deepEqual(withDescendants(sessions, []), []);
});

test("boundIds names only the children, in input order", () => {
  const sessions = [session("p1"), child("c1", "p1"), session("f1", { isSeeded: true, parentSession: "p1" })];
  assert.deepEqual(boundIds(sessions, ["p1", "c1", "f1"]), ["c1"]);
  assert.deepEqual(boundIds(sessions, ["p1", "f1"]), []);
  // An id nobody knows is not a subagent: the caller's own 404 handles it.
  assert.deepEqual(boundIds(sessions, ["nope"]), []);
});
