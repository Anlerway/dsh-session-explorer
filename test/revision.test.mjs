/**
 * The optimistic lock, both ends of it.
 *
 * The sidecar has always had a revision guard (`test/store.test.mjs` proves a
 * stale write is refused), and the panel has always *handled* `revision-conflict`
 * by reloading — but no client ever sent a revision, so the guard only ever
 * fired for the host's own retries. It was a lock nobody turned the key in.
 *
 * These tests pin the two halves that were missing:
 *
 *   - the client cites the revision of the store it is writing to (`If-Match`),
 *     and adopts the one the write returns;
 *   - the host reads that header back, and answers a mismatch with 409.
 *
 *   node --test test/revision.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { expectedRevision, statusFor } from "../lib/index.js";
import { loadClientBundle, recordingFetch } from "./support/client-bundle.mjs";

// ── host: what a request expects ────────────────────────────────────────────

test("a request states its expectation as a quoted If-Match, or as a body field", () => {
  assert.equal(expectedRevision({ headers: { "if-match": '"7"' } }), 7);
  assert.equal(expectedRevision({ headers: { "if-match": "7" } }), 7, "quotes are optional");
  assert.equal(expectedRevision({ headers: { "if-match": '  "12"  ' } }), 12);
  assert.equal(expectedRevision({ headers: {}, body: { revision: 4 } }), 4);
  // The header is the authoritative form when both are present.
  assert.equal(expectedRevision({ headers: { "if-match": '"9"' }, body: { revision: 4 } }), 9);
});

test("no statement of intent means last writer wins, not a rejection", () => {
  // A single-window user has nothing to state, and `undefined` is what the
  // sidecar reads as "no guard".
  assert.equal(expectedRevision({ headers: {} }), undefined);
  assert.equal(expectedRevision({}), undefined);
  assert.equal(expectedRevision({ headers: { "if-match": '""' } }), undefined, "an empty tag states nothing");
  assert.equal(expectedRevision({ headers: { "if-match": '"   "' } }), undefined);
});

test("a weak validator still states the revision it names", () => {
  // `W/"5"` says "the version I hold is 5", weakly. Dropping the prefix and
  // reading 5 is what keeps a proxy that weakens tags from silently turning a
  // guarded write into a last-writer-wins one.
  assert.equal(expectedRevision({ headers: { "if-match": 'W/"5"' } }), 5);
  assert.equal(expectedRevision({ headers: { "if-match": '  w/"12" ' } }), 12);
});

test("revision 0 is a real revision, not an absent one", () => {
  // A sidecar starts at 0, so refusing 0 would silently unguard the first write
  // ever made to a fresh data directory.
  assert.equal(expectedRevision({ headers: { "if-match": '"0"' } }), 0);
});

test("a header that is not a revision is a 400, not an unguarded write", () => {
  // Falling back to the body (or to nothing) would turn a broken client into a
  // client that overwrites whatever it finds.
  assert.throws(() => expectedRevision({ headers: { "if-match": '"abc"' }, body: { revision: 6 } }), (error) => error.code === "bad-request");
  // A tag that names a revision and then some other revision is unparseable too.
  assert.throws(() => expectedRevision({ headers: { "if-match": '"1", "2"' } }), (error) => error.code === "bad-request");
  // `*` is not a revision but it is a legitimate statement ("it exists"), so it
  // falls through to the body rather than becoming an error.
  assert.equal(expectedRevision({ headers: { "if-match": "*" }, body: { revision: 6 } }), 6);
});

test("a conflict is a 409, so the client can tell it from a bad request", () => {
  assert.equal(statusFor("revision-conflict"), 409);
  assert.equal(statusFor("bad-request"), 400);
});

// ── client: citing the revision, and adopting the new one ───────────────────

/**
 * Load the bundle with a fetch under the test's control.
 *
 * @param {(call: any) => any} [respond]
 */
function clientWith(respond) {
  const fetchImpl = recordingFetch(respond);
  const { test: api } = loadClientBundle({
    fetch: fetchImpl,
    expose: ["apiGet", "apiSend", "storeOf", "revisions"],
  });
  return { api, calls: fetchImpl.calls };
}

const conflict = () => ({
  status: 409,
  ok: false,
  code: "revision-conflict",
  error: "tree.json is at revision 8, request expected 7",
});

test("a write cites the revision of the store it touches", async () => {
  const { api, calls } = clientWith(() => ({ ok: true, result: { revision: 8 } }));
  api.revisions.tree = 7;

  await api.apiSend("POST", "/nodes/d-1/move", { parent: "f-root" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "/session-explorer/api/nodes/d-1/move");
  assert.equal(calls[0].headers["if-match"], '"7"', 'the header is a quoted entity tag');
  assert.deepEqual(calls[0].body, { parent: "f-root" });
  assert.equal(api.revisions.tree, 8, "the write's own answer is adopted");
});

test("the three stores do not lend each other their revisions", async () => {
  const { api, calls } = clientWith((call) => ({
    ok: true,
    result: { revision: call.url.startsWith("/session-explorer/api/settings") ? 2 : 11 },
  }));
  api.revisions.tree = 7;
  api.revisions.annotations = 3;
  api.revisions.settings = 1;

  await api.apiSend("PUT", "/settings", { theme: "dark" });
  await api.apiSend("PUT", "/annotations/s-1", { favorite: true });
  await api.apiSend("POST", "/move", { ids: ["s-1"] });

  assert.equal(calls[0].headers["if-match"], '"1"');
  assert.equal(calls[1].headers["if-match"], '"3"');
  assert.equal(calls[2].headers["if-match"], '"7"');
  assert.equal(api.revisions.settings, 2);
  assert.equal(api.revisions.annotations, 11);
  assert.equal(api.revisions.tree, 11, "each answer updates only its own store");
});

test("a store with no revision yet sends no header, so a lone window still works", async () => {
  const { api, calls } = clientWith(() => ({ ok: true, result: {} }));

  await api.apiSend("POST", "/nodes/d-1/move", { parent: "f-root" });

  assert.ok(!("if-match" in calls[0].headers), "no invented revision");
  assert.equal(api.revisions.tree, null, "nothing to adopt");
});

test("a migration is never refused for a stale tree revision", async () => {
  // The data directory move rewrites every sidecar; citing a tree revision it
  // is about to invalidate would make the one operation that must always work
  // start failing after any unrelated edit.
  const { api, calls } = clientWith(() => ({ ok: true, result: { moved: 12 } }));
  api.revisions.tree = 7;

  await api.apiSend("POST", "/datadir/migrate", { target: "D:/dsh" });

  assert.equal(api.storeOf("/datadir/migrate"), null);
  assert.ok(!("if-match" in calls[0].headers));
});

test("a conflict surfaces with its code, and does not move the cited revision", async () => {
  const { api } = clientWith(conflict);
  api.revisions.tree = 7;

  await assert.rejects(
    () => api.apiSend("POST", "/nodes/d-1/move", { parent: "f-root" }),
    (error) => {
      assert.equal(error.code, "revision-conflict");
      assert.match(error.message, /at revision 8, request expected 7/);
      return true;
    },
  );
  // The panel finds out it is stale from the reload that follows; inventing a
  // new number here would hide the conflict from the next write too.
  assert.equal(api.revisions.tree, 7);
});

test("a route is mapped to its store, and unknown paths fall to the tree", async () => {
  const { api } = clientWith();
  assert.equal(api.storeOf("/settings"), "settings");
  assert.equal(api.storeOf("/settings/reset"), "settings");
  assert.equal(api.storeOf("/tags"), "annotations");
  assert.equal(api.storeOf("/tags/工作"), "annotations");
  assert.equal(api.storeOf("/annotations/s-1"), "annotations");
  assert.equal(api.storeOf("/datadir/migrate"), null);
  assert.equal(api.storeOf("/nodes/d-1/move"), "tree");
  assert.equal(api.storeOf("/sessions/placement"), "tree");
  assert.equal(api.storeOf("/folders"), "tree");
  assert.equal(api.storeOf("/shortcuts"), "tree");
});
