/**
 * Tests for the one-session state DSH's own surfaces read.
 *
 *   node --test test/session-state.test.mjs
 *
 * The interesting part is not the three booleans but where each comes from and
 * what "trashed" means: two layers can each say it, and only one of them holds
 * the payload.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { sessionStateOf } from "../lib/domain/session-state.js";

const annotations = (sessions) => ({ sessions });
const trash = (entries) => ({ entries });

test("a live session with no annotations reads as all-false", () => {
  const state = sessionStateOf(
    { annotations: annotations({}), trash: trash({}), sessions: [{ id: "session-1" }] },
    "session-1",
  );
  assert.deepEqual(state, { id: "session-1", favorite: false, todo: false, archived: false, trashed: false, subagent: false });
});

test("the two annotation flags come from the entry, and only a real true counts", () => {
  const state = sessionStateOf(
    {
      annotations: annotations({
        "session-1": { favorite: true, todo: "yes" },
        "session-2": { favorite: "true", todo: true },
      }),
      trash: trash({}),
      sessions: [{ id: "session-1" }, { id: "session-2" }],
    },
    "session-1",
  );
  assert.equal(state.favorite, true, "favorite: true is a favorite");
  assert.equal(state.todo, false, "a truthy string is not the flag");
  assert.equal(
    sessionStateOf({ annotations: annotations({ "session-2": { favorite: "true" } }), trash: trash({}), sessions: [] }, "session-2")
      .favorite,
    false,
    'the string "true" must not read as a favorite',
  );
});

test("archived is what the reader says about the session", () => {
  const documents = { annotations: annotations({}), trash: trash({}), sessions: [{ id: "session-1", archived: true }] };
  assert.equal(sessionStateOf(documents, "session-1").archived, true);
  assert.equal(
    sessionStateOf({ ...documents, sessions: [{ id: "session-1", archived: "yes" }] }, "session-1").archived,
    false,
    "only a boolean true archives",
  );
});

test("either layer can say trashed, and neither one alone can be ignored", () => {
  // The bin holds the payload: a session whose reader row is already gone still
  // reads as trashed while a restore settles.
  const inBin = { annotations: annotations({}), trash: trash({ "session-1": { path: "x" } }), sessions: [] };
  assert.equal(sessionStateOf(inBin, "session-1").trashed, true);
  // And the reader can report it before the bin document is written.
  const reported = { annotations: annotations({}), trash: trash({}), sessions: [{ id: "session-1", trashed: true }] };
  assert.equal(sessionStateOf(reported, "session-1").trashed, true);
  // A bin entry for somebody else must not leak.
  const other = { annotations: annotations({}), trash: trash({ "session-2": {} }), sessions: [{ id: "session-1" }] };
  assert.equal(sessionStateOf(other, "session-1").trashed, false);
});

test("an unknown session answers all-false rather than throwing", () => {
  assert.deepEqual(sessionStateOf({ annotations: null, trash: null, sessions: null }, "nope"), {
    id: "nope",
    favorite: false,
    todo: false,
    archived: false,
    trashed: false,
    subagent: false,
  });
});

test("subagent is the reader's own flag, and a fork is not one", () => {
  // The header menu hides 收藏/待办/归档/删除 behind this one bit, so it has to
  // come from the reader (which knows origin/delegationDepth), never from
  // `parentSession` — a fork also carries a parent and is a session of its own.
  const documents = {
    annotations: annotations({}),
    trash: trash({}),
    sessions: [
      { id: "child", isSubagent: true },
      { id: "fork", isSubagent: false, isSeeded: true, parentSession: "session-1" },
    ],
  };
  assert.equal(sessionStateOf(documents, "child").subagent, true);
  assert.equal(sessionStateOf(documents, "fork").subagent, false);
  // A truthy non-boolean is not the flag.
  const loose = { ...documents, sessions: [{ id: "child", isSubagent: "yes" }] };
  assert.equal(sessionStateOf(loose, "child").subagent, false);
});
